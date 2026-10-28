import { normalize } from "../guardrail";
import { say } from "../format";
import type { Intent } from "../types";
import { billingAgent } from "./billing";
import { answerFromKb } from "./knowledge";
import { schedulingAgent } from "./scheduling";
import type { AgentContext, AgentResult, SpecialistAgent } from "./types";

/** Soporte técnico: RAG con citas + diagnóstico guiado que puede terminar en ofrecer una visita. */
export const techAgent: SpecialistAgent = {
  name: "tech_support",
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prev = ctx.conv.messages.filter((m) => m.role === "customer").slice(-2, -1)[0]?.text ?? "";
    // Mensajes cortos ("sigue igual") se enriquecen con el anterior para recuperar mejor.
    const query = ctx.text.split(/\s+/).length < 6 ? `${prev} ${ctx.text}` : ctx.text;
    const r = await answerFromKb(ctx, "tech_support", query);
    const citedVisit = r.facts.some((f) => normalize(f).includes("visita tecnica"));
    if (!r.rag?.abstained && citedVisit && ctx.pb.intents.enabled.includes("schedule_visit")) {
      ctx.conv.state.visitOffered = true;
      const offer = say(ctx.pb, {
        vos: "¿Querés que te agende una visita técnica?",
        usted: "¿Desea que le programe una visita técnica?",
      });
      const [answer, source] = r.reply.split("\n\nFuente: ");
      r.reply = `${answer} ${offer}\n\nFuente: ${source}`;
    }
    return r;
  },
};

/** Retención/baja: nunca la resuelve la IA. Deja todo listo para el equipo de retención. */
export const retentionAgent: SpecialistAgent = {
  name: "retention",
  async run(): Promise<AgentResult> {
    return {
      agent: "retention",
      reply: "",
      resolved: false,
      toolCalls: [],
      facts: [],
      handoff: { reason: "always_human_intent", detail: "Pedido de baja: lo gestiona retención" },
    };
  },
};

export const smalltalkAgent: SpecialistAgent = {
  name: "smalltalk",
  async run(ctx: AgentContext): Promise<AgentResult> {
    const name = ctx.contact?.name.split(" ")[0];
    const greeting = ctx.triage.intent === "greeting";
    const menu = say(ctx.pb, {
      vos: "Puedo ayudarte con tu deuda o factura, promesas de pago, fallas técnicas y visitas técnicas.",
      usted: "Puedo ayudarle con su deuda o recibo, fallas técnicas y visitas técnicas.",
    });
    if (greeting) {
      const persona = ctx.pb.tone.signature?.split(" · ")[0] ?? "el asistente virtual";
      return {
        agent: "smalltalk",
        resolved: true,
        toolCalls: [],
        facts: [],
        reply: say(ctx.pb, {
          vos: `¡Hola${name ? ` ${name}` : ""}! Soy ${persona}, la asistente virtual de ${ctx.pb.tenant.name}. ${menu} ¿Qué necesitás?`,
          usted: `Buenos días${name ? `, ${name}` : ""}. Le saluda ${persona}, asistente virtual de ${ctx.pb.tenant.name}. ${menu} ¿En qué puedo ayudarle?`,
        }),
      };
    }
    return {
      agent: "smalltalk",
      resolved: false,
      toolCalls: [],
      facts: [],
      reply: say(ctx.pb, {
        vos: `No estoy segura de haber entendido. ${menu} ¿Me contás un poco más?`,
        usted: `Disculpe, no estoy seguro de haber entendido. ${menu} ¿Podría darme más detalle?`,
      }),
    };
  },
};

export const SPECIALISTS: Record<Intent, SpecialistAgent> = {
  billing_inquiry: billingAgent,
  payment_promise: billingAgent,
  tech_support: techAgent,
  schedule_visit: schedulingAgent,
  cancellation: retentionAgent,
  greeting: smalltalkAgent,
  other: smalltalkAgent,
};
