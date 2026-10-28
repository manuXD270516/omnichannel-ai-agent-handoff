import { afterEach, describe, expect, it, vi } from "vitest";
import { TENANTS } from "../../src/generated/tenants";
import { buildRuntime } from "../../src/runtime";
import { MemoryStore } from "../../src/store/store";
import { buildInboundWebhook, signBody } from "../../src/channels/whatsapp";
import { DEV_DEFAULTS, type AppEnv } from "../../src/config";
import type { Conversation, OutboundMessage } from "../../src/core/types";

const LUCIA = "5491155550101";
const wa = TENANTS.fibrasur!.playbook.channels.whatsapp!;

function setup(env: AppEnv = {}, start = "2026-10-27T15:00:00Z") {
  let now = new Date(start);
  const store = new MemoryStore();
  const rt = buildRuntime({ env, store, tenants: TENANTS, now: () => now });
  return { ...rt, store, setNow: (iso: string) => (now = new Date(iso)) };
}

async function sendWhatsApp(app: ReturnType<typeof setup>["app"], text: string, opts: { from?: string; id?: string; secret?: string } = {}) {
  const body = JSON.stringify(buildInboundWebhook({ phoneNumberId: wa.phoneNumberId, displayPhone: wa.displayPhone, from: opts.from ?? LUCIA, text, id: opts.id }));
  return app.request("/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signBody(opts.secret ?? DEV_DEFAULTS.WHATSAPP_APP_SECRET, body) },
    body,
  });
}

const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => vi.unstubAllGlobals());

