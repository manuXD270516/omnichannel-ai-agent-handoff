import { z } from "zod";
import { supportScore } from "../guardrail";
import { techPrompt, history } from "../prompts";
import { say } from "../format";
import type { AgentContext, AgentResult } from "./types";
import { timed } from "./types";

export const KbAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
  abstain: z.boolean(),
});

const MIN_SUPPORT = 0.5;

/**
 * RAG con citas y abstención. Tres compuertas: (1) score mínimo de recuperación,
 * (2) citas que existan entre los pasajes recuperados, (3) soporte léxico de la respuesta.
 * Si alguna falla, el agente se abstiene en vez de improvisar.
 */
export async function answerFromKb(ctx: AgentContext, agent: string, query: string): Promise<AgentResult> {
  const retrieved = await timed(ctx, agent, "search_kb", { query }, async () => ctx.kb.search(query, ctx.pb.kb.topK));
  const toolCalls = [{ name: "search_kb", args: { query }, ok: true, result: retrieved.map((r) => ({ id: r.id, score: r.score })), latencyMs: 0 }];
  const retrievedIds = retrieved.map((r) => r.id);
  const abstainReply = say(ctx.pb, {
    vos: "No tengo información confirmada sobre eso en mi base de conocimiento, así que prefiero no adivinar. ¿Querés que lo vea una persona del equipo?",
    usted: "No cuento con información confirmada sobre ese tema en nuestra base de conocimiento y prefiero no darle un dato incorrecto. ¿Desea que lo revise un asesor?",
  });
  const abstain = (): AgentResult => ({
    agent,
    reply: abstainReply,
    resolved: false,
    toolCalls,
    facts: [],
    rag: { citations: [], retrieved: retrievedIds, abstained: true, grounded: true },
  });

  const best = retrieved[0];
  if (!best || best.score < ctx.pb.kb.minScore) return abstain();

  const passages = retrieved.map((r) => `[${r.id}] ${r.docTitle} — ${r.heading}: ${r.text}`).join("\n");
  // Decodificación restringida: las citas solo pueden ser ids recuperados, como máximo 3.
  // Sin esto, qwen2.5:7b repetía ids inventados hasta agotar tokens (ver ADR 0004).
  const schema = z.object({
    answer: z.string(),
    citations: z.array(z.enum(retrievedIds as [string, ...string[]])).max(3),
    abstain: z.boolean(),
  });
  let object: z.infer<typeof KbAnswerSchema>;
  try {
    ({ object } = await timed(ctx, agent, "llm.tech.answer", { retrieved: retrievedIds }, () =>
      ctx.llm.generateObject({
        task: "tech.answer",
        system: techPrompt(ctx.pb),
        user: `Pasajes:\n${passages}\n\nHistorial:\n${history(ctx.conv, 4)}\n\nPregunta del cliente: ${query}`,
        schema,
        context: { query, retrieved, pb: ctx.pb, conv: ctx.conv },
      }),
    ));
  } catch (e) {
    // Degradación segura: si el modelo falla, se abstiene (y cuenta como turno sin resolver).
    ctx.step({ agent, step: "llm_error_abstain", latencyMs: 0, output: (e as Error).message });
    return abstain();
  }
  if (object.abstain || !object.answer.trim()) return abstain();

  const citations = object.citations.filter((c) => retrievedIds.includes(c));
  const cited = retrieved.filter((r) => citations.includes(r.id));
  const support = supportScore(object.answer, cited.map((r) => `${r.heading} ${r.text}`));
  const grounded = cited.length > 0 && support >= MIN_SUPPORT;
  ctx.step({ agent, step: "groundedness", latencyMs: 0, output: { citations, support: Number(support.toFixed(2)), grounded } });
  if (!grounded) {
    return { ...abstain(), rag: { citations, retrieved: retrievedIds, abstained: true, grounded: false } };
  }
  const source = cited.map((r) => `${r.docTitle} › ${r.heading}`).join("; ");
  return {
    agent,
    reply: `${object.answer.trim()}\n\nFuente: ${source}`,
    resolved: true,
    toolCalls,
    facts: cited.map((r) => r.text),
    rag: { citations, retrieved: retrievedIds, abstained: false, grounded: true },
  };
}
