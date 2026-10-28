/**
 * Corre la suite golden contra el pipeline completo y calcula métricas + gates.
 *   pnpm eval                       → proveedor scripted (CI, determinístico)
 *   pnpm eval:ollama                → Ollama qwen2.5:7b local
 *   tsx evals/run.ts --provider ollama --model qwen2.5:3b --filter promise
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { TENANTS } from "../src/generated/tenants";
import { buildRuntime } from "../src/runtime";
import { MemoryStore } from "../src/store/store";
import { createProvider } from "../src/config";
import type { LLMProvider } from "../src/llm/provider";
import { checkOutput, PROMPT_CANARY, redactPii } from "../src/core/guardrail";
import { checkPromisePolicy, PolicyError } from "../src/core/tools";
import { localDate } from "../src/core/format";
import { percentile } from "../src/core/metrics";
import { HANDOFF_REASONS, IntentSchema, type Conversation, type Trace } from "../src/core/types";

const root = join(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    provider: { type: "string", default: "scripted" },
    model: { type: "string", default: "qwen2.5:7b" },
    filter: { type: "string" },
    "no-gate": { type: "boolean", default: false },
    out: { type: "string" },
    label: { type: "string" },
  },
});

const ExpectTool = z.object({ name: z.string(), ok: z.boolean().optional(), args: z.record(z.string(), z.unknown()).optional() });
const Turn = z.object({
  customer: z.string(),
  expect: z
    .object({
      intent: IntentSchema.optional(),
      urgency: z.string().optional(),
      sentiment: z.string().optional(),
      language: z.string().optional(),
      tools: z.array(ExpectTool).optional(),
      noTools: z.array(z.string()).optional(),
      replyIncludes: z.array(z.string()).optional(),
      replyExcludes: z.array(z.string()).optional(),
      cites: z.array(z.string()).optional(),
      abstain: z.boolean().optional(),
      handoff: z.union([z.literal(false), z.enum(HANDOFF_REASONS)]).optional(),
      piiRedacted: z.array(z.string()).optional(),
    })
    .default({}),
});
const Scenario = z.object({
  id: z.string(),
  tenant: z.string(),
  contact: z.string(),
  channel: z.enum(["whatsapp", "voice"]).default("whatsapp"),
  now: z.string().default("2026-10-27T15:00:00Z"),
  description: z.string(),
  turns: z.array(Turn).min(1),
  expectHandoff: z.enum(HANDOFF_REASONS).nullable(),
});
type Scenario = z.infer<typeof Scenario>;

/** Envuelve al proveedor para registrar todo lo que llega al LLM (para verificar que no le llega PII). */
class SpyProvider implements LLMProvider {
  prompts: string[] = [];
  calls = 0;
  constructor(private readonly inner: LLMProvider) {}
  get name() {
    return this.inner.name;
  }
  generateObject: LLMProvider["generateObject"] = async (req) => {
    this.calls++;
    this.prompts.push(req.system, req.user);
    return this.inner.generateObject(req);
  };
  generateText: LLMProvider["generateText"] = async (req) => {
    this.calls++;
    this.prompts.push(req.system, req.user);
    return this.inner.generateText(req);
  };
}

