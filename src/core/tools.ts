import { z } from "zod";
import type { Playbook } from "./playbook";
import type { Integrations } from "../integrations/types";
import type { ToolCallRecord } from "./types";
import { daysBetween } from "./format";

/**
 * Tools tipados. El LLM propone argumentos; acá se validan con zod y se aplican
 * las reglas del playbook ANTES de tocar el sistema del cliente. El customerId
 * nunca lo elige el modelo: sale de la identidad del canal (CRM por teléfono).
 */
export const ToolArgs = {
  get_balance: z.object({ customerId: z.string() }),
  register_payment_promise: z.object({
    customerId: z.string(),
    amount: z.number().positive(),
    date: z.iso.date(),
  }),
  search_kb: z.object({ query: z.string().min(1) }),
  get_available_slots: z.object({ zone: z.string(), limit: z.number().int().min(1).max(5) }),
  book_visit: z.object({ customerId: z.string(), slotId: z.string(), reason: z.string() }),
} as const;

export type ToolName = keyof typeof ToolArgs;

export class PolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ToolEnv {
  pb: Playbook;
  integrations: Integrations;
  today: string;
  now: Date;
}

export async function runTool<N extends ToolName>(
  name: N,
  rawArgs: unknown,
  env: ToolEnv,
  log: ToolCallRecord[],
): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  const t0 = performance.now();
  const parsed = ToolArgs[name].safeParse(rawArgs);
  const args = (parsed.success ? parsed.data : rawArgs) as Record<string, unknown>;
  const record = (ok: boolean, result?: unknown, error?: string) =>
    log.push({ name, args, ok, result, error, latencyMs: Math.round(performance.now() - t0) });
  if (!parsed.success) {
    const error = `invalid_args: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`;
    record(false, undefined, error);
    return { ok: false, error };
  }
  try {
    const result = await execute(name, parsed.data as any, env);
    record(true, result);
    return { ok: true, result };
  } catch (e) {
    const error = e instanceof PolicyError ? `out_of_policy:${e.code}` : `error:${(e as Error).message}`;
    record(false, undefined, error);
    return { ok: false, error };
  }
}

async function execute(name: ToolName, args: any, env: ToolEnv): Promise<unknown> {
  const { integrations: io, pb } = env;
  switch (name) {
    case "get_balance": {
      const b = await io.erp.getBalance(args.customerId);
      if (!b) throw new Error("customer_not_found");
      return b;
    }
    case "register_payment_promise": {
      const b = await io.erp.getBalance(args.customerId);
      if (!b) throw new Error("customer_not_found");
      checkPromisePolicy(pb, env.today, b.total, b.overdueDays, args.amount, args.date);
      return io.erp.registerPaymentPromise(args);
    }
    case "get_available_slots":
      return io.calendar.getAvailableSlots({ zone: args.zone, from: env.now, limit: args.limit });
    case "book_visit":
      return io.calendar.book(args);
    case "search_kb":
      throw new Error("search_kb se ejecuta en el agente técnico");
  }
}

/** Reglas de negocio de promesas de pago. Todas salen del playbook del cliente. */
export function checkPromisePolicy(pb: Playbook, today: string, debt: number, overdueDays: number, amount: number, date: string) {
  const b = pb.billing;
  if (debt <= 0) throw new PolicyError("no_debt");
  if (debt > b.maxPromiseAmount) throw new PolicyError("debt_exceeds_limit");
  if (overdueDays > b.maxOverdueDaysForPromise) throw new PolicyError("overdue_too_long");
  if (amount > debt + 0.001) throw new PolicyError("amount_above_debt");
  if (amount + 0.001 < debt * b.minPromisePercent) throw new PolicyError("amount_below_minimum");
  const days = daysBetween(today, date);
  if (days < 0) throw new PolicyError("date_in_past");
  if (days > b.maxPromiseDays) throw new PolicyError("date_too_far");
}
