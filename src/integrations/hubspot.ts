import type { Contact, CrmAdapter, Ticket } from "./types";

/**
 * Adaptador real de HubSpot (CRM v3). Muestra cómo se enchufa un CRM de cliente
 * detrás de la misma interfaz que el mock. NO se probó contra la API real
 * (requiere un token privado de la cuenta del cliente); se activa con
 * `integrations.crm.adapter: hubspot` en el playbook y `HUBSPOT_TOKEN`.
 */
export class HubSpotCrm implements CrmAdapter {
  readonly name = "hubspot";
  constructor(
    private readonly token: string,
    private readonly pipelineId: string,
    private readonly baseUrl = "https://api.hubapi.com",
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...init.headers },
    });
    if (!res.ok) throw new Error(`HubSpot ${res.status} en ${path}`);
    return (await res.json()) as T;
  }

  async findContactByPhone(phone: string): Promise<Contact | null> {
    const data = await this.req<{ results: { id: string; properties: Record<string, string> }[] }>(
      "/crm/v3/objects/contacts/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
          properties: ["firstname", "lastname", "phone", "email", "zone", "plan", "segment"],
          limit: 1,
        }),
      },
    );
    const r = data.results[0];
    if (!r) return null;
    const p = r.properties;
    return {
      id: r.id,
      name: `${p.firstname ?? ""} ${p.lastname ?? ""}`.trim(),
      phone: p.phone ?? phone,
      email: p.email,
      zone: p.zone ?? "desconocida",
      plan: p.plan ?? "",
      segment: p.segment === "pyme" ? "pyme" : "residencial",
    };
  }

  async createTicket(input: Omit<Ticket, "id" | "status" | "notes" | "createdAt">): Promise<Ticket> {
    const priority = { low: "LOW", medium: "MEDIUM", high: "HIGH" }[input.priority];
    const r = await this.req<{ id: string; createdAt: string }>("/crm/v3/objects/tickets", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          subject: input.subject,
          content: input.body,
          hs_pipeline: this.pipelineId,
          hs_pipeline_stage: "1",
          hs_ticket_priority: priority,
        },
        ...(input.contactId
          ? { associations: [{ to: { id: input.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }] }] }
          : {}),
      }),
    });
    return { ...input, id: r.id, status: "open", notes: [], createdAt: r.createdAt };
  }

  async addNote(ticketId: string, note: string): Promise<void> {
    await this.req("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({
        properties: { hs_note_body: note, hs_timestamp: new Date().toISOString() },
        associations: [{ to: { id: ticketId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }] }],
      }),
    });
  }

  async updateTicketStatus(ticketId: string, status: Ticket["status"]): Promise<void> {
    const stage = { open: "1", in_progress: "2", closed: "4" }[status];
    await this.req(`/crm/v3/objects/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ properties: { hs_pipeline_stage: stage } }) });
  }

  async listTickets(): Promise<Ticket[]> {
    return [];
  }
}
