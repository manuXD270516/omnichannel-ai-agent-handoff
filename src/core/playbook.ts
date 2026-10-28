import { z } from "zod";
import { HANDOFF_REASONS, IntentSchema, UrgencySchema } from "./types";

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "formato HH:MM");

/**
 * Playbook por cliente: todo lo que cambia entre clientes vive acá,
 * no en el código. Es el contrato de productización.
 */
export const PlaybookSchema = z
  .object({
    tenant: z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string(),
      country: z.string().length(2),
      timezone: z.string(),
      currency: z.string().length(3),
      languages: z.array(z.string()).min(1),
    }),
    tone: z.object({
      persona: z.string(),
      address: z.enum(["vos", "tu", "usted"]),
      maxReplyChars: z.number().int().positive().default(600),
      signature: z.string().optional(),
    }),
    businessHours: z.object({
      days: z.array(z.number().int().min(1).max(7)).min(1),
      open: HHMM,
      close: HHMM,
    }),
    intents: z.object({
      enabled: z.array(IntentSchema).min(1),
    }),
    billing: z.object({
      maxPromiseAmount: z.number().positive(),
      maxPromiseDays: z.number().int().positive(),
      minPromisePercent: z.number().min(0).max(1),
      maxOverdueDaysForPromise: z.number().int().nonnegative(),
    }),
    handoff: z.object({
      onExplicitRequest: z.boolean().default(true),
      minConfidence: z.number().min(0).max(1),
      lowConfidenceStrikes: z.number().int().positive().default(2),
      negativeSentimentTurns: z.number().int().positive(),
      maxUnresolvedTurns: z.number().int().positive(),
      alwaysHumanIntents: z.array(IntentSchema),
      urgencyHandoff: z.array(UrgencySchema).default(["critical"]),
      onOutOfPolicyRequest: z.boolean().default(true),
      injectionStrikes: z.number().int().positive().default(2),
      queue: z.string(),
      messages: z.object({
        inHours: z.string(),
        outOfHours: z.string(),
      }),
    }),
    integrations: z.object({
      crm: z.object({ adapter: z.enum(["mock-crm", "hubspot"]), pipeline: z.string().optional() }),
      erp: z.object({ adapter: z.enum(["mock-erp"]) }),
      calendar: z.object({ adapter: z.enum(["mock-calendar"]), visitDurationMin: z.number().int().positive() }),
    }),
    kb: z.object({
      collection: z.string(),
      minScore: z.number().nonnegative(),
      topK: z.number().int().positive().default(3),
    }),
    channels: z.object({
      whatsapp: z.object({ phoneNumberId: z.string(), displayPhone: z.string() }).optional(),
      voice: z.object({ enabled: z.boolean(), transferNumber: z.string().optional() }).optional(),
    }),
  })
  .superRefine((pb, ctx) => {
    for (const i of pb.handoff.alwaysHumanIntents) {
      if (!pb.intents.enabled.includes(i) && i !== "cancellation") {
        ctx.addIssue({ code: "custom", message: `alwaysHumanIntents incluye ${i}, que no está habilitada`, path: ["handoff", "alwaysHumanIntents"] });
      }
    }
    if (pb.businessHours.open >= pb.businessHours.close) {
      ctx.addIssue({ code: "custom", message: "businessHours.open debe ser anterior a close", path: ["businessHours"] });
    }
  });

export type Playbook = z.infer<typeof PlaybookSchema>;

export const HandoffReasonSchema = z.enum(HANDOFF_REASONS);

export interface KbDoc {
  id: string;
  title: string;
  text: string;
}

export interface TenantBundle {
  playbook: Playbook;
  kb: KbDoc[];
}

export function parsePlaybook(raw: unknown): Playbook {
  const r = PlaybookSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Playbook inválido: ${issues}`);
  }
  return r.data;
}
