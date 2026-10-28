import { describe, expect, it } from "vitest";
import { TENANTS } from "../../src/generated/tenants";
import { parsePlaybook } from "../../src/core/playbook";
import { supervisePost, supervisePre } from "../../src/core/supervisor";
import { checkPromisePolicy, PolicyError } from "../../src/core/tools";
import type { Counters, Triage } from "../../src/core/types";

const fib = TENANTS.fibrasur!.playbook;
const andes = TENANTS.andeslink!.playbook;
const triage = (t: Partial<Triage> = {}): Triage => ({ intent: "billing_inquiry", language: "es", urgency: "low", sentiment: "neutral", confidence: 0.9, wantsHuman: false, ...t });
const counters = (c: Partial<Counters> = {}): Counters => ({ unresolved: 0, lowConfidenceStreak: 0, negativeStreak: 0, injectionCount: 0, ...c });

describe("playbooks", () => {
  it("los dos tenants validan contra el schema", () => {
    expect(fib.tenant.currency).toBe("ARS");
    expect(andes.tone.address).toBe("usted");
  });
  it("rechaza playbooks inválidos con un mensaje claro", () => {
    const bad = structuredClone(fib) as Record<string, any>;
    bad.businessHours.open = "22:00";
    expect(() => parsePlaybook(bad)).toThrow(/businessHours/);
    const bad2 = structuredClone(andes) as Record<string, any>;
    bad2.handoff.alwaysHumanIntents = ["payment_promise"];
    expect(() => parsePlaybook(bad2)).toThrow(/no está habilitada/);
  });
});

describe("supervisor", () => {
  it("prioriza la inyección por sobre todo lo demás", () => {
    expect(supervisePre(fib, { triage: triage({ wantsHuman: true }), injection: true, explicitHumanRule: true, counters: counters({ injectionCount: 1 }) }).action).toBe("refuse");
    expect(supervisePre(fib, { triage: triage(), injection: true, explicitHumanRule: false, counters: counters({ injectionCount: 2 }) })).toMatchObject({ reason: "prompt_injection" });
  });
  it("aplica reglas distintas según el playbook", () => {
    const urgent = { triage: triage({ intent: "tech_support", urgency: "high" }), injection: false, explicitHumanRule: false, counters: counters() };
    expect(supervisePre(fib, urgent).action).toBe("continue");
    expect(supervisePre(andes, urgent)).toMatchObject({ action: "handoff", reason: "critical_urgency" });
    const promise = { triage: triage({ intent: "payment_promise" }), injection: false, explicitHumanRule: false, counters: counters() };
    expect(supervisePre(fib, promise).action).toBe("continue");
    expect(supervisePre(andes, promise)).toMatchObject({ reason: "intent_disabled" });
  });
  it("pide aclaración la primera vez con baja confianza y deriva al reincidir", () => {
    const low = triage({ intent: "other", confidence: 0.3 });
    expect(supervisePre(fib, { triage: low, injection: false, explicitHumanRule: false, counters: counters({ lowConfidenceStreak: 1 }) }).action).toBe("clarify");
    expect(supervisePre(fib, { triage: low, injection: false, explicitHumanRule: false, counters: counters({ lowConfidenceStreak: 2 }) })).toMatchObject({ reason: "low_confidence" });
  });
  it("sentimiento negativo sostenido, baja y pedido explícito", () => {
    expect(supervisePre(fib, { triage: triage(), injection: false, explicitHumanRule: false, counters: counters({ negativeStreak: 2 }) })).toMatchObject({ reason: "negative_sentiment" });
    expect(supervisePre(fib, { triage: triage({ intent: "cancellation" }), injection: false, explicitHumanRule: false, counters: counters() })).toMatchObject({ reason: "always_human_intent" });
    expect(supervisePre(fib, { triage: triage(), injection: false, explicitHumanRule: true, counters: counters() })).toMatchObject({ reason: "explicit_request" });
  });
  it("post: guardrail, fuera de política y N turnos sin resolver", () => {
    expect(supervisePost(fib, { outputBlocked: true, outputFlags: ["unsupported_amount"], counters: counters() })).toMatchObject({ reason: "policy_violation" });
    expect(supervisePost(fib, { outOfPolicy: "debt_exceeds_limit", outputBlocked: false, outputFlags: [], counters: counters() })).toMatchObject({ reason: "out_of_policy_request" });
    expect(supervisePost(fib, { outputBlocked: false, outputFlags: [], counters: counters({ unresolved: 3 }) })).toMatchObject({ reason: "max_unresolved_turns" });
    expect(supervisePost(fib, { outputBlocked: false, outputFlags: [], counters: counters({ unresolved: 2 }) }).action).toBe("continue");
  });
});

describe("política de promesas de pago", () => {
  const code = (fn: () => void) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return (e as PolicyError).code;
    }
  };
  it.each([
    [18450, 17, 18450, "2026-10-30", "ok"],
    [18450, 17, 18450, "2026-11-25", "date_too_far"],
    [18450, 17, 5000, "2026-10-30", "amount_below_minimum"],
    [92300, 47, 92300, "2026-10-30", "debt_exceeds_limit"],
    [36900, 78, 36900, "2026-10-30", "overdue_too_long"],
    [0, 0, 100, "2026-10-30", "no_debt"],
    [18450, 17, 18450, "2026-10-20", "date_in_past"],
  ])("deuda %d, %d días, promete %d el %s → %s", (debt, overdue, amount, date, expected) => {
    expect(code(() => checkPromisePolicy(fib, "2026-10-27", debt, overdue, amount, date))).toBe(expected);
  });
});
