import type { LLMProvider } from "./llm/provider";
import { ScriptedProvider } from "./llm/scripted";
import { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider } from "./llm/http-providers";

/** Variables de entorno comunes a Node y Workers. Ninguna es obligatoria para correr en local. */
export interface AppEnv {
  LLM_PROVIDER?: string; // scripted | ollama | openai | anthropic
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_MODE?: string; // mock | live
  DASHBOARD_TOKEN?: string;
  POST_CONVERSATION_WEBHOOK_URL?: string;
  ENABLE_SIMULATOR?: string;
}

/** Valores de desarrollo: públicos a propósito, solo sirven para el simulador local. */
export const DEV_DEFAULTS = {
  WHATSAPP_APP_SECRET: "dev-app-secret-not-real",
  WHATSAPP_VERIFY_TOKEN: "dev-verify-token",
};

export function createProvider(env: AppEnv): LLMProvider {
  switch (env.LLM_PROVIDER ?? "scripted") {
    case "scripted":
      return new ScriptedProvider();
    case "ollama":
      return new OllamaProvider(env.OLLAMA_URL ?? "http://127.0.0.1:11434", env.OLLAMA_MODEL ?? "qwen2.5:7b");
    case "openai":
      if (!env.OPENAI_API_KEY) throw new Error("LLM_PROVIDER=openai requiere OPENAI_API_KEY");
      return new OpenAICompatibleProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL ?? "gpt-4o-mini", env.OPENAI_BASE_URL);
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY");
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL ?? "claude-haiku-4-5");
    default:
      throw new Error(`LLM_PROVIDER desconocido: ${env.LLM_PROVIDER}`);
  }
}
