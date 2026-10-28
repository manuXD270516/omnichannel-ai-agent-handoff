import { z } from "zod";
import type { OutboundMessage } from "../core/types";

/**
 * WhatsApp Cloud API: verificación del webhook, firma X-Hub-Signature-256,
 * parseo del payload real de Meta y armado del mensaje saliente.
 * Todo con WebCrypto para que corra igual en Node y en Workers.
 */

export const GRAPH_API_VERSION = "v21.0";

export function verifyChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === verifyToken) {
    return params.get("hub.challenge");
  }
  return null;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signBody(appSecret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return `sha256=${toHex(mac)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valida la firma sobre el body CRUDO (antes de parsear JSON), como exige Meta. */
export async function verifySignature(appSecret: string, rawBody: string, header: string | undefined | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  return constantTimeEqual(await signBody(appSecret, rawBody), header);
}

const MessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      })
      .optional(),
  })
  .loose();

export const WebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              messaging_product: z.literal("whatsapp"),
              metadata: z.object({ display_phone_number: z.string(), phone_number_id: z.string() }),
              contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
              messages: z.array(MessageSchema).optional(),
              statuses: z.array(z.object({ id: z.string(), status: z.string() }).loose()).optional(),
            })
            .loose(),
        }),
      ),
    }),
  ),
});

export interface InboundText {
  messageId: string;
  phoneNumberId: string;
  from: string;
  profileName?: string;
  text: string | null;
  type: string;
  timestamp: number;
}

export function parseWebhook(body: unknown): { messages: InboundText[]; statuses: number } {
  const parsed = WebhookSchema.parse(body);
  const messages: InboundText[] = [];
  let statuses = 0;
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const v = change.value;
      statuses += v.statuses?.length ?? 0;
      for (const m of v.messages ?? []) {
        const text =
          m.type === "text" ? (m.text?.body ?? null) : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null) : null;
        messages.push({
          messageId: m.id,
          phoneNumberId: v.metadata.phone_number_id,
          from: m.from,
          profileName: v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name,
          text,
          type: m.type,
          timestamp: Number(m.timestamp),
        });
      }
    }
  }
  return { messages, statuses };
}

/** Payload saliente exacto de la Cloud API (POST /{phone-number-id}/messages). */
export function textMessagePayload(to: string, body: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: body.slice(0, 4096) },
  };
}

/** Construye un webhook entrante con el formato real; lo usa el simulador local y los tests. */
export function buildInboundWebhook(opts: { phoneNumberId: string; displayPhone: string; from: string; name?: string; text: string; id?: string; timestamp?: number }) {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-SIMULATED",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: opts.displayPhone.replace(/\D/g, ""), phone_number_id: opts.phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? "Cliente" } }],
              messages: [{ from: opts.from, id: opts.id ?? `wamid.SIM${crypto.randomUUID().replace(/-/g, "")}`, timestamp: String(ts), type: "text", text: { body: opts.text } }],
            },
          },
        ],
      },
    ],
  };
}

export interface ChannelSender {
  send(msg: { tenantId: string; channel: OutboundMessage["channel"]; to: string; text: string; phoneNumberId?: string }): Promise<OutboundMessage>;
}

/**
 * Envío por WhatsApp. En modo "mock" guarda el payload exacto en la bandeja de salida
 * local; en modo "live" lo manda a graph.facebook.com (requiere token del cliente; no se usa en este repo).
 */
export class WhatsAppSender implements ChannelSender {
  constructor(
    private readonly mode: "mock" | "live",
    private readonly save: (m: OutboundMessage) => Promise<void>,
    private readonly accessToken?: string,
  ) {}

  async send(msg: { tenantId: string; channel: OutboundMessage["channel"]; to: string; text: string; phoneNumberId?: string }): Promise<OutboundMessage> {
    const payload = msg.channel === "whatsapp" ? textMessagePayload(msg.to, msg.text) : { say: msg.text };
    const out: OutboundMessage = { id: crypto.randomUUID(), tenantId: msg.tenantId, channel: msg.channel, to: msg.to, payload, text: msg.text, at: new Date().toISOString() };
    if (this.mode === "live" && msg.channel === "whatsapp") {
      if (!this.accessToken || !msg.phoneNumberId) throw new Error("WhatsApp live sin token o phone_number_id");
      const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${msg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Graph API ${res.status}`);
    }
    await this.save(out);
    return out;
  }
}

/** Ventana de atención de 24 h: fuera de ella, Meta solo permite plantillas aprobadas. */
export function within24hWindow(lastCustomerAt: string | undefined, now: Date): boolean {
  if (!lastCustomerAt) return false;
  return now.getTime() - new Date(lastCustomerAt).getTime() < 24 * 3600_000;
}
