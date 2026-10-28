import type { Conversation, Intent, Triage } from "../core/types";
import type { Retrieved } from "../core/rag";
import { contentWords, detectsHumanRequest, normalize } from "../core/guardrail";
import { addDays } from "../core/format";
import type { LLMProvider, ObjectRequest, ObjectResult, TextRequest } from "./provider";

/**
 * Proveedor determinístico basado en reglas. NO es un modelo: es un doble de prueba
 * que implementa la misma interfaz para que tests, CI y la demo sean reproducibles
 * y gratis. Mide la orquestación, las políticas y los handoffs, no la calidad de un LLM
 * (eso lo mide la corrida con Ollama).
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";

  async generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    const ctx = req.context ?? {};
    let out: unknown;
    switch (req.task) {
      case "router":
        out = triage(String(ctx.text ?? ""), ctx.conv as Conversation);
        break;
      case "billing.plan":
        out = billingPlan(String(ctx.text ?? ""), String(ctx.today), ctx.intent as Intent);
        break;
      case "scheduling.plan":
        out = schedulingPlan(String(ctx.text ?? ""), (ctx.offered as { label: string }[]) ?? []);
        break;
      case "tech.answer":
        out = techAnswer(ctx.retrieved as Retrieved[], String(ctx.query ?? ""));
        break;
      default:
        throw new Error(`ScriptedProvider: tarea desconocida ${req.task}`);
    }
    return { object: req.schema.parse(out), attempts: 1 };
  }

  async generateText(req: TextRequest): Promise<string> {
    if (req.task !== "summary") return "";
    const ctx = req.context as { reason: string; detail: string; brief: { intent: string; lastBalance?: { total: number; currency: string }; toolsUsed: string[]; lastCustomerMessage: string } };
    const b = ctx.brief;
    const parts = [
      `Cliente con consulta de tipo ${b.intent}; se deriva por ${ctx.reason} (${ctx.detail}).`,
      b.lastBalance ? `Saldo informado: ${b.lastBalance.total} ${b.lastBalance.currency}.` : "",
      b.toolsUsed.length ? `La IA ya usó: ${b.toolsUsed.join(", ")}.` : "La IA no ejecutó acciones en sistemas.",
      `Último mensaje: "${b.lastCustomerMessage}".`,
    ];
    return parts.filter(Boolean).join(" ");
  }
}

const has = (t: string, re: RegExp) => re.test(t);

const KW: Record<Exclude<Intent, "greeting" | "other">, RegExp> = {
  cancellation: /\b(dar(me)? de baja|darme de baja|la baja|baja del servicio|cancelar (el|mi) (servicio|contrato|plan)|me quiero ir|me voy a (ir|cambiar)|cambiarme a otra|rescindir|desconect\w+ el servicio|anular (el|mi) contrato)\b/,
  payment_promise: /\b(promesa de pago|compromiso de pago|(puedo|podria|quiero|voy a|te|le|recien|recién)\s+(pagar|abonar|pago)|pago el|pagaria|pagaré|pagare|abono el)\b/,
  billing_inquiry: /\b(deuda|debo|saldo|factura|recibo|vence|vencimiento|cuanto (tengo|pago|sale)|medios de pago|como (puedo )?pagar|donde pago|formas de pago|cobr\w+|recargo|mora|pagos?)\b/,
  schedule_visit: /\b(visita|tecnico|turno|agend\w+|coordinar|program\w+ una visita)\b/,
  tech_support: /\b(internet|wifi|wi-fi|conexion|router|modem|ont|lent\w*|se corta|luz|luces|luz (los|pon)|los (esta )?en rojo|sin senal|no (me )?(anda|funciona|navega|carga)|clave del wifi|contrasena del wifi|reinici\w*|velocidad|desconect\w+|se cae|caido)\b/,
};

const DATE_HINT = /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de mes|semana que viene|proxima semana|en \d+ dias|el \d{1,2}\b|\d{1,2}\/\d{1,2}|\d{1,2} de [a-z]+)/;

export function triage(raw: string, conv?: Conversation): Triage {
  const t = normalize(raw);
  const language = /\b(ola|obrigad\w|nao|voce|conta|minha|internet nao|estou)\b/.test(t) && !/\b(hola|tengo|no me)\b/.test(t)
    ? "pt"
    : /\b(hello|hi|my|please|bill|the|not working|i want)\b/.test(t) && !/\b(hola|mi|el|la)\b/.test(t)
      ? "en"
      : "es";

  const negative = /\b(harto|harta|podrid\w|desastre|verguenza|pesim\w|horrible|inutil|inutiles|mierda|indignad\w|cansad\w|enojad\w|furios\w|malisim\w|estafa|otra vez|una burla|me tienen|basta|nunca funciona|incompetentes)\b/.test(t) || /!!/.test(raw);
  const positive = /\b(gracias|genial|excelente|perfecto|buenisimo|barbaro|joya)\b/.test(t);
  const critical = /\b(chispa\w*|fuego|humo|incendio|electrocut\w*|cable (caido|cortado|colgando)|poste caido|respirador|oxigeno|emergencia medica)\b/.test(t);
  const high = /\b(urgente|trabajo desde (casa|mi casa)|hace (\d+|dos|tres|varios) dias|teletrabajo)\b/.test(t);

  const scores: [Intent, number][] = [];
  for (const [intent, re] of Object.entries(KW) as [Intent, RegExp][]) if (has(t, re)) scores.push([intent, 1]);
  const offered = conv?.state?.offeredSlots?.length ?? 0;
  const affirmative = /^(si|sí|dale|ok|okay|bueno|de una|por favor|si por favor|si, por favor|sí, por favor|perfecto|claro)[.!]*$/.test(t.trim());
  const slotPick =
    /^(el |la |opcion |turno )?(\d|primer\w*|segund\w*|tercer\w*|uno|dos|tres)\b/.test(t.trim()) ||
    /\b(el de las|la de las|a las \d)/.test(t) ||
    /^(el |la )?(lunes|martes|miercoles|jueves|viernes)\b/.test(t.trim());

  let intent: Intent;
  let confidence: number;
  if (has(t, KW.cancellation)) {
    intent = "cancellation";
    confidence = 0.92;
  } else if (offered > 0 && slotPick) {
    intent = "schedule_visit";
    confidence = 0.9;
  } else if (conv?.state?.visitOffered && affirmative) {
    intent = "schedule_visit";
    confidence = 0.85;
  } else if (has(t, KW.payment_promise) && (DATE_HINT.test(t) || /promesa|compromiso/.test(t))) {
    intent = "payment_promise";
    confidence = 0.88;
  } else if (has(t, KW.payment_promise) && conv?.state?.lastIntent && ["billing_inquiry", "payment_promise"].includes(conv.state.lastIntent)) {
    intent = "payment_promise";
    confidence = 0.8;
  } else if (DATE_HINT.test(t) && conv?.state?.lastIntent === "payment_promise" && t.split(/\s+/).length <= 6) {
    intent = "payment_promise";
    confidence = 0.8;
  } else if (has(t, KW.schedule_visit) && !has(t, /\b(no anda|no funciona|sin internet)\b/)) {
    intent = "schedule_visit";
    confidence = 0.86;
  } else if (has(t, KW.billing_inquiry)) {
    intent = "billing_inquiry";
    confidence = scores.length > 2 ? 0.6 : 0.9;
  } else if (has(t, KW.tech_support) || critical) {
    intent = "tech_support";
    confidence = 0.88;
  } else if (conv?.state?.lastIntent === "tech_support" && /\b(sigue|igual|ya (lo )?(hice|probe|reinicie)|nada|tampoco)\b/.test(t)) {
    intent = "tech_support";
    confidence = 0.75;
  } else if (/^(hola|buen(os|as)? (dia|dias|tarde|tardes|noche|noches)|buenas|que tal)\b/.test(t) && t.split(/\s+/).length <= 5) {
    intent = "greeting";
    confidence = 0.95;
  } else if (detectsHumanRequest(raw)) {
    intent = "other";
    confidence = 0.9;
  } else {
    intent = "other";
    confidence = 0.35;
  }
  if (language !== "es") confidence = Math.max(confidence, 0.7);

  return {
    intent,
    language,
    urgency: critical ? "critical" : high ? "high" : intent === "tech_support" ? "medium" : "low",
    sentiment: negative ? "negative" : positive ? "positive" : "neutral",
    confidence,
    wantsHuman: detectsHumanRequest(raw),
  };
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function parseDate(raw: string, today: string): string | null {
  const t = normalize(raw);
  const base = new Date(`${today}T12:00:00Z`);
  if (/\bpasado manana\b/.test(t)) return addDays(today, 2);
  if (/\bmanana\b/.test(t)) return addDays(today, 1);
  if (/\bhoy\b/.test(t)) return today;
  const inDays = t.match(/\ben (\d+) dias\b/);
  if (inDays) return addDays(today, Number(inDays[1]));
  if (/\b(semana que viene|proxima semana)\b/.test(t)) return addDays(today, 7);
  if (/\bfin de mes\b/.test(t)) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 12));
    return d.toISOString().slice(0, 10);
  }
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      let diff = (i - base.getUTCDay() + 7) % 7;
      if (diff === 0) diff = 7;
      return addDays(today, diff);
    }
  }
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const named = t.match(/\b(\d{1,2}) de ([a-z]+)\b/);
  const bare = t.match(/\bel (\d{1,2})\b(?!\s*(mil|pesos|soles|%))/);
  let day: number | undefined;
  let month: number | undefined;
  if (dm) [day, month] = [Number(dm[1]), Number(dm[2]) - 1];
  else if (named && MONTHS.includes(named[2]!)) [day, month] = [Number(named[1]), MONTHS.indexOf(named[2]!)];
  else if (bare) day = Number(bare[1]);
  if (day === undefined) return null;
  let year = base.getUTCFullYear();
  let m = month ?? base.getUTCMonth();
  if (month === undefined && day < base.getUTCDate()) m += 1;
  if (month !== undefined && month < base.getUTCMonth()) year += 1;
  return new Date(Date.UTC(year, m, day, 12)).toISOString().slice(0, 10);
}

export function parseAmount(raw: string): number | null {
  const t = normalize(raw);
  const mil = t.match(/\b(\d+(?:[.,]\d+)?)\s*mil\b/);
  if (mil) return Math.round(Number(mil[1]!.replace(",", ".")) * 1000);
  const m = t.match(/(?:\$|s\/|ars|pen)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:pesos|soles)\b|\b(\d{1,3}(?:\.\d{3})+|\d{4,})\b/);
  const s = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/\.\d{3}(\.|$)/.test(s)) return Number(s.replace(/\./g, ""));
  return Number(s.replace(/,/g, ""));
}

function billingPlan(raw: string, today: string, intent: Intent) {
  const t = normalize(raw);
  const date = parseDate(raw, today);
  if (intent === "payment_promise" || (KW.payment_promise.test(t) && date)) {
    return { tool: "register_payment_promise", amount: parseAmount(raw), date };
  }
  if (/\b(medios de pago|formas de pago|como (puedo )?pagar|donde (puedo )?pag\w+|recargo|mora|se suspende|suspension)\b/.test(t)) {
    return { tool: "none", amount: null, date: null };
  }
  return { tool: "get_balance", amount: null, date: null };
}

function schedulingPlan(raw: string, offered: { label: string }[]) {
  const t = normalize(raw).trim();
  if (offered.length === 0 || /\b(otro|otros|otra|otras) (horario|turno|dia)/.test(t)) return { action: "list_slots", slotChoice: null };
  const ord: Record<string, number> = { primer: 1, primero: 1, primera: 1, uno: 1, segundo: 2, segunda: 2, dos: 2, tercer: 3, tercero: 3, tercera: 3, tres: 3 };
  const num = t.match(/^(?:el |la |opcion |turno )?(\d)\b/);
  if (num) return { action: "book_slot", slotChoice: Number(num[1]) };
  for (const [w, n] of Object.entries(ord)) if (new RegExp(`\\b${w}\\b`).test(t)) return { action: "book_slot", slotChoice: n };
  const idx = offered.findIndex((s) => {
    const l = normalize(s.label);
    const day = WEEKDAYS.find((d) => t.includes(d));
    const hour = t.match(/\b(\d{1,2})(?::00)?\b/)?.[1];
    return (day ? l.includes(day) : true) && (hour ? l.includes(`de ${hour.padStart(2, "0")}:`) : true) && (day || hour);
  });
  if (idx >= 0) return { action: "book_slot", slotChoice: idx + 1 };
  if (/\b(si|dale|ok|visita|tecnico|agend\w+)\b/.test(t)) return { action: "list_slots", slotChoice: null };
  return { action: "book_slot", slotChoice: null };
}

/** Respuesta extractiva: las dos oraciones del mejor pasaje con más solapamiento con la pregunta, citándolo. */
function techAnswer(retrieved: Retrieved[], query: string) {
  const top = retrieved[0];
  if (!top) return { answer: "", citations: [], abstain: true };
  const sentences = top.text.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  const q = new Set(contentWords(query));
  const ranked = sentences
    .map((s, i) => ({ s, i, score: contentWords(s).filter((w) => q.has(w)).length }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i);
  return { answer: ranked.map((r) => r.s).join(" ").replace(/\s+/g, " ").trim(), citations: [top.id], abstain: false };
}
