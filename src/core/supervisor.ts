import type { Playbook } from "./playbook";
import type { Counters, HandoffReason, Triage } from "./types";

export type Decision =
  | { action: "continue" }
  | { action: "clarify"; rule: string }
  | { action: "refuse"; rule: string }
  | { action: "handoff"; reason: HandoffReason; detail: string };

export interface PreInput {
  triage: Triage;
  injection: boolean;
  explicitHumanRule: boolean;
  counters: Counters;
}

/**
 * Supervisor: reglas explícitas, ordenadas por prioridad y configurables por playbook.
 * Se evalúa antes de llamar al especialista (pre) y después (post).
 * Las reglas son código, no un prompt: son auditables, testeables y el cliente puede leerlas.
 */
export function supervisePre(pb: Playbook, input: PreInput): Decision {
  const { triage, counters } = input;
  const h = pb.handoff;
  if (input.injection) {
    if (counters.injectionCount >= h.injectionStrikes) {
      return { action: "handoff", reason: "prompt_injection", detail: `Intentos de inyección: ${counters.injectionCount}` };
    }
    return { action: "refuse", rule: "prompt_injection" };
  }
  if (h.onExplicitRequest && (triage.wantsHuman || input.explicitHumanRule)) {
    return { action: "handoff", reason: "explicit_request", detail: "El cliente pidió hablar con una persona" };
  }
  if (!pb.tenant.languages.includes(triage.language)) {
    return { action: "handoff", reason: "unsupported_language", detail: `Idioma detectado: ${triage.language}` };
  }
  if (h.urgencyHandoff.includes(triage.urgency)) {
    return { action: "handoff", reason: "critical_urgency", detail: `Urgencia ${triage.urgency}` };
  }
  if (counters.negativeStreak >= h.negativeSentimentTurns) {
    return { action: "handoff", reason: "negative_sentiment", detail: `${counters.negativeStreak} turnos seguidos con sentimiento negativo` };
  }
  if (isLowConfidence(pb, triage)) {
    if (counters.lowConfidenceStreak >= h.lowConfidenceStrikes) {
      return { action: "handoff", reason: "low_confidence", detail: `Confianza ${triage.confidence.toFixed(2)} < ${h.minConfidence} (${counters.lowConfidenceStreak} veces)` };
    }
    return { action: "clarify", rule: "low_confidence" };
  }
  if (!pb.intents.enabled.includes(triage.intent)) {
    return { action: "handoff", reason: "intent_disabled", detail: `Intención ${triage.intent} no habilitada para este cliente` };
  }
  if (h.alwaysHumanIntents.includes(triage.intent)) {
    return { action: "handoff", reason: "always_human_intent", detail: `Intención ${triage.intent} siempre va a un humano` };
  }
  return { action: "continue" };
}

export interface PostInput {
  outOfPolicy?: string;
  outputBlocked: boolean;
  outputFlags: string[];
  agentHandoff?: { reason: HandoffReason; detail: string };
  counters: Counters;
}

export function supervisePost(pb: Playbook, input: PostInput): Decision {
  if (input.agentHandoff) return { action: "handoff", ...input.agentHandoff };
  if (input.outputBlocked) {
    return { action: "handoff", reason: "policy_violation", detail: `Respuesta bloqueada por el guardrail: ${input.outputFlags.join(", ")}` };
  }
  if (input.outOfPolicy && pb.handoff.onOutOfPolicyRequest) {
    return { action: "handoff", reason: "out_of_policy_request", detail: `Pedido fuera de política: ${input.outOfPolicy}` };
  }
  if (input.counters.unresolved >= pb.handoff.maxUnresolvedTurns) {
    return { action: "handoff", reason: "max_unresolved_turns", detail: `${input.counters.unresolved} turnos seguidos sin resolver` };
  }
  return { action: "continue" };
}

/** Actualiza contadores con el triage del turno (antes de decidir). */
export function updateCountersPre(c: Counters, pb: Playbook, triage: Triage, injection: boolean): Counters {
  return {
    ...c,
    injectionCount: c.injectionCount + (injection ? 1 : 0),
    negativeStreak: triage.sentiment === "negative" ? c.negativeStreak + 1 : 0,
    lowConfidenceStreak: isLowConfidence(pb, triage) ? c.lowConfidenceStreak + 1 : 0,
  };
}

/**
 * Baja confianza o fuera de alcance. Un modelo real puede estar "muy seguro" de que
 * "¿venden heladeras?" es `other`: eso tampoco lo puede resolver la IA, así que cuenta igual.
 */
export function isLowConfidence(pb: Playbook, triage: Triage): boolean {
  return triage.confidence < pb.handoff.minConfidence || triage.intent === "other";
}
