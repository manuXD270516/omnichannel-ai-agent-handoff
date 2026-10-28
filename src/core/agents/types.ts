import type { LLMProvider } from "../../llm/provider";
import type { Integrations, Contact } from "../../integrations/types";
import type { Playbook } from "../playbook";
import type { KbIndex } from "../rag";
import type { Conversation, HandoffReason, ToolCallRecord, Triage, TraceStep, TurnRecord } from "../types";

export interface AgentContext {
  conv: Conversation;
  pb: Playbook;
  triage: Triage;
  /** Último mensaje del cliente, ya redactado. */
  text: string;
  contact: Contact | null;
  integrations: Integrations;
  llm: LLMProvider;
  kb: KbIndex;
  now: Date;
  today: string;
  step: (s: TraceStep) => void;
}

export interface AgentResult {
  agent: string;
  reply: string;
  resolved: boolean;
  toolCalls: ToolCallRecord[];
  /** Hechos que respaldan la respuesta (resultados de tools, pasajes). Los usa el guardrail de salida. */
  facts: string[];
  /** El cliente pidió algo fuera de política (lo rechazó un tool). */
  outOfPolicy?: string;
  /** El agente pide derivar (ej. retención). */
  handoff?: { reason: HandoffReason; detail: string };
  rag?: TurnRecord["rag"];
}

export interface SpecialistAgent {
  name: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}

export async function timed<T>(ctx: AgentContext, agent: string, step: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  ctx.step({ agent, step, latencyMs: Math.round(performance.now() - t0), input, output: out });
  return out;
}
