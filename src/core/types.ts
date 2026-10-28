import { z } from "zod";

export const INTENTS = [
  "billing_inquiry",
  "payment_promise",
  "tech_support",
  "schedule_visit",
  "cancellation",
  "greeting",
  "other",
] as const;
export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;

export const SentimentSchema = z.enum(["negative", "neutral", "positive"]);
export const UrgencySchema = z.enum(["low", "medium", "high", "critical"]);

/** Salida estructurada del router/triage. */
export const TriageSchema = z.object({
  intent: IntentSchema,
  language: z.string().min(2).max(5),
  urgency: UrgencySchema,
  sentiment: SentimentSchema,
  confidence: z.number().min(0).max(1),
  wantsHuman: z.boolean(),
});
export type Triage = z.infer<typeof TriageSchema>;

export type Channel = "whatsapp" | "voice" | "web";
export type ConversationStatus = "ai" | "pending_human" | "human" | "closed";
export type Role = "customer" | "ai" | "human_agent" | "system";

export const HANDOFF_REASONS = [
  "explicit_request",
  "low_confidence",
  "negative_sentiment",
  "policy_violation",
  "out_of_policy_request",
  "max_unresolved_turns",
  "always_human_intent",
  "intent_disabled",
  "critical_urgency",
  "prompt_injection",
  "unsupported_language",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export interface Message {
  id: string;
  role: Role;
  /** Texto ya redactado (sin PII) cuando el rol es customer. */
  text: string;
  at: string;
  agent?: string;
  author?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  latencyMs: number;
}

export interface TurnRecord {
  index: number;
  triage: Triage;
  agent: string;
  toolCalls: ToolCallRecord[];
  resolved: boolean;
  guardrailFlags: string[];
  handoff?: HandoffReason;
  rag?: { citations: string[]; retrieved: string[]; abstained: boolean; grounded: boolean };
  latencyMs: number;
}

export interface HandoffInfo {
  reason: HandoffReason;
  detail: string;
  summary: string;
  /** Ficha estructurada para el humano: datos del CRM, último saldo, tools usados, último mensaje. */
  brief: HandoffBrief;
  at: string;
  crmTicketId?: string;
  claimedBy?: string;
  claimedAt?: string;
  releasedAt?: string;
  withinBusinessHours: boolean;
}

export interface HandoffBrief {
  intent: Intent;
  sentiment: Triage["sentiment"];
  urgency: Triage["urgency"];
  customer: { id?: string; name?: string; plan?: string; segment?: string; zone?: string } | null;
  lastBalance?: { total: number; currency: string; overdueDays: number };
  toolsUsed: string[];
  turns: number;
  lastCustomerMessage: string;
  priority: "low" | "medium" | "high";
  queue: string;
}

export interface Counters {
  unresolved: number;
  lowConfidenceStreak: number;
  negativeStreak: number;
  injectionCount: number;
}

export interface ConversationState {
  /** Turnos ofrecidos por el agente de agenda, para resolver "el segundo", "el jueves", etc. */
  offeredSlots?: { id: string; start: string; label: string }[];
  /** Último paso de diagnóstico guiado ya sugerido. */
  diagnosticStep?: number;
  lastIntent?: Intent;
  /** Promesas rechazadas por política en esta conversación (la IA renegocia una vez). */
  promiseRejections?: number;
  /** La IA ofreció una visita técnica en el turno anterior. */
  visitOffered?: boolean;
}

export interface Conversation {
  id: string;
  tenantId: string;
  channel: Channel;
  contactId: string;
  customerId?: string;
  customerName?: string;
  status: ConversationStatus;
  messages: Message[];
  turns: TurnRecord[];
  counters: Counters;
  state: ConversationState;
  handoff?: HandoffInfo;
  handoffHistory: HandoffInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface TraceStep {
  agent: string;
  step: string;
  latencyMs: number;
  input?: unknown;
  output?: unknown;
}

export interface Trace {
  id: string;
  conversationId: string;
  tenantId: string;
  turnIndex: number;
  provider: string;
  steps: TraceStep[];
  decision: { action: "continue" | "handoff" | "paused"; reason?: HandoffReason; detail?: string };
  totalLatencyMs: number;
  at: string;
}

export interface OutboundMessage {
  id: string;
  tenantId: string;
  channel: Channel;
  to: string;
  /** Payload en el formato exacto que se enviaría a la API del canal. */
  payload: unknown;
  text: string;
  at: string;
}
