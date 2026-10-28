import type { LLMProvider } from "../llm/provider";
import type { Contact, Integrations, Balance } from "../integrations/types";
import type { ChannelSender } from "../channels/whatsapp";
import { within24hWindow } from "../channels/whatsapp";
import type { Store } from "../store/store";
import type { TenantBundle } from "./playbook";
import { chunkKb, KbIndex } from "./rag";
import { checkOutput, detectInjection, detectsHumanRequest, redactPii } from "./guardrail";
import { history, routerPrompt, summaryPrompt } from "./prompts";
import { localDate, say, withinBusinessHours } from "./format";
import { SPECIALISTS, smalltalkAgent } from "./agents/specialists";
import type { AgentContext, AgentResult } from "./agents/types";
import { supervisePost, supervisePre, updateCountersPre, type Decision } from "./supervisor";
import {
  TriageSchema,
  type Channel,
  type Conversation,
  type HandoffBrief,
  type HandoffReason,
  type Message,
  type Trace,
  type TraceStep,
  type Triage,
  type TurnRecord,
} from "./types";

export interface EngineDeps {
  store: Store;
  llm: LLMProvider;
  tenants: Record<string, TenantBundle>;
  integrationsFor: (tenantId: string) => Integrations;
  sender: ChannelSender;
  now?: () => Date;
  /** Hook post-conversación (ej. webhook a n8n para encuesta / ticket). */
  onClosed?: (conv: Conversation) => Promise<void>;
}

export interface InboundInput {
  tenantId: string;
  channel: Channel;
  contactId: string;
  text: string;
  profileName?: string;
}

export interface TurnOutcome {
  conversation: Conversation;
  replies: string[];
  decision: Trace["decision"];
  trace: Trace;
}

/** Estado de la conversación que el router necesita para interpretar respuestas cortas ("el 2", "sí"). */
function stateHint(conv: Conversation): string {
  const hints: string[] = [];
  if (conv.state.offeredSlots?.length) hints.push(`La IA ofreció ${conv.state.offeredSlots.length} turnos numerados de visita técnica; si el cliente elige uno (por número, día u hora), la intención es schedule_visit.`);
  if (conv.state.visitOffered) hints.push("La IA preguntó si el cliente quiere agendar una visita técnica; si acepta, la intención es schedule_visit.");
  if (conv.state.lastIntent) hints.push(`Intención del turno anterior: ${conv.state.lastIntent}.`);
  return hints.length ? `\nEstado de la conversación: ${hints.join(" ")}\n` : "";
}

const FALLBACK_TRIAGE: Triage = { intent: "other", language: "es", urgency: "low", sentiment: "neutral", confidence: 0, wantsHuman: false };

