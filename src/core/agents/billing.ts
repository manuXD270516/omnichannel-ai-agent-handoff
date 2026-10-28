import { z } from "zod";
import { billingPrompt, history } from "../prompts";
import { money, prettyDate, say, todayLabel } from "../format";
import { runTool } from "../tools";
import { mentionsAmount, mentionsDate } from "../guardrail";
import type { Balance, PaymentPromise } from "../../integrations/types";
import type { ToolCallRecord } from "../types";
import { answerFromKb } from "./knowledge";
import type { AgentContext, AgentResult, SpecialistAgent } from "./types";
import { timed } from "./types";

export const BillingPlanSchema = z.object({
  tool: z.enum(["get_balance", "register_payment_promise", "none"]),
  amount: z.number().nullable(),
  date: z.string().nullable(),
});

/** Códigos de política que la IA puede renegociar una vez (pedir otra fecha); el resto va a un humano. */
const NEGOTIABLE = new Set(["date_too_far", "amount_below_minimum", "date_in_past"]);

export const billingAgent: SpecialistAgent = {
  name: "billing",
  async run(ctx: AgentContext): Promise<AgentResult> {
    const agent = "billing";
    const { pb } = ctx;
    const toolCalls: ToolCallRecord[] = [];
    if (!ctx.contact) {
      return {
        agent,
        resolved: false,
        toolCalls,
        facts: [],
        reply: say(pb, {
          vos: "No encuentro una cuenta asociada a este número. Escribinos desde el teléfono del titular o pedime hablar con una persona.",
          usted: "No encuentro una cuenta asociada a este número. Por favor escríbanos desde el teléfono del titular o solicite hablar con un asesor.",
        }),
      };
    }
    const customerId = ctx.contact.id;
    const env = { pb, integrations: ctx.integrations, today: ctx.today, now: ctx.now };

    const { object: plan } = await timed(ctx, agent, "llm.billing.plan", { text: ctx.text }, () =>
      ctx.llm.generateObject({
        task: "billing.plan",
        system: billingPrompt(pb, todayLabel(pb, ctx.now), ctx.today),
        user: `Historial:\n${history(ctx.conv, 4)}\n\nÚltimo mensaje del cliente: ${ctx.text}`,
        schema: BillingPlanSchema,
        context: { text: ctx.text, today: ctx.today, intent: ctx.triage.intent, conv: ctx.conv },
      }),
    );

    let tool = plan.tool;
    if (tool === "none" && ctx.triage.intent === "payment_promise") tool = "register_payment_promise";
    if (tool === "register_payment_promise" && !pb.intents.enabled.includes("payment_promise")) tool = "get_balance";

    if (tool === "none") return answerFromKb(ctx, agent, ctx.text);

    if (tool === "get_balance") {
      const r = await runTool("get_balance", { customerId }, env, toolCalls);
      if (!r.ok) return { agent, resolved: false, toolCalls, facts: [], reply: errorReply(ctx) };
      const b = r.result as Balance;
      return { agent, resolved: true, toolCalls, facts: [JSON.stringify(b)], reply: balanceReply(ctx, b) };
    }

    // register_payment_promise. Argumentos con respaldo: si el cliente no dijo fecha/monto, el del modelo se descarta.
    if (plan.date && !mentionsDate(ctx.text)) {
      ctx.step({ agent, step: "arg_grounding", latencyMs: 0, output: { dropped: "date", value: plan.date } });
      plan.date = null;
    }
    if (plan.amount !== null && !mentionsAmount(ctx.text)) {
      ctx.step({ agent, step: "arg_grounding", latencyMs: 0, output: { dropped: "amount", value: plan.amount } });
      plan.amount = null;
    }
    if (!plan.date) {
      return {
        agent,
        resolved: false,
        toolCalls,
        facts: [],
        reply: say(pb, {
          vos: `Dale. ¿Qué día podrías pagar? Puedo registrar una promesa de hasta ${pb.billing.maxPromiseDays} días.`,
          usted: `Con gusto. ¿Qué día podría realizar el pago? Puedo registrar un compromiso de hasta ${pb.billing.maxPromiseDays} días.`,
        }),
      };
    }
    const bal = await runTool("get_balance", { customerId }, env, toolCalls);
    if (!bal.ok) return { agent, resolved: false, toolCalls, facts: [], reply: errorReply(ctx) };
    const balance = bal.result as Balance;
    if (balance.total <= 0) return { agent, resolved: true, toolCalls, facts: [JSON.stringify(balance)], reply: balanceReply(ctx, balance) };
    const amount = plan.amount ?? balance.total;
    const r = await runTool("register_payment_promise", { customerId, amount, date: plan.date }, env, toolCalls);
    const facts = [JSON.stringify(balance)];
    if (r.ok) {
      const p = r.result as PaymentPromise;
      ctx.conv.state.promiseRejections = 0;
      return {
        agent,
        resolved: true,
        toolCalls,
        facts: [...facts, JSON.stringify(p)],
        reply: say(pb, {
          vos: `Listo, registré tu promesa de pago por ${money(pb, p.amount)} para el ${prettyDate(pb, p.date)}. Número de gestión: ${p.id}. Mientras se cumpla, no se suspende el servicio.`,
          usted: `Listo, registré su compromiso de pago por ${money(pb, p.amount)} para el ${prettyDate(pb, p.date)}. Número de gestión: ${p.id}. Mientras se cumpla, el servicio no se suspende.`,
        }),
      };
    }
    const code = r.error.replace("out_of_policy:", "");
    if (!r.error.startsWith("out_of_policy:")) return { agent, resolved: false, toolCalls, facts, reply: errorReply(ctx) };
    const rejections = (ctx.conv.state.promiseRejections ?? 0) + 1;
    ctx.conv.state.promiseRejections = rejections;
    if (NEGOTIABLE.has(code) && rejections < 2) {
      return {
        agent,
        resolved: false,
        toolCalls,
        facts,
        reply: say(pb, {
          vos: `Para registrarla automáticamente, la promesa tiene que ser por el total (${money(pb, balance.total)}) y dentro de los próximos ${pb.billing.maxPromiseDays} días. ¿Te sirve alguna fecha dentro de ese plazo?`,
          usted: `Para registrarlo automáticamente, el compromiso debe ser por el total (${money(pb, balance.total)}) y dentro de los próximos ${pb.billing.maxPromiseDays} días. ¿Le resulta posible una fecha dentro de ese plazo?`,
        }),
      };
    }
    return { agent, resolved: false, toolCalls, facts, outOfPolicy: code, reply: "" };
  },
};