describe("webhook de WhatsApp", () => {
  it("responde el challenge de verificación", async () => {
    const { app } = setup();
    const ok = await app.request(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${DEV_DEFAULTS.WHATSAPP_VERIFY_TOKEN}&hub.challenge=4242`);
    expect(await ok.text()).toBe("4242");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=1")).status).toBe(403);
  });

  it("mensaje firmado → respuesta en formato Cloud API", async () => {
    const { app, store } = setup();
    const res = await sendWhatsApp(app, "¿Cuánto debo?");
    expect(res.status).toBe(200);
    const out = (await store.listOutbound({ to: LUCIA })) as OutboundMessage[];
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ messaging_product: "whatsapp", to: LUCIA, type: "text" });
    expect(out[0]!.text).toContain("18.450");
  });

  it("rechaza firmas inválidas y no procesa nada", async () => {
    const { app, store } = setup();
    const res = await sendWhatsApp(app, "hola", { secret: "otro-secreto" });
    expect(res.status).toBe(401);
    expect(await store.listConversations()).toHaveLength(0);
  });

  it("es idempotente ante reintentos de Meta (mismo wamid)", async () => {
    const { app, store } = setup();
    await sendWhatsApp(app, "¿Cuánto debo?", { id: "wamid.REPETIDO" });
    await sendWhatsApp(app, "¿Cuánto debo?", { id: "wamid.REPETIDO" });
    expect(await store.listOutbound({ to: LUCIA })).toHaveLength(1);
  });

  it("el simulador arma, firma y procesa un webhook real", async () => {
    const { app } = setup();
    const res = await post(app, "/simulator/whatsapp/fibrasur", { from: "+5491155550102", text: "Quiero saber si tengo deuda" });
    const data = (await res.json()) as { outbound: OutboundMessage[] };
    expect(data.outbound[0]!.text).toContain("No tenés deuda");
  });
});

describe("handoff → toma humana → devolución a la IA", () => {
  it("recorre el ciclo completo", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const { app, store } = setup({ POST_CONVERSATION_WEBHOOK_URL: "http://127.0.0.1:9/hook" });

    await sendWhatsApp(app, "¿Cuánto debo?");
    await sendWhatsApp(app, "No entiendo la factura, quiero hablar con una persona");

    const queue = (await (await app.request("/api/conversations?status=pending_human")).json()) as Conversation[];
    expect(queue).toHaveLength(1);
    const conv = queue[0]!;
    expect(conv.handoff).toMatchObject({ reason: "explicit_request", withinBusinessHours: true });
    expect(conv.handoff!.brief.customer?.id).toBe("C-1001");
    expect(conv.handoff!.brief.lastBalance?.total).toBe(18450);
    expect(conv.handoff!.summary.length).toBeGreaterThan(20);
    expect(conv.handoff!.crmTicketId).toMatch(/^TCK-/);

    // Mientras espera en cola, la IA no responde.
    const before = (await store.listOutbound({ to: LUCIA })).length;
    await sendWhatsApp(app, "¿Hola? ¿Hay alguien?");
    expect((await store.listOutbound({ to: LUCIA })).length).toBe(before);

    expect((await post(app, `/api/conversations/${conv.id}/reply`, { agent: "Vale", text: "hola" })).status).toBe(409);
    expect((await post(app, `/api/conversations/${conv.id}/claim`, { agent: "Vale" })).status).toBe(200);
    expect((await post(app, `/api/conversations/${conv.id}/reply`, { agent: "Vale", text: "Hola Lucía, soy Vale. Te explico la factura." })).status).toBe(200);
    const out = await store.listOutbound({ to: LUCIA });
    expect(out.at(-1)!.text).toContain("soy Vale");

    // Con el humano a cargo, la IA sigue en pausa.
    await sendWhatsApp(app, "Gracias, ahora entiendo");
    expect((await store.listOutbound({ to: LUCIA })).length).toBe(out.length);

    // Devolución a la IA: vuelve a responder con contadores en cero.
    expect((await post(app, `/api/conversations/${conv.id}/release`, { agent: "Vale" })).status).toBe(200);
    await sendWhatsApp(app, "¿Cuánto debo?");
    const after = await store.listOutbound({ to: LUCIA });
    expect(after.at(-1)!.text).toContain("18.450");
    const c2 = (await store.getConversation(conv.id))!;
    expect(c2.status).toBe("ai");
    expect(c2.handoffHistory[0]).toMatchObject({ reason: "explicit_request", claimedBy: "Vale" });

    // Cierre: dispara el webhook post-conversación (n8n).
    expect((await post(app, `/api/conversations/${conv.id}/close`, { agent: "Vale" })).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ event: "conversation.closed", resolvedBy: "human", handoffReason: "explicit_request" });
  });

  it("fuera de horario avisa cuándo responde una persona", async () => {
    const { app, store } = setup({}, "2026-11-01T02:00:00Z"); // sábado 23:00 en Buenos Aires
    await sendWhatsApp(app, "Quiero dar de baja el servicio");
    const out = await store.listOutbound({ to: LUCIA });
    expect(out.at(-1)!.text).toContain("fuera de horario");
  });

  it("bloquea respuestas humanas fuera de la ventana de 24 h", async () => {
    const { app, store, setNow } = setup();
    await sendWhatsApp(app, "Quiero hablar con una persona");
    const [conv] = await store.listConversations({ status: "pending_human" });
    await post(app, `/api/conversations/${conv!.id}/claim`, { agent: "Vale" });
    setNow("2026-10-28T16:00:00Z");
    const res = await post(app, `/api/conversations/${conv!.id}/reply`, { agent: "Vale", text: "hola" });
    expect(res.status).toBe(422);
  });
});

describe("canal de voz", () => {
  it("procesa la transcripción y transfiere en una baja", async () => {
    const { app } = setup();
    const res = await post(app, "/channels/voice/andeslink", { callId: "call-1", from: "+51987650103", utterances: ["Buenos días, ¿cuál es mi saldo?", "Deseo cancelar mi contrato", "esto no se procesa"] });
    const data = (await res.json()) as { turns: { action: string; say: string; transferTo?: string }[] };
    expect(data.turns).toHaveLength(2);
    expect(data.turns[0]).toMatchObject({ action: "continue" });
    expect(data.turns[0]!.say).toContain("389.70");
    expect(data.turns[1]).toMatchObject({ action: "transfer", transferTo: "+5115550099" });
  });
});

describe("observabilidad y seguridad del dashboard", () => {
  it("expone métricas JSON, Prometheus y trazas por conversación", async () => {
    const { app } = setup();
    await sendWhatsApp(app, "¿Cuánto debo?");
    await sendWhatsApp(app, "Quiero dar de baja", { from: "5491155550102" });
    const m = (await (await app.request("/api/metrics")).json()) as { conversations: number; containmentRate: number; handoffsByReason: Record<string, number> };
    expect(m).toMatchObject({ conversations: 2, containmentRate: 0.5, handoffsByReason: { always_human_intent: 1 } });
    expect(await (await app.request("/metrics")).text()).toContain('oah_handoffs_total{reason="always_human_intent"} 1');
    const convs = (await (await app.request("/api/conversations")).json()) as Conversation[];
    const traces = (await (await app.request(`/api/conversations/${convs[0]!.id}/traces`)).json()) as { steps: { agent: string }[] }[];
    expect(traces[0]!.steps.map((s) => s.agent)).toEqual(expect.arrayContaining(["guardrail", "router", "supervisor"]));
  });
  it("exige token si DASHBOARD_TOKEN está configurado", async () => {
    const { app } = setup({ DASHBOARD_TOKEN: "t0k" });
    expect((await app.request("/api/metrics")).status).toBe(401);
    expect((await app.request("/api/metrics", { headers: { authorization: "Bearer t0k" } })).status).toBe(200);
  });
});
