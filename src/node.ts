import { serve } from "@hono/node-server";
import { TENANTS } from "./generated/tenants";
import { buildRuntime } from "./runtime";
import { MemoryStore } from "./store/store";
import { createSqliteStore } from "./store/sqlite";
import type { AppEnv } from "./config";

const env = process.env as AppEnv & { PORT?: string; DB_PATH?: string };
const port = Number(env.PORT ?? 8790);
const store = env.DB_PATH === "memory" ? new MemoryStore() : await createSqliteStore(env.DB_PATH ?? "data/app.db");
const { app, engine } = buildRuntime({ env, store, tenants: TENANTS });

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Servidor en http://127.0.0.1:${port} · proveedor LLM: ${engine.llmName} · dashboard: http://127.0.0.1:${port}/dashboard`);
});
