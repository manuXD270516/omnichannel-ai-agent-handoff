import { generateValidated, type LLMProvider, type ObjectRequest, type ObjectResult, type TextRequest } from "./provider";

/** Ollama local (`/api/chat`) con salida estructurada vía `format` = JSON Schema. */
export class OllamaProvider implements LLMProvider {
  readonly name: string;
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 120_000,
  ) {
    this.name = `ollama:${model}`;
  }

  private async chat(system: string, user: string, format?: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format,
        // num_predict acota salidas degeneradas (repeticiones) que si no terminan en timeout.
        options: { temperature: 0, num_ctx: 4096, num_predict: 512 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    return generateValidated(req, (s, u, schema) => this.chat(s, u, schema));
  }

  async generateText(req: TextRequest): Promise<string> {
    return (await this.chat(req.system, req.user)).trim();
  }
}

/**
 * Proveedor compatible con la API de OpenAI (OpenAI, Azure, vLLM, etc.).
 * Opcional y apagado por defecto: solo se activa con LLM_PROVIDER=openai y una clave.
 * No se probó con claves reales en este repo.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    this.name = `openai:${model}`;
  }

  private async chat(system: string, user: string, schema?: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "output", schema } } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content ?? "";
  }

  generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    return generateValidated(req, (s, u, schema) => this.chat(s, u, schema));
  }
  async generateText(req: TextRequest): Promise<string> {
    return (await this.chat(req.system, req.user)).trim();
  }
}

/**
 * Proveedor de Anthropic (Messages API). Opcional y apagado por defecto:
 * solo se activa con LLM_PROVIDER=anthropic y ANTHROPIC_API_KEY. No se probó con claves reales en este repo.
 * La salida estructurada se fuerza con una tool única cuyo input_schema es el schema zod.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `anthropic:${model}`;
  }

  private async call(body: Record<string, unknown>) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, temperature: 0, ...body }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    return (await res.json()) as { content: { type: string; text?: string; input?: unknown }[] };
  }

  generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    return generateValidated(req, async (system, user, schema) => {
      const data = await this.call({
        system,
        messages: [{ role: "user", content: user }],
        tools: [{ name: "output", description: "Devolvé el resultado estructurado", input_schema: schema }],
        tool_choice: { type: "tool", name: "output" },
      });
      const block = data.content.find((b) => b.type === "tool_use");
      return JSON.stringify(block?.input ?? {});
    });
  }

  async generateText(req: TextRequest): Promise<string> {
    const data = await this.call({ system: req.system, messages: [{ role: "user", content: req.user }] });
    return data.content.map((b) => b.text ?? "").join("").trim();
  }
}
