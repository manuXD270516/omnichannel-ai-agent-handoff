/**
 * Guardrail/policy agent. Es código determinístico a propósito: las reglas que
 * protegen al cliente y a la empresa no dependen de que un modelo "se porte bien".
 */

export interface PiiResult {
  redacted: string;
  found: string[];
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PII_RULES: { type: string; re: RegExp; check?: (m: string) => boolean; label: string }[] = [
  { type: "card", re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, "")), label: "[TARJETA]" },
  { type: "cvv", re: /\b(cvv|cvc|c[oó]digo de seguridad)\s*[:=]?\s*\d{3,4}\b/gi, label: "[CVV]" },
  { type: "password", re: /\b(mi\s+)?(clave|contrase[nñ]a|password|pin)\s+(es|:)\s*\S+/gi, label: "[CLAVE]" },
  { type: "tax_id", re: /\b(20|23|24|27|30|33|34)-?\d{8}-?\d\b/g, label: "[CUIT]" },
  { type: "national_id", re: /\b(dni|documento|doc\.?|ruc|ce)\b\s*(es\s+|n[°ºo.]*\s*|nro\.?\s*|n[uú]mero\s*)?[:#]?\s*\d{1,2}\.?\d{3}\.?\d{3}\b/gi, label: "[DOC]" },
  { type: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, label: "[EMAIL]" },
  { type: "phone", re: /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]\d{4}\b/g, label: "[TEL]" },
];

export function redactPii(text: string): PiiResult {
  const found = new Set<string>();
  let out = text;
  for (const rule of PII_RULES) {
    out = out.replace(rule.re, (m) => {
      if (rule.check && !rule.check(m)) return m;
      found.add(rule.type);
      return rule.label;
    });
  }
  return { redacted: out, found: [...found] };
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignor[aáeé]\w*\s+(todas\s+)?(las\s+|tus\s+|mis\s+)?(instrucciones|reglas|indicaciones)/i,
  /olvid[aáeé]\w*\s+(todas\s+)?(las\s+|tus\s+)?(instrucciones|reglas)/i,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)?\s*instructions/i,
  /(system|developer)\s*prompt|prompt\s+del\s+sistema|tus\s+instrucciones\s+internas/i,
  /modo\s+(desarrollador|dios|admin(istrador)?)|developer\s+mode|jailbreak|\bDAN\b/i,
  /\b(ahora\s+sos|ahora\s+eres|you\s+are\s+now|a\s+partir\s+de\s+ahora\s+(sos|eres))\b/i,
  /actu[aá]\s+como\s+(si\s+fueras\s+)?(un\s+)?(admin|supervisor|gerente|otro|el\s+sistema)/i,
  /<\/?\s*(system|assistant|instructions?)\s*>|\[\s*(system|admin)\s*\]/i,
  /revel[aá]\w*\s+(tu|el|las)\s+(prompt|instrucciones|configuraci[oó]n)/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Pedido explícito de hablar con una persona: lo detecta el router y, como red de seguridad, también esta regla. */
export function detectsHumanRequest(text: string): boolean {
  return /\b(hablar|comunicar(me)?|pasame|p[aá]seme|quiero|necesito|deriv[aá]me)\b.{0,30}\b(persona|humano|operador|operadora|asesor|asesora|agente humano|alguien real|representante)\b/i.test(
    text,
  ) || /\b(operador|asesor|humano)\s*(por favor|ya)\b/i.test(text);
}

/** Canario incluido en los prompts de sistema: si aparece en una respuesta, hubo fuga del prompt. */
export const PROMPT_CANARY = "cnry-7f3a91";

const COMMITMENT = /\b(bonific\w*|condon\w*|descuento\w*|reintegr\w*|devoluci[oó]n de (su |tu )?dinero|anul\w* la deuda|gratis)\b/i;

function normNumber(raw: string): number | null {
  let s = raw.replace(/[^\d.,]/g, "").replace(/[.,]+$/, "");
  if (!s) return null;
  // "18.450" / "18.450,50" (es) o "129.90" / "1,234.50" (en)
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(\.|$)/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const AMOUNT_RE = /(?:\$|S\/|ARS|PEN|USD)\s?\d[\d.,]*|\d[\d.,]*\s?(?:pesos|soles|ARS|PEN)\b/gi;

export function extractAmounts(text: string): number[] {
  return [...text.matchAll(AMOUNT_RE)].map((m) => normNumber(m[0])).filter((n): n is number => n !== null);
}

/**
 * Grounding de argumentos: un tool con efecto (ej. registrar una promesa) solo puede usar
 * una fecha si el cliente mencionó alguna. Evita que el modelo "complete" datos que nadie dijo.
 */
export function mentionsDate(text: string): boolean {
  return /\b(hoy|manana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de mes|semana|quincena|dias?|\d{1,2}\/\d{1,2}|\d{1,2} de [a-z]+|el \d{1,2}|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(
    normalize(text),
  );
}

export function mentionsAmount(text: string): boolean {
  return /\d/.test(text) || /\b(mil|todo|total)\b/.test(normalize(text));
}

export interface OutputCheck {
  text: string;
  flags: string[];
  /** true si la respuesta no puede salir y hay que derivar. */
  blocked: boolean;
}

/**
 * Revisa la respuesta del agente antes de enviarla.
 * `facts` = todo lo que el agente legítimamente sabe en este turno (resultados de tools, pasajes de KB).
 */
export function checkOutput(reply: string, facts: string[], allowCommitment = false): OutputCheck {
  const flags: string[] = [];
  let text = reply;
  if (text.includes(PROMPT_CANARY)) {
    flags.push("prompt_leak");
  }
  const pii = redactPii(text);
  if (pii.found.some((t) => t !== "phone")) {
    flags.push("pii_in_output");
    text = pii.redacted;
  }
  const factText = facts.join(" ");
  const known = new Set(extractAmounts(factText).map((n) => n.toFixed(2)));
  for (const n of [...factText.matchAll(/\d[\d.,]*/g)].map((m) => normNumber(m[0]))) if (n !== null) known.add(n.toFixed(2));
  const unsupported = extractAmounts(text).filter((n) => !known.has(n.toFixed(2)));
  if (unsupported.length > 0) flags.push("unsupported_amount");
  if (!allowCommitment && COMMITMENT.test(text) && !COMMITMENT.test(factText)) flags.push("unauthorized_commitment");
  const blocked = flags.some((f) => f === "prompt_leak" || f === "unsupported_amount" || f === "unauthorized_commitment");
  return { text, flags, blocked };
}

/** Groundedness léxica: proporción de palabras de contenido de la respuesta presentes en los pasajes citados. */
export function supportScore(answer: string, passages: string[]): number {
  const words = contentWords(answer);
  if (words.length === 0) return 0;
  const bag = new Set(contentWords(passages.join(" ")));
  return words.filter((w) => bag.has(w)).length / words.length;
}

const STOP = new Set(
  "a al algo ante antes como con contra cual cuando de del desde donde durante el ella ellas ellos en entre era es esa ese eso esta este esto estos fue ha hace hacer hasta hay la las le les lo los mas me mi mis muy no nos o para pero por porque que se sea segun ser si sin sobre son su sus te tenes tiene tu tus un una uno unos usted y ya yo vos podes puede puedes puedo poner hago tengo quiero necesito hola gracias bien favor".split(
    " ",
  ),
);

export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function stem(w: string): string {
  return w.replace(/(aciones|amiento|imiento|mente|ciones|cion|ando|iendo|ados|idas|idos|adas|ado|ido|ada|ida|ar|er|ir|es|s|a|o|e)$/, "");
}

export function contentWords(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1);
}
