import { Engine } from "./core/engine";
import type { TenantBundle } from "./core/playbook";
import type { Conversation } from "./core/types";
import { createApp } from "./app";
import { createProvider, type AppEnv } from "./config";
import { WhatsAppSender } from "./channels/whatsapp";
import { createMockIntegrations } from "./integrations/mock";
import { HubSpotCrm } from "./integrations/hubspot";
import type { Integrations } from "./integrations/types";
import type { Store } from "./store/store";
import type { LLMProvider } from "./llm/provider";

/** Payload post-conversación que consume el workflow de n8n (encuesta + nota en CRM). */
export function postConversationPayload(c: Conversation) {
  const h = c.handoff ?? c.handoffHistory.at(-1);
  return {
    event: "conversation.closed",
    conversationId: c.id,
    tenantId: c.tenantId,
    channel: c.channel,
    contactId: c.contactId,
    customerId: c.customerId,
    turns: c.turns.length,
    handedOff: !!h,
    handoffReason: h?.reason,
    crmTicketId: h?.crmTicketId,
    resolvedBy: h ? "human" : "ai",
    closedAt: c.updatedAt,
  };
}

export interface RuntimeOptions {
  env: AppEnv;
  store: Store;
  tenants: Record<string, TenantBundle>;
  llm?: LLMProvider;
  now?: () => Date;
}

/** Composición única para Node, Workers, tests y evals: cambia el store y el entorno, no el núcleo. */
export function buildRuntime(opts: RuntimeOptions) {
  const now = opts.now ?? (() => new Date());
  const integrations = new Map<string, Integrations>();
  const integrationsFor = (tenantId: string) => {
    let io = integrations.get(tenantId);
    if (!io) {
      const pb = opts.tenants[tenantId]!.playbook;
      io = createMockIntegrations(tenantId, pb.integrations.calendar.visitDurationMin, now);
      const token = (opts.env as Record<string, string | undefined>).HUBSPOT_TOKEN;
      if (pb.integrations.crm.adapter === "hubspot" && token) io = { ...io, crm: new HubSpotCrm(token, pb.integrations.crm.pipeline ?? "0") };
      integrations.set(tenantId, io);
    }
    return io;
  };
  const sender = new WhatsAppSender(opts.env.WHATSAPP_MODE === "live" ? "live" : "mock", (m) => opts.store.saveOutbound(m), opts.env.WHATSAPP_ACCESS_TOKEN);
  const webhook = opts.env.POST_CONVERSATION_WEBHOOK_URL;
  const engine = new Engine({
    store: opts.store,
    llm: opts.llm ?? createProvider(opts.env),
    tenants: opts.tenants,
    integrationsFor,
    sender,
    now,
    onClosed: webhook
      ? async (c) => {
          try {
            await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(postConversationPayload(c)) });
          } catch (e) {
            console.warn("webhook post-conversación falló", (e as Error).message);
          }
        }
      : undefined,
  });
  const app = createApp({ engine, store: opts.store, env: opts.env });
  return { app, engine, integrationsFor };
}