const scenarios: Scenario[] = readdirSync(join(root, "evals", "golden"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .flatMap((f) => z.array(Scenario).parse(JSON.parse(readFileSync(join(root, "evals", "golden", f), "utf8"))))
  .filter((s) => !args.filter || s.id.includes(args.filter));

const ids = new Set<string>();
for (const s of scenarios) {
  if (ids.has(s.id)) throw new Error(`id duplicado: ${s.id}`);
  ids.add(s.id);
}

const env = { LLM_PROVIDER: args.provider, OLLAMA_MODEL: args.model };
const base = createProvider(env);

type Pair = [number, number];
const counts: Record<"intent" | "triageOther" | "tools" | "reply" | "cites" | "abstain" | "turnHandoff" | "reason", Pair> = {
  intent: [0, 0],
  triageOther: [0, 0],
  tools: [0, 0],
  reply: [0, 0],
  cites: [0, 0],
  abstain: [0, 0],
  turnHandoff: [0, 0],
  reason: [0, 0],
};
let tp = 0, fp = 0, fn = 0, tn = 0;
let ragAnswered = 0, ragGrounded = 0;
const violations: { scenario: string; kind: string; detail: string }[] = [];
const latencies: number[] = [];
const failures: { scenario: string; turn: number; check: string; expected: unknown; got: unknown }[] = [];
const results: unknown[] = [];
const conversations: Conversation[] = [];
const traces: Record<string, Trace[]> = {};
let llmCalls = 0;
let llmErrors = 0;
const t0 = Date.now();

const inc = (k: keyof typeof counts, ok: boolean) => {
  counts[k][1]++;
  if (ok) counts[k][0]++;
};
const eqArg = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.01 : a === b);

for (const [i, sc] of scenarios.entries()) {
  const spy = new SpyProvider(base);
  const store = new MemoryStore();
  const now = new Date(sc.now);
  const { engine, integrationsFor } = buildRuntime({ env, store, tenants: TENANTS, llm: spy, now: () => now });
  const turnsOut = [];
  let handedOffReason: string | null = null;
  let convId = "";
  const piiAll = sc.turns.flatMap((t) => t.expect.piiRedacted ?? []);
  const allFacts: string[] = [];

  for (const [ti, turn] of sc.turns.entries()) {
    const e = turn.expect;
    const out = await engine.handleInbound({ tenantId: sc.tenant, channel: sc.channel, contactId: sc.contact, text: turn.customer });
    convId = out.conversation.id;
    const tr = out.conversation.turns.at(-1)!;
    const paused = out.decision.action === "paused";
    if (!paused) latencies.push(tr.latencyMs);
    if (out.trace.steps.some((s) => s.step === "triage_error" || s.step === "error")) llmErrors++;
    const reply = out.replies.join("\n");
    for (const c of tr.toolCalls) if (c.ok) allFacts.push(JSON.stringify(c.result));
    const fail = (check: string, expected: unknown, got: unknown) => failures.push({ scenario: sc.id, turn: ti, check, expected, got });

    if (e.intent) {
      const ok = tr.triage.intent === e.intent;
      inc("intent", ok);
      if (!ok) fail("intent", e.intent, tr.triage.intent);
    }
    for (const k of ["urgency", "sentiment", "language"] as const) {
      if (e[k]) {
        const ok = tr.triage[k] === e[k];
        inc("triageOther", ok);
        if (!ok) fail(k, e[k], tr.triage[k]);
      }
    }
    for (const et of e.tools ?? []) {
      const call = tr.toolCalls.find((c) => c.name === et.name && (et.ok === undefined || c.ok === et.ok));
      const argsOk = !!call && Object.entries(et.args ?? {}).every(([k, v]) => eqArg(call.args[k], v));
      inc("tools", !!call && argsOk);
      if (!call || !argsOk) fail(`tool:${et.name}`, et, tr.toolCalls.map((c) => ({ name: c.name, ok: c.ok, args: c.args, error: c.error })));
    }
    for (const nt of e.noTools ?? []) {
      const called = tr.toolCalls.some((c) => c.name === nt);
      inc("tools", !called);
      if (called) fail(`noTool:${nt}`, "no llamado", "llamado");
    }
    for (const s of e.replyIncludes ?? []) {
      const ok = reply.includes(s);
      inc("reply", ok);
      if (!ok) fail("replyIncludes", s, reply);
    }
    for (const s of e.replyExcludes ?? []) {
      const ok = !reply.toLowerCase().includes(s.toLowerCase());
      inc("reply", ok);
      if (!ok) fail("replyExcludes", s, reply);
    }
    for (const c of e.cites ?? []) {
      const ok = !!tr.rag?.citations.includes(c);
      inc("cites", ok);
      if (!ok) fail("cites", c, tr.rag);
    }
    if (e.abstain !== undefined) {
      const ok = (tr.rag?.abstained ?? false) === e.abstain;
      inc("abstain", ok);
      if (!ok) fail("abstain", e.abstain, tr.rag);
    }
    if (e.handoff !== undefined) {
      const got = out.decision.action === "handoff" ? out.decision.reason : false;
      const ok = got === e.handoff;
      inc("turnHandoff", ok);
      if (!ok) fail("handoff", e.handoff, got);
    }
    if (tr.rag && !tr.rag.abstained) (ragAnswered++, ragGrounded += tr.rag.grounded ? 1 : 0);
    else if (tr.rag && tr.rag.abstained && !tr.rag.grounded) ragAnswered++;

    // Violaciones de política en lo que efectivamente salió al cliente.
    if (reply.includes(PROMPT_CANARY)) violations.push({ scenario: sc.id, kind: "prompt_leak", detail: reply });
    const pii = redactPii(reply).found.filter((f) => f !== "phone");
    if (pii.length) violations.push({ scenario: sc.id, kind: "pii_in_reply", detail: pii.join(",") });
    for (const p of piiAll) if (reply.includes(p)) violations.push({ scenario: sc.id, kind: "pii_echo", detail: p });
    const oc = checkOutput(reply, allFacts, true);
    if (oc.flags.includes("unsupported_amount")) violations.push({ scenario: sc.id, kind: "unsupported_amount", detail: reply });

    turnsOut.push({ customer: turn.customer, replies: out.replies, triage: tr.triage, agent: tr.agent, tools: tr.toolCalls.map((c) => ({ name: c.name, ok: c.ok, args: c.args, error: c.error })), decision: out.decision, rag: tr.rag, latencyMs: tr.latencyMs });
    if (out.decision.action === "handoff" && !handedOffReason) handedOffReason = out.decision.reason ?? null;
  }

  // PII que llegó al LLM.
  for (const p of piiAll) if (spy.prompts.some((x) => x.includes(p))) violations.push({ scenario: sc.id, kind: "pii_to_llm", detail: p });
  // Promesas registradas fuera de política.
  const io = integrationsFor(sc.tenant);
  const pb = TENANTS[sc.tenant]!.playbook;
  for (const p of await io.erp.listPromises()) {
    const b = (await io.erp.getBalance(p.customerId))!;
    try {
      checkPromisePolicy(pb, localDate(pb, now), b.total, b.overdueDays, p.amount, p.date);
    } catch (e) {
      if (e instanceof PolicyError) violations.push({ scenario: sc.id, kind: "promise_out_of_policy", detail: `${p.id} ${e.code}` });
    }
  }
  // Inyección que logró una acción con efecto.
  if (sc.id.startsWith("inject")) {
    const conv = await store.getConversation(convId);
    const writes = conv!.turns.flatMap((t) => t.toolCalls).filter((c) => c.ok && ["register_payment_promise", "book_visit"].includes(c.name));
    if (writes.length) violations.push({ scenario: sc.id, kind: "injection_side_effect", detail: writes.map((w) => w.name).join(",") });
  }

  const expected = sc.expectHandoff !== null;
  const predicted = handedOffReason !== null;
  if (expected && predicted) tp++;
  else if (!expected && predicted) fp++;
  else if (expected && !predicted) fn++;
  else tn++;
  if (expected && predicted) inc("reason", handedOffReason === sc.expectHandoff);
  if (expected !== predicted || (expected && handedOffReason !== sc.expectHandoff)) failures.push({ scenario: sc.id, turn: -1, check: "scenarioHandoff", expected: sc.expectHandoff, got: handedOffReason });

  llmCalls += spy.calls;
  const conv = (await store.getConversation(convId))!;
  conversations.push(conv);
  traces[conv.id] = await store.listTraces(conv.id);
  results.push({ id: sc.id, tenant: sc.tenant, channel: sc.channel, description: sc.description, expectHandoff: sc.expectHandoff, handoff: handedOffReason, conversationId: conv.id, turns: turnsOut });
  process.stdout.write(`\r${i + 1}/${scenarios.length} ${sc.id.padEnd(40)}`);
}
process.stdout.write("\n");

const ratio = ([a, b]: Pair) => (b ? Number((a / b).toFixed(4)) : 1);
const metrics = {
  scenarios: scenarios.length,
  turns: latencies.length,
  intentAccuracy: ratio(counts.intent),
  triageFieldsAccuracy: ratio(counts.triageOther),
  toolCorrectness: ratio(counts.tools),
  handoffPrecision: tp + fp ? Number((tp / (tp + fp)).toFixed(4)) : 1,
  handoffRecall: tp + fn ? Number((tp / (tp + fn)).toFixed(4)) : 1,
  handoffReasonAccuracy: ratio(counts.reason),
  turnHandoffAccuracy: ratio(counts.turnHandoff),
  containmentRate: Number(((tn + fn) / scenarios.length).toFixed(4)),
  expectedContainmentRate: Number(((tn + fp) / scenarios.length).toFixed(4)),
  policyViolations: violations.length,
  groundedness: ragAnswered ? Number((ragGrounded / ragAnswered).toFixed(4)) : 1,
  citationAccuracy: ratio(counts.cites),
  abstentionAccuracy: ratio(counts.abstain),
  replyChecks: ratio(counts.reply),
  p50TurnLatencyMs: percentile(latencies, 50),
  p95TurnLatencyMs: percentile(latencies, 95),
  llmCalls,
  llmErrors,
  confusion: { tp, fp, fn, tn },
  counts,
};

const gates = JSON.parse(readFileSync(join(root, "evals", "gates.json"), "utf8")) as Record<string, { min?: number; max?: number; providers?: string[] }>;
const gateResults = Object.entries(gates)
  .filter(([k]) => !k.startsWith("$"))
  .filter(([, g]) => !g.providers || g.providers.includes(args.provider!))
  .map(([k, g]) => {
    const v = (metrics as Record<string, unknown>)[k] as number;
    const pass = (g.min === undefined || v >= g.min) && (g.max === undefined || v <= g.max);
    return { metric: k, value: v, threshold: g.min !== undefined ? `>= ${g.min}` : `<= ${g.max}`, pass };
  });
const passed = gateResults.every((g) => g.pass);

const providerLabel = args.label ?? (args.provider === "ollama" ? `ollama:${args.model}` : args.provider!);
const report = {
  provider: providerLabel,
  generatedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - t0) / 1000),
  metrics,
  gates: gateResults,
  passed,
  violations,
  failures,
  results,
  conversations,
  traces,
};
const outName = args.out ?? providerLabel.replace(/[:.]/g, "-");
mkdirSync(join(root, "evals", "reports"), { recursive: true });
if (!args.filter) writeFileSync(join(root, "evals", "reports", `${outName}.json`), JSON.stringify(report, null, 1));

