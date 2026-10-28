/**
 * Genera la demo estática para GitHub Pages en ./site:
 *  - index.html + data.js: resultados de evaluación (scripted y Ollama) y replay de conversaciones.
 *  - dashboard.html + dashboard-data.js: la bandeja humana real en modo solo lectura, con
 *    conversaciones sintéticas producidas por el pipeline (incluye un ciclo de handoff completo).
 * Sin backend ni secretos: todo sale de evals/reports/*.json y de una corrida local del motor.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TENANTS } from "../src/generated/tenants";
import { DASHBOARD_HTML } from "../src/generated/dashboard";
import { buildRuntime } from "../src/runtime";
import { MemoryStore } from "../src/store/store";
import { computeMetrics } from "../src/core/metrics";
import type { Conversation, Trace } from "../src/core/types";

const root = join(import.meta.dirname, "..");
const site = join(root, "site");
mkdirSync(site, { recursive: true });

interface Report {
  provider: string;
  generatedAt: string;
  durationSec: number;
  metrics: Record<string, unknown>;
  gates: unknown[];
  passed: boolean;
  violations: unknown[];
  failures: unknown[];
  results: unknown[];
  conversations: Conversation[];
  traces: Record<string, Trace[]>;
}

const rank = (f: string) => (f.startsWith("scripted") ? 0 : f.includes("iter") ? 2 : 1);
const reports: Report[] = readdirSync(join(root, "evals", "reports"))
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !f.startsWith("ci-"))
  // Orden: scripted, corrida final del modelo, iteraciones anteriores.
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  .map((f) => JSON.parse(readFileSync(join(root, "evals", "reports", f), "utf8")) as Report);
if (!reports.some((r) => r.provider === "scripted")) throw new Error("Falta evals/reports/scripted.json: corré `pnpm eval` primero");

// Ciclo completo de handoff para el dashboard: IA → derivación → humano toma → responde → devuelve → IA.
const store = new MemoryStore();
const now = new Date("2026-10-27T15:00:00Z");
const { engine } = buildRuntime({ env: {}, store, tenants: TENANTS, now: () => now });
const lucia = { tenantId: "fibrasur", channel: "whatsapp" as const, contactId: "5491155550101" };
await engine.handleInbound({ ...lucia, text: "¿Cuánto debo?" });
const h = await engine.handleInbound({ ...lucia, text: "No entiendo por qué es tanto, quiero hablar con una persona" });
await engine.claim(h.conversation.id, "Valentina (N1)");
await engine.humanReply(h.conversation.id, "Valentina (N1)", "Hola Lucía, soy Valentina. El saldo es la factura de octubre, que venció el 10. ¿Querés que te ayude a registrar una promesa de pago?");
await engine.handleInbound({ ...lucia, text: "Sí, gracias" });
await engine.release(h.conversation.id, "Valentina (N1)");
await engine.handleInbound({ ...lucia, text: "Puedo pagar el viernes" });
const cycle = (await store.getConversation(h.conversation.id))!;
const cycleTraces = await store.listTraces(cycle.id);

const scripted = reports.find((r) => r.provider === "scripted")!;
const conversations = [cycle, ...scripted.conversations];
const traces = { ...scripted.traces, [cycle.id]: cycleTraces };
writeFileSync(
  join(site, "dashboard-data.js"),
  `window.__STATIC__ = ${JSON.stringify({ provider: "scripted (replay)", initial: cycle.id, conversations, traces, metrics: computeMetrics(conversations) })};\n`,
);
writeFileSync(join(site, "dashboard.html"), DASHBOARD_HTML.replace("<script>\n  const STATIC", '<script src="dashboard-data.js"></script>\n<script>\n  const STATIC'));

const slim = reports.map((r) => ({
  provider: r.provider,
  generatedAt: r.generatedAt,
  durationSec: r.durationSec,
  metrics: r.metrics,
  gates: r.gates,
  passed: r.passed,
  violations: r.violations,
  failures: r.failures,
  results: r.results,
}));
writeFileSync(join(site, "data.js"), `window.DEMO = ${JSON.stringify({ reports: slim })};\n`);
copyFileSync(join(root, "demo", "index.html"), join(site, "index.html"));
if (existsSync(join(root, "docs", "architecture.svg"))) copyFileSync(join(root, "docs", "architecture.svg"), join(site, "architecture.svg"));
writeFileSync(join(site, ".nojekyll"), "");
console.log(`Demo generada en site/ con ${reports.length} reporte(s): ${reports.map((r) => r.provider).join(", ")}`);