export class Engine {
  private readonly indexes = new Map<string, KbIndex>();
  readonly now: () => Date;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    for (const [id, t] of Object.entries(deps.tenants)) this.indexes.set(id, new KbIndex(chunkKb(t.kb)));
  }

  get llmName() {
    return this.deps.llm.name;
  }

  tenant(tenantId: string): TenantBundle {
    const t = this.deps.tenants[tenantId];
    if (!t) throw new Error(`Tenant desconocido: ${tenantId}`);
    return t;
  }

  listTenants(): TenantBundle[] {
    return Object.values(this.deps.tenants);
  }

  tenantByPhoneNumberId(phoneNumberId: string): TenantBundle | undefined {
    return Object.values(this.deps.tenants).find((t) => t.playbook.channels.whatsapp?.phoneNumberId === phoneNumberId);
  }

  private newConversation(input: InboundInput, contact: Contact | null): Conversation {
    const at = this.now().toISOString();
    return {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      channel: input.channel,
      contactId: input.contactId,
      customerId: contact?.id,
      customerName: contact?.name ?? input.profileName,
      status: "ai",
      messages: [],
      turns: [],
      counters: { unresolved: 0, lowConfidenceStreak: 0, negativeStreak: 0, injectionCount: 0 },
      state: {},
      handoffHistory: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  private msg(role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
    return { id: crypto.randomUUID(), role, text, at: this.now().toISOString(), ...extra };
  }

  async handleInbound(input: InboundInput): Promise<TurnOutcome> {
    const t0 = performance.now();
    const { playbook: pb } = this.tenant(input.tenantId);
    const io = this.deps.integrationsFor(input.tenantId);
    const steps: TraceStep[] = [];
    const step = (s: TraceStep) => steps.push(s);

    const contact = await io.crm.findContactByPhone(input.contactId);
    const conv = (await this.deps.store.findOpenConversation(input.tenantId, input.channel, input.contactId)) ?? this.newConversation(input, contact);

    // 1. Guardrail de entrada: PII fuera antes de que el texto llegue al LLM, a logs o a la base.
    const g0 = performance.now();
    const pii = redactPii(input.text);
    const injection = detectInjection(input.text);
    step({ agent: "guardrail", step: "input", latencyMs: Math.round(performance.now() - g0), output: { pii: pii.found, injection } });
    conv.messages.push(this.msg("customer", pii.redacted));

    // 2. Si un humano tiene la conversación (o está en cola), la IA queda en pausa.
    if (conv.status === "pending_human" || conv.status === "human") {
      const trace = this.trace(conv, steps, { action: "paused" }, t0);
      conv.updatedAt = this.now().toISOString();
      await this.deps.store.saveConversation(conv);
      await this.deps.store.appendTrace(trace);
      return { conversation: conv, replies: [], decision: trace.decision, trace };
    }

    // 3. Router / triage con salida estructurada.
    const triage = await this.route(conv, pb.tenant.name, pii.redacted, steps, input.tenantId);
    conv.counters = updateCountersPre(conv.counters, pb, triage, injection);
    const explicitHumanRule = detectsHumanRequest(pii.redacted);

    const ctx: AgentContext = {
      conv,
      pb,
      triage,
      text: pii.redacted,
      contact,
      integrations: io,
      llm: this.deps.llm,
      kb: this.indexes.get(input.tenantId)!,
      now: this.now(),
      today: localDate(pb, this.now()),
      step,
    };

    // 4. Supervisor (pre).
    const pre = supervisePre(pb, { triage, injection, explicitHumanRule, counters: conv.counters });
    step({ agent: "supervisor", step: "pre", latencyMs: 0, output: pre });

    let decision: Decision = pre;
    let result: AgentResult | undefined;
    let flags: string[] = [...pii.found.map((f) => `pii_in:${f}`), ...(injection ? ["injection"] : [])];
    const replies: string[] = [];
    conv.state.visitOffered = false;

    if (pre.action === "refuse") {
      result = {
        agent: "guardrail",
        resolved: false,
        toolCalls: [],
        facts: [],
        reply: say(pb, {
          vos: "Solo puedo ayudarte con temas de tu servicio: facturación, fallas técnicas y visitas. ¿En qué te ayudo?",
          usted: "Solo puedo ayudarle con temas de su servicio: facturación, fallas técnicas y visitas. ¿En qué puedo ayudarle?",
        }),
      };
      replies.push(result.reply);
    } else if (pre.action === "clarify") {
      result = await smalltalkAgent.run({ ...ctx, triage: { ...triage, intent: "other" } });
      conv.counters.unresolved += 1;
      replies.push(result.reply);
      decision = supervisePost(pb, { outputBlocked: false, outputFlags: [], counters: conv.counters });
    } else if (pre.action === "continue") {
      // 5. Especialista con tool calling tipado.
      const specialist = SPECIALISTS[triage.intent];
      const s0 = performance.now();
      try {
        result = await specialist.run(ctx);
      } catch (e) {
        step({ agent: specialist.name, step: "error", latencyMs: 0, output: (e as Error).message });
        result = { agent: specialist.name, resolved: false, toolCalls: [], facts: [], reply: say(pb, { vos: "Tuve un problema técnico. ¿Me lo repetís?", usted: "Tuve un inconveniente técnico. ¿Podría repetirlo?" }) };
      }
      step({ agent: specialist.name, step: "run", latencyMs: Math.round(performance.now() - s0), output: { resolved: result.resolved, tools: result.toolCalls.map((t) => `${t.name}:${t.ok ? "ok" : t.error}`) } });

      // 6. Guardrail de salida: montos sin respaldo, compromisos no autorizados, fuga de prompt, PII.
      const out = checkOutput(result.reply, result.facts);
      flags = [...flags, ...out.flags];
      step({ agent: "guardrail", step: "output", latencyMs: 0, output: { flags: out.flags, blocked: out.blocked } });
      conv.counters.unresolved = result.resolved ? 0 : conv.counters.unresolved + 1;

      // 7. Supervisor (post).
      decision = supervisePost(pb, { outOfPolicy: result.outOfPolicy, outputBlocked: out.blocked, outputFlags: out.flags, agentHandoff: result.handoff, counters: conv.counters });
      step({ agent: "supervisor", step: "post", latencyMs: 0, output: decision });
      if (decision.action !== "handoff" && out.text) replies.push(out.text);
    }
    conv.state.lastIntent = triage.intent;

    // 8. Handoff con resumen, ficha y ticket en el CRM.
    let handoffReason: HandoffReason | undefined;
    if (decision.action === "handoff") {
      handoffReason = decision.reason;
      // Si el especialista ya respondió algo útil antes de derivar (ej. pedido fuera de política), no se pierde.
      replies.push(await this.handoff(conv, decision.reason, decision.detail, triage, contact, steps));
    }

    for (const r of replies) conv.messages.push(this.msg("ai", r, { agent: result?.agent ?? "supervisor" }));
    const turn: TurnRecord = {
      index: conv.turns.length,
      triage,
      agent: result?.agent ?? "supervisor",
      toolCalls: result?.toolCalls ?? [],
      resolved: result?.resolved ?? false,
      guardrailFlags: flags,
      handoff: handoffReason,
      rag: result?.rag,
      latencyMs: Math.round(performance.now() - t0),
    };
    conv.turns.push(turn);
    conv.updatedAt = this.now().toISOString();
    const trace = this.trace(conv, steps, decision.action === "handoff" ? { action: "handoff", reason: decision.reason, detail: decision.detail } : { action: "continue" }, t0);

    await this.deps.store.saveConversation(conv);
    await this.deps.store.appendTrace(trace);
    for (const r of replies) {
      await this.deps.sender.send({ tenantId: conv.tenantId, channel: conv.channel, to: conv.contactId, text: r, phoneNumberId: pb.channels.whatsapp?.phoneNumberId });
    }
    return { conversation: conv, replies, decision: trace.decision, trace };
  }

  private async route(conv: Conversation, _tenantName: string, text: string, steps: TraceStep[], tenantId: string): Promise<Triage> {
    const { playbook: pb } = this.tenant(tenantId);
    const r0 = performance.now();
    try {
      const { object, attempts } = await this.deps.llm.generateObject({
        task: "router",
        system: routerPrompt(pb),
        user: `Historial:\n${history(conv, 6)}\n${stateHint(conv)}\nÚltimo mensaje del cliente: ${text}`,
        schema: TriageSchema,
        context: { text, conv },
      });
      steps.push({ agent: "router", step: "triage", latencyMs: Math.round(performance.now() - r0), output: { ...object, attempts } });
      return object;
    } catch (e) {
      steps.push({ agent: "router", step: "triage_error", latencyMs: Math.round(performance.now() - r0), output: (e as Error).message });
      return FALLBACK_TRIAGE;
    }
  }

  private async handoff(conv: Conversation, reason: HandoffReason, detail: string, triage: Triage, contact: Contact | null, steps: TraceStep[]): Promise<string> {
    const { playbook: pb } = this.tenant(conv.tenantId);
    const io = this.deps.integrationsFor(conv.tenantId);
    const h0 = performance.now();
    const allTools = conv.turns.flatMap((t) => t.toolCalls);
    const lastBalance = [...allTools].reverse().find((t) => t.name === "get_balance" && t.ok)?.result as Balance | undefined;
    const priority: HandoffBrief["priority"] =
      triage.urgency === "critical" || triage.urgency === "high" || reason === "negative_sentiment" || reason === "prompt_injection" ? "high" : reason === "explicit_request" ? "medium" : "medium";
    const brief: HandoffBrief = {
      intent: triage.intent,
      sentiment: triage.sentiment,
      urgency: triage.urgency,
      customer: contact ? { id: contact.id, name: contact.name, plan: contact.plan, segment: contact.segment, zone: contact.zone } : null,
      lastBalance: lastBalance ? { total: lastBalance.total, currency: lastBalance.currency, overdueDays: lastBalance.overdueDays } : undefined,
      toolsUsed: [...new Set(allTools.map((t) => `${t.name}${t.ok ? "" : ` (${t.error})`}`))],
      turns: conv.turns.length + 1,
      lastCustomerMessage: conv.messages.filter((m) => m.role === "customer").at(-1)?.text ?? "",
      priority,
      queue: pb.handoff.queue,
    };
    let summary: string;
    try {
      summary = await this.deps.llm.generateText({
        task: "summary",
        system: summaryPrompt(pb),
        user: `Motivo de derivación: ${reason} (${detail}).\nFicha: ${JSON.stringify(brief)}\nConversación:\n${history(conv, 12)}`,
        context: { conv, reason, detail, brief },
      });
      summary = redactPii(summary).redacted.slice(0, 800);
    } catch {
      summary = `Derivación por ${reason}: ${detail}. Último mensaje: "${brief.lastCustomerMessage}".`;
    }
    const ticket = await io.crm.createTicket({
      contactId: contact?.id,
      subject: `[${reason}] ${triage.intent} · ${contact?.name ?? conv.contactId}`,
      body: `${summary}\n\nMotivo: ${detail}\nFicha: ${JSON.stringify(brief)}`,
      priority,
      pipeline: pb.integrations.crm.pipeline ?? pb.handoff.queue,
    });
    const inHours = withinBusinessHours(pb, this.now());
    conv.handoff = { reason, detail, summary, brief, at: this.now().toISOString(), crmTicketId: ticket.id, withinBusinessHours: inHours };
    conv.status = "pending_human";
    steps.push({ agent: "handoff", step: "enqueue", latencyMs: Math.round(performance.now() - h0), output: { reason, ticket: ticket.id, queue: pb.handoff.queue, inHours } });
    return inHours ? pb.handoff.messages.inHours : pb.handoff.messages.outOfHours;
  }

  private trace(conv: Conversation, steps: TraceStep[], decision: Trace["decision"], t0: number): Trace {
    return {
      id: crypto.randomUUID(),
      conversationId: conv.id,
      tenantId: conv.tenantId,
      turnIndex: conv.turns.length - 1,
      provider: this.deps.llm.name,
      steps,
      decision,
      totalLatencyMs: Math.round(performance.now() - t0),
      at: this.now().toISOString(),
    };
  }

  // ---- Bandeja humana ----

  private async load(id: string): Promise<Conversation> {
    const c = await this.deps.store.getConversation(id);
    if (!c) throw new HttpError(404, "conversation_not_found");
    return c;
  }

  async claim(id: string, agentName: string): Promise<Conversation> {
    const c = await this.load(id);
    if (c.status !== "pending_human") throw new HttpError(409, `no se puede tomar una conversación en estado ${c.status}`);
    c.status = "human";
    if (c.handoff) Object.assign(c.handoff, { claimedBy: agentName, claimedAt: this.now().toISOString() });
    c.messages.push(this.msg("system", `${agentName} tomó la conversación. La IA queda en pausa.`));
    c.updatedAt = this.now().toISOString();
    if (c.handoff?.crmTicketId) await this.deps.integrationsFor(c.tenantId).crm.updateTicketStatus(c.handoff.crmTicketId, "in_progress");
    await this.deps.store.saveConversation(c);
    return c;
  }

  async humanReply(id: string, agentName: string, text: string): Promise<Conversation> {
    const c = await this.load(id);
    if (c.status !== "human") throw new HttpError(409, "primero hay que tomar la conversación");
    const lastCustomer = c.messages.filter((m) => m.role === "customer").at(-1)?.at;
    if (c.channel === "whatsapp" && !within24hWindow(lastCustomer, this.now())) {
      throw new HttpError(422, "fuera de la ventana de 24 h de WhatsApp: hay que usar una plantilla aprobada");
    }
    c.messages.push(this.msg("human_agent", text, { author: agentName }));
    c.updatedAt = this.now().toISOString();
    await this.deps.store.saveConversation(c);
    const pb = this.tenant(c.tenantId).playbook;
    await this.deps.sender.send({ tenantId: c.tenantId, channel: c.channel, to: c.contactId, text, phoneNumberId: pb.channels.whatsapp?.phoneNumberId });
    if (c.handoff?.crmTicketId) await this.deps.integrationsFor(c.tenantId).crm.addNote(c.handoff.crmTicketId, `${agentName}: ${text}`);
    return c;
  }

  /** Devuelve la conversación a la IA con los contadores en cero. */
  async release(id: string, agentName: string): Promise<Conversation> {
    const c = await this.load(id);
    if (c.status !== "human") throw new HttpError(409, `no se puede devolver una conversación en estado ${c.status}`);
    if (c.handoff) c.handoffHistory.push({ ...c.handoff, releasedAt: this.now().toISOString() });
    c.handoff = undefined;
    c.status = "ai";
    c.counters = { unresolved: 0, lowConfidenceStreak: 0, negativeStreak: 0, injectionCount: 0 };
    c.state = {};
    c.messages.push(this.msg("system", `${agentName} devolvió la conversación a la IA.`));
    c.updatedAt = this.now().toISOString();
    await this.deps.store.saveConversation(c);
    return c;
  }

  async close(id: string, agentName: string): Promise<Conversation> {
    const c = await this.load(id);
    if (c.status === "closed") return c;
    const ticketId = c.handoff?.crmTicketId;
    if (c.handoff) c.handoffHistory.push({ ...c.handoff, releasedAt: this.now().toISOString() });
    c.status = "closed";
    c.messages.push(this.msg("system", `Conversación cerrada por ${agentName}.`));
    c.updatedAt = this.now().toISOString();
    await this.deps.store.saveConversation(c);
    if (ticketId) await this.deps.integrationsFor(c.tenantId).crm.updateTicketStatus(ticketId, "closed");
    await this.deps.onClosed?.(c);
    return c;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
