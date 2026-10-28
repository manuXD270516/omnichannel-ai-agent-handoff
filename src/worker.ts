import { TENANTS } from "./generated/tenants";
import { buildRuntime } from "./runtime";
import { SqlStore, d1Exec } from "./store/store";
import type { AppEnv } from "./config";

interface WorkerEnv extends AppEnv {
  DB: D1Database;
}

let runtime: ReturnType<typeof buildRuntime> | undefined;
let ready: Promise<void> | undefined;

/**
 * Entrada para Cloudflare Workers: mismo núcleo, store sobre D1.
 * Las integraciones mock viven en memoria del isolate (suficiente para demo);
 * en producción se reemplazan por los adaptadores reales del cliente.
 */
export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (!runtime) {
      const store = new SqlStore(d1Exec(env.DB));
      ready = store.init();
      runtime = buildRuntime({ env, store, tenants: TENANTS });
    }
    await ready;
    return runtime.app.fetch(req, env, ctx);
  },
};
