import { z } from "zod";

export interface ObjectRequest<T> {
  /** Nombre de la tarea (router, billing.plan, tech.answer...). Sirve para trazas y para el proveedor scripted. */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Datos estructurados del turno. Los proveedores reales los ignoran (ya van en el prompt). */
  context?: Record<string, unknown>;
}

export interface TextRequest {
  task: string;
  system: string;
  user: string;
  context?: Record<string, unknown>;
}

export interface ObjectResult<T> {
  object: T;
  attempts: number;
}

export interface LLMProvider {
  readonly name: string;
  generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>>;
  generateText(req: TextRequest): Promise<string>;
}

export class LLMOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

/** JSON Schema a partir del schema zod, para salida estructurada nativa (Ollama `format`, OpenAI `json_schema`). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Extrae el primer objeto JSON de una respuesta (los modelos chicos a veces agregan texto alrededor). */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LLMOutputError("La respuesta no contiene JSON", raw);
  }
}

/**
 * Valida la salida contra el schema y reintenta una vez devolviendo el error al modelo.
 * Lo comparten todos los proveedores HTTP.
 */
export async function generateValidated<T>(
  req: ObjectRequest<T>,
  call: (system: string, user: string, jsonSchema: Record<string, unknown>) => Promise<string>,
  maxAttempts = 2,
): Promise<ObjectResult<T>> {
  const jsonSchema = toJsonSchema(req.schema);
  let user = req.user;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await call(req.system, user, jsonSchema);
    try {
      const parsed = req.schema.safeParse(extractJson(raw));
      if (parsed.success) return { object: parsed.data, attempts: attempt };
      lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      lastError = (e as Error).message;
    }
    user = `${req.user}\n\nTu respuesta anterior no cumplía el schema (${lastError}). Respondé solo con JSON válido.`;
  }
  throw new LLMOutputError(`Salida inválida para ${req.task}: ${lastError}`, lastError);
}