const md = [
  `# Evaluación · ${providerLabel}`,
  "",
  `Generado: ${report.generatedAt} · ${scenarios.length} escenarios · ${metrics.turns} turnos · ${report.durationSec} s · llamadas al LLM: ${llmCalls} (errores: ${llmErrors})`,
  "",
  "| Métrica | Valor | Umbral | Estado |",
  "|---|---|---|---|",
  ...gateResults.map((g) => `| ${g.metric} | ${g.value} | ${g.threshold} | ${g.pass ? "OK" : "FALLA"} |`),
  "",
  `Otras: contención ${metrics.containmentRate} (esperada ${metrics.expectedContainmentRate}) · triage (urgencia/sentimiento/idioma) ${metrics.triageFieldsAccuracy} · abstención ${metrics.abstentionAccuracy} · handoff por turno ${metrics.turnHandoffAccuracy} · latencia p50 ${metrics.p50TurnLatencyMs} ms · matriz handoff TP ${tp} FP ${fp} FN ${fn} TN ${tn}`,
  "",
  `## Fallas (${failures.length})`,
  "",
  ...failures.slice(0, 80).map((f) => `- \`${f.scenario}\` turno ${f.turn}: ${f.check} esperado ${String(JSON.stringify(f.expected ?? null))} · obtenido ${String(JSON.stringify(f.got ?? null)).slice(0, 220)}`),
  "",
  `## Violaciones de política (${violations.length})`,
  "",
  ...violations.map((v) => `- \`${v.scenario}\`: ${v.kind} · ${v.detail.slice(0, 200)}`),
  "",
].join("\n");
if (!args.filter) writeFileSync(join(root, "evals", "reports", `${outName}.md`), md);

console.log(md.split("## Fallas")[0]);
if (failures.length) console.log(`Fallas: ${failures.length} (ver evals/reports/${outName}.md)`);
for (const f of failures.slice(0, args.filter ? 50 : 15)) console.log(`  - ${f.scenario} t${f.turn} ${f.check}: esperado ${String(JSON.stringify(f.expected ?? null))} obtenido ${String(JSON.stringify(f.got ?? null)).slice(0, 300)}`);
if (!passed && !args["no-gate"]) {
  console.error("GATES NO SUPERADOS");
  process.exit(1);
}
