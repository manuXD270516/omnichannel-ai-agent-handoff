import { Hono } from "hono";
import { z } from "zod";
import { Engine, HttpError } from "./core/engine";
import { buildInboundWebhook, parseWebhook, signBody, verifyChallenge, verifySignature } from "./channels/whatsapp";
import { computeMetrics, toPrometheus } from "./core/metrics";
import type { Store } from "./store/store";
import { DEV_DEFAULTS, type AppEnv } from "./config";
import { DASHBOARD_HTML } from "./generated/dashboard";

export interface AppDeps {
  engine: Engine;
  store: Store;
  env: AppEnv;
}

const VoiceSchema = z.object({
  callId: z.string(),
  from: z.string(),
  utterance: z.string().min(1).optional(),
  utterances: z.array(z.string().min(1)).optional(),
});

/** Para TTS: sin viñetas ni líneas de fuente. */
function forSpeech(text: string) {
  return text
    .replace(/\n\nFuente:.*$/s, "")
    .replace(/^• /gm, "")
    .replace(/\n+/g, ". ");
}

export function createApp({ engine, store, env }: AppDeps) {
  const app = new Hono();
  const appSecret = env.WHATSAPP_APP_SECRET ?? DEV_DEFAULTS.WHATSAPP_APP_SECRET;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN ?? DEV_DEFAULTS.WHATSAPP_VERIFY_TOKEN;

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof z.ZodError) return c.json({ error: "payload_invalido", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/", (c) => c.redirect("/dashboard"));
  app.get("/health", (c) => c.json({ ok: true, provider: engine.llmName }));

  // ---- WhatsApp Cloud API ----
  app.get("/webhooks/whatsapp", (c) => {
    const challenge = verifyChallenge(new URL(c.req.url).searchParams, verifyToken);
    return challenge ? c.text(challenge) : c.text("forbidden", 403);
  });

  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    if (!(await verifySignature(appSecret, raw, c.req.header("x-hub-signature-256")))) {
      return c.json({ error: "firma_invalida" }, 401);
    }
    const { messages } = parseWebhook(JSON.parse(raw));
    const results = [];
    for (const m of messages) {
      // Idempotencia: Meta reintenta si no respondemos 200 a tiempo.
      if (!(await store.markProcessed(m.messageId))) continue;
      const tenant = engine.tenantByPhoneNumberId(m.phoneNumberId);
      if (!tenant) continue;
      if (m.text === null) {
        results.push({ messageId: m.messageId, ignored: m.type });
        continue;
      }
      const out = await engine.handleInbound({ tenantId: tenant.playbook.tenant.id, channel: "whatsapp", contactId: m.from, text: m.text, profileName: m.profileName });
      results.push({ messageId: m.messageId, conversationId: out.conversation.id, decision: out.decision, replies: out.replies.length });
    }
    // Meta solo necesita un 200; el detalle sirve para el simulador y los tests.
    return c.json({ ok: true, results });
  });

  // ---- Voz: transcripción de llamada (ASR externo) → mismo pipeline ----
  app.post("/channels/voice/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const pb = engine.tenant(tenantId).playbook;
    if (!pb.channels.voice?.enabled) return c.json({ error: "voz_deshabilitada" }, 404);
    const body = VoiceSchema.parse(await c.req.json());
    const utterances = body.utterances ?? (body.utterance ? [body.utterance] : []);
    const turns = [];
    for (const u of utterances) {
      const out = await engine.handleInbound({ tenantId, channel: "voice", contactId: body.from, text: u });
      const transfer = out.decision.action === "handoff" || out.conversation.status !== "ai";
      turns.push({ utterance: u, say: out.replies.map(forSpeech).join(" "), action: transfer ? "transfer" : "continue", transferTo: transfer ? pb.channels.voice?.transferNumber : undefined, conversationId: out.conversation.id, decision: out.decision });
      if (transfer) break;
    }
    return c.json({ callId: body.callId, turns });
  });

  // ---- Simulador local de WhatsApp: arma y FIRMA un webhook real y lo manda al endpoint de arriba ----
  if (env.ENABLE_SIMULATOR !== "false") {
    app.post("/simulator/whatsapp/:tenantId", async (c) => {
      const pb = engine.tenant(c.req.param("tenantId")).playbook;
      const { from, text, name } = z.object({ from: z.string(), text: z.string().min(1), name: z.string().optional() }).parse(await c.req.json());
      const wa = pb.channels.whatsapp;
      if (!wa) return c.json({ error: "whatsapp_no_configurado" }, 400);
      const payload = JSON.stringify(buildInboundWebhook({ phoneNumberId: wa.phoneNumberId, displayPhone: wa.displayPhone, from: from.replace(/\D/g, ""), name, text }));
      const before = (await store.listOutbound({ to: from.replace(/\D/g, "") })).length;
      const res = await app.request("/webhooks/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": await signBody(appSecret, payload) },
        body: payload,
      }, env);
      const outbox = (await store.listOutbound({ to: from.replace(/\D/g, "") })).slice(before);
      return c.json({ webhook: await res.json(), outbound: outbox });
    });
  }

  // ---- API de la bandeja humana y observabilidad ----
  const api = new Hono();
  api.use("*", async (c, next) => {
    if (env.DASHBOARD_TOKEN && c.req.header("authorization") !== `Bearer ${env.DASHBOARD_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  api.get("/tenants", (c) => c.json(engine.listTenants().map((t) => t.playbook)));
  api.get("/conversations", async (c) => {
    const status = c.req.query("status") as never;
    const tenantId = c.req.query("tenant") || undefined;
    return c.json(await store.listConversations({ status: status || undefined, tenantId }));
  });
  api.get("/conversations/:id", async (c) => {
    const conv = await store.getConversation(c.req.param("id"));
    return conv ? c.json(conv) : c.json({ error: "not_found" }, 404);
  });
  api.get("/conversations/:id/traces", async (c) => c.json(await store.listTraces(c.req.param("id"))));
  const Agent = z.object({ agent: z.string().min(1).max(60) });
  api.post("/conversations/:id/claim", async (c) => c.json(await engine.claim(c.req.param("id"), Agent.parse(await c.req.json()).agent)));
  api.post("/conversations/:id/reply", async (c) => {
    const b = Agent.extend({ text: z.string().min(1).max(4000) }).parse(await c.req.json());
    return c.json(await engine.humanReply(c.req.param("id"), b.agent, b.text));
  });
  api.post("/conversations/:id/release", async (c) => c.json(await engine.release(c.req.param("id"), Agent.parse(await c.req.json()).agent)));
  api.post("/conversations/:id/close", async (c) => c.json(await engine.close(c.req.param("id"), Agent.parse(await c.req.json()).agent)));
  api.get("/outbound", async (c) => c.json(await store.listOutbound({ to: c.req.query("to") || undefined })));
  api.get("/metrics", async (c) => c.json(computeMetrics(await store.listConversations())));
  app.route("/api", api);

  app.get("/metrics", async (c) => c.text(toPrometheus(computeMetrics(await store.listConversations()))));
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));
  return app;
}
