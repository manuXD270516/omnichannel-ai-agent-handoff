/**
 * Simulador de WhatsApp por consola: arma un webhook con el formato real de la Cloud API,
 * lo firma con X-Hub-Signature-256 y lo manda al servidor local. Muestra lo que "saldría" a Meta.
 *   pnpm simulate                       → modo interactivo (Fibrasur, Lucía)
 *   pnpm simulate -- --tenant andeslink --from 51987650101 "¿cuál es mi saldo?"
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { TENANTS } from "../src/generated/tenants";
import { buildInboundWebhook, signBody } from "../src/channels/whatsapp";
import { DEV_DEFAULTS } from "../src/config";
import type { OutboundMessage } from "../src/core/types";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string", default: "fibrasur" },
    from: { type: "string", default: "5491155550101" },
    url: { type: "string", default: process.env.APP_URL ?? "http://127.0.0.1:8790" },
  },
});
const wa = TENANTS[values.tenant!]?.playbook.channels.whatsapp;
if (!wa) throw new Error(`Tenant sin WhatsApp: ${values.tenant}`);
const secret = process.env.WHATSAPP_APP_SECRET ?? DEV_DEFAULTS.WHATSAPP_APP_SECRET;
const from = values.from!.replace(/\D/g, "");

async function send(text: string) {
  const seen = ((await (await fetch(`${values.url}/api/outbound?to=${from}`)).json()) as OutboundMessage[]).length;
  const body = JSON.stringify(buildInboundWebhook({ phoneNumberId: wa!.phoneNumberId, displayPhone: wa!.displayPhone, from, text }));
  const res = await fetch(`${values.url}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signBody(secret, body) },
    body,
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text()}`);
  const out = ((await (await fetch(`${values.url}/api/outbound?to=${from}`)).json()) as OutboundMessage[]).slice(seen);
  for (const m of out) console.log(`\n< ${m.text}`);
  if (out.length === 0) console.log("\n< (sin respuesta automática: la conversación está con un humano o en cola)");
}

if (positionals.length) {
  await send(positionals.join(" "));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Simulador WhatsApp · ${values.tenant} · desde ${from} · Ctrl+C para salir`);
  for (;;) await send(await rl.question("\n> "));
}