function balanceReply(ctx: AgentContext, b: Balance): string {
  const { pb } = ctx;
  if (b.total <= 0) {
    return say(pb, {
      vos: `No tenés deuda pendiente. Tu próxima factura vence el ${prettyDate(pb, b.nextDueDate)}.`,
      usted: `Usted no registra deuda pendiente. Su próximo recibo vence el ${prettyDate(pb, b.nextDueDate)}.`,
    });
  }
  const detail = b.invoices
    .filter((i) => !i.paid)
    .map((i) => `• ${i.period}: ${money(pb, i.amount)} (venció el ${prettyDate(pb, i.dueDate)})`)
    .join("\n");
  const canPromise = pb.intents.enabled.includes("payment_promise");
  return say(pb, {
    vos: `Tu saldo pendiente es de ${money(pb, b.total)}, con ${b.overdueDays} días de atraso.\n${detail}${canPromise ? "\nSi no podés pagar hoy, decime qué día podrías y registro una promesa de pago." : ""}`,
    usted: `Su saldo pendiente es de ${money(pb, b.total)}, con ${b.overdueDays} días de atraso.\n${detail}${canPromise ? "\nSi no puede pagar hoy, indíqueme qué día podría y registro un compromiso de pago." : ""}`,
  });
}

function errorReply(ctx: AgentContext) {
  return say(ctx.pb, {
    vos: "Tuve un problema para consultar tu cuenta. Probá de nuevo en unos minutos o pedime hablar con una persona.",
    usted: "Tuve un inconveniente para consultar su cuenta. Inténtelo nuevamente en unos minutos o solicite hablar con un asesor.",
  });
}
