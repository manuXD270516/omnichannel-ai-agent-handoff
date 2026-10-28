import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildInboundWebhook, parseWebhook, signBody, textMessagePayload, verifyChallenge, verifySignature, within24hWindow } from "../../src/channels/whatsapp";
import { chunkKb, KbIndex } from "../../src/core/rag";
import { TENANTS } from "../../src/generated/tenants";
import { generateValidated, extractJson } from "../../src/llm/provider";
import { parseAmount, parseDate } from "../../src/llm/scripted";
import { createSqliteStore } from "../../src/store/sqlite";

describe("WhatsApp Cloud API", () => {
  it("verifica el challenge solo con el token correcto", () => {
    expect(verifyChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "t", "hub.challenge": "123" }), "t")).toBe("123");
    expect(verifyChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "123" }), "t")).toBeNull();
  });
  it("valida X-Hub-Signature-256 sobre el body crudo", async () => {
    const body = JSON.stringify({ a: 1 });
    const sig = await signBody("secret", body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature("secret", body, sig)).toBe(true);
    expect(await verifySignature("secret", body + " ", sig)).toBe(false);
    expect(await verifySignature("otro", body, sig)).toBe(false);
    expect(await verifySignature("secret", body, undefined)).toBe(false);
  });
  it("parsea texto, respuestas interactivas e ignora estados", () => {
    const wh = buildInboundWebhook({ phoneNumberId: "1", displayPhone: "+54 11", from: "549115", text: "hola", id: "wamid.1", timestamp: 1 });
    const value = wh.entry[0]!.changes[0]!.value as any;
    value.messages.push({ from: "549115", id: "wamid.2", timestamp: "2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Sí" } } });
    value.messages.push({ from: "549115", id: "wamid.3", timestamp: "3", type: "audio", audio: { id: "a" } });
    value.statuses = [{ id: "wamid.0", status: "delivered" }];
    const { messages, statuses } = parseWebhook(wh);
    expect(messages.map((m) => m.text)).toEqual(["hola", "Sí", null]);
    expect(statuses).toBe(1);
    expect(messages[0]!.profileName).toBe("Cliente");
  });
  it("arma el payload saliente de la Cloud API", () => {
    expect(textMessagePayload("549115", "hola")).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "549115", type: "text", text: { preview_url: false, body: "hola" } });
  });
  it("respeta la ventana de 24 h", () => {
    const now = new Date("2026-10-27T15:00:00Z");
    expect(within24hWindow("2026-10-27T10:00:00Z", now)).toBe(true);
    expect(within24hWindow("2026-10-26T10:00:00Z", now)).toBe(false);
  });
});

describe("RAG", () => {
  const idx = new KbIndex(chunkKb(TENANTS.fibrasur!.kb));
  it("recupera el pasaje correcto", () => {
    expect(idx.search("cómo cambio la clave del wifi")[0]!.id).toBe("clave-wifi#desde-la-app");
    expect(idx.search("la luz LOS está roja")[0]!.id).toBe("sin-conexion#revisar-las-luces-del-modem");
  });
  it("no recupera nada útil para temas fuera de la KB", () => {
    const top = idx.search("¿el router soporta IPv6 y modo bridge?")[0];
    expect(top?.score ?? 0).toBeLessThan(TENANTS.fibrasur!.playbook.kb.minScore);
  });
});

describe("salida estructurada del LLM", () => {
  const schema = z.object({ intent: z.enum(["a", "b"]) });
  it("extrae JSON envuelto en texto o bloques de código", () => {
    expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(extractJson('Claro: {"x":2} listo')).toEqual({ x: 2 });
  });
  it("reintenta una vez cuando la salida no cumple el schema", async () => {
    const outputs = ['{"intent":"z"}', '{"intent":"a"}'];
    const r = await generateValidated({ task: "t", system: "", user: "", schema }, async () => outputs.shift()!);
    expect(r).toEqual({ object: { intent: "a" }, attempts: 2 });
  });
  it("falla si tampoco cumple en el reintento", async () => {
    await expect(generateValidated({ task: "t", system: "", user: "", schema }, async () => "nada")).rejects.toThrow(/Salida inválida/);
  });
});

describe("parser determinístico (proveedor scripted)", () => {
  it.each([
    ["el viernes", "2026-10-30"],
    ["mañana", "2026-10-28"],
    ["el 5 de noviembre", "2026-11-05"],
    ["el 5/11", "2026-11-05"],
    ["fin de mes", "2026-10-31"],
    ["el 3", "2026-11-03"],
  ])("%s → %s", (t, d) => expect(parseDate(t, "2026-10-27")).toBe(d));
  it("montos", () => {
    expect(parseAmount("$12.990")).toBe(12990);
    expect(parseAmount("20 mil")).toBe(20000);
    expect(parseAmount("5000 pesos")).toBe(5000);
    expect(parseAmount("el viernes")).toBeNull();
  });
});

describe("SQLite store", () => {
  it("persiste conversaciones y es idempotente con los eventos", async () => {
    const store = await createSqliteStore(":memory:");
    expect(await store.markProcessed("wamid.1")).toBe(true);
    expect(await store.markProcessed("wamid.1")).toBe(false);
    const conv = { id: "c1", tenantId: "fibrasur", channel: "whatsapp", contactId: "549", status: "ai", messages: [], turns: [], counters: { unresolved: 0, lowConfidenceStreak: 0, negativeStreak: 0, injectionCount: 0 }, state: {}, handoffHistory: [], createdAt: "x", updatedAt: "2026" } as const;
    await store.saveConversation({ ...conv, messages: [], turns: [], handoffHistory: [] } as any);
    expect((await store.findOpenConversation("fibrasur", "whatsapp", "549"))?.id).toBe("c1");
    await store.saveConversation({ ...conv, status: "closed", messages: [], turns: [], handoffHistory: [] } as any);
    expect(await store.findOpenConversation("fibrasur", "whatsapp", "549")).toBeNull();
  });
});
