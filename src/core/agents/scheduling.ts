import { z } from "zod";
import { history, schedulingPrompt } from "../prompts";
import { prettySlot, say } from "../format";
import { runTool } from "../tools";
import type { Booking, Slot } from "../../integrations/types";
import type { ToolCallRecord } from "../types";
import type { AgentContext, AgentResult, SpecialistAgent } from "./types";
import { timed } from "./types";

export const SchedulingPlanSchema = z.object({
  action: z.enum(["list_slots", "book_slot", "none"]),
  slotChoice: z.number().int().nullable(),
});

export const schedulingAgent: SpecialistAgent = {
  name: "scheduling",
  async run(ctx: AgentContext): Promise<AgentResult> {
    const agent = "scheduling";
    const { pb, conv } = ctx;
    const toolCalls: ToolCallRecord[] = [];
    const duration = pb.integrations.calendar.visitDurationMin;
    if (!ctx.contact) {
      return {
        agent,
        resolved: false,
        toolCalls,
        facts: [],
        reply: say(pb, {
          vos: "Para agendar una visita necesito que nos escribas desde el teléfono del titular de la cuenta.",
          usted: "Para programar una visita necesito que nos escriba desde el teléfono del titular de la cuenta.",
        }),
      };
    }
    const offered = conv.state.offeredSlots ?? [];
    const offeredList = offered.map((s, i) => `${i + 1}) ${s.label}`).join("\n");
    const { object: plan } = await timed(ctx, agent, "llm.scheduling.plan", { text: ctx.text, offered: offered.length }, () =>
      ctx.llm.generateObject({
        task: "scheduling.plan",
        system: schedulingPrompt(pb),
        user: `Turnos ofrecidos:\n${offeredList || "(ninguno todavía)"}\n\nHistorial:\n${history(conv, 4)}\n\nÚltimo mensaje del cliente: ${ctx.text}`,
        schema: SchedulingPlanSchema,
        context: { text: ctx.text, offered, conv },
      }),
    );
    const env = { pb, integrations: ctx.integrations, today: ctx.today, now: ctx.now };

    const choice = plan.slotChoice;
    if (plan.action === "book_slot" && offered.length > 0 && choice && choice >= 1 && choice <= offered.length) {
      const slot = offered[choice - 1]!;
      const r = await runTool("book_visit", { customerId: ctx.contact.id, slotId: slot.id, reason: "Falla técnica" }, env, toolCalls);
      if (r.ok) {
        const b = r.result as Booking;
        conv.state.offeredSlots = undefined;
        conv.state.visitOffered = false;
        return {
          agent,
          resolved: true,
          toolCalls,
          facts: [JSON.stringify(b)],
          reply: say(pb, {
            vos: `Listo, agendé la visita técnica para el ${slot.label}. Número de visita: ${b.id}. Va a ir un técnico identificado; tiene que haber un mayor de edad en el domicilio.`,
            usted: `Listo, programé la visita técnica para el ${slot.label}. Número de visita: ${b.id}. Asistirá un técnico identificado; debe haber una persona mayor de edad en el domicilio.`,
          }),
        };
      }
      conv.state.offeredSlots = undefined;
    }

    if (plan.action === "book_slot" && offered.length > 0 && !(choice && choice >= 1 && choice <= offered.length)) {
      return {
        agent,
        resolved: false,
        toolCalls,
        facts: [],
        reply: say(pb, {
          vos: `¿Cuál de estos turnos te queda mejor? Respondé con el número:\n${offeredList}`,
          usted: `¿Cuál de estos turnos le resulta más conveniente? Responda con el número:\n${offeredList}`,
        }),
      };
    }

    const r = await runTool("get_available_slots", { zone: ctx.contact.zone, limit: 3 }, env, toolCalls);
    const slots = r.ok ? (r.result as Slot[]) : [];
    if (slots.length === 0) {
      // Sin cobertura de agenda en la zona: no se resuelve sin un humano.
      return { agent, resolved: false, toolCalls, facts: [], outOfPolicy: "no_slots_in_zone", reply: "" };
    }
    conv.state.offeredSlots = slots.map((s) => ({ id: s.id, start: s.start, label: prettySlot(pb, s.start, duration) }));
    const list = conv.state.offeredSlots.map((s, i) => `${i + 1}) ${s.label}`).join("\n");
    return {
      agent,
      resolved: true,
      toolCalls,
      facts: [JSON.stringify(slots)],
      reply: say(pb, {
        vos: `Tengo estos turnos para la visita técnica:\n${list}\nRespondé con el número del que prefieras.`,
        usted: `Tengo disponibles los siguientes turnos para la visita técnica:\n${list}\nResponda con el número del que prefiera.`,
      }),
    };
  },
};
