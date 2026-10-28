import type {
  Balance,
  Booking,
  CalendarAdapter,
  Contact,
  CrmAdapter,
  ErpAdapter,
  Integrations,
  PaymentPromise,
  Slot,
  Ticket,
} from "../types";
import { SEED } from "./seed";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(++seq).toString().padStart(5, "0")}`;

/** CRM simulado con la forma de HubSpot (contactos + tickets en un pipeline). */
export class MockCrm implements CrmAdapter {
  readonly name = "mock-crm";
  private tickets: Ticket[] = [];
  constructor(
    private readonly contacts: Contact[],
    private readonly now: () => Date,
  ) {}

  async findContactByPhone(phone: string) {
    const norm = phone.replace(/\D/g, "");
    return this.contacts.find((c) => c.phone.replace(/\D/g, "") === norm) ?? null;
  }
  async createTicket(input: Omit<Ticket, "id" | "status" | "notes" | "createdAt">) {
    const t: Ticket = { ...input, id: nextId("TCK"), status: "open", notes: [], createdAt: this.now().toISOString() };
    this.tickets.push(t);
    return t;
  }
  async addNote(ticketId: string, note: string) {
    this.tickets.find((t) => t.id === ticketId)?.notes.push(note);
  }
  async updateTicketStatus(ticketId: string, status: Ticket["status"]) {
    const t = this.tickets.find((x) => x.id === ticketId);
    if (t) t.status = status;
  }
  async listTickets() {
    return [...this.tickets];
  }
}

/** ERP de facturación simulado. Las reglas de negocio NO viven acá: las aplica el tool con el playbook. */
export class MockErp implements ErpAdapter {
  readonly name = "mock-erp";
  private promises: PaymentPromise[] = [];
  constructor(
    private readonly balances: Balance[],
    private readonly now: () => Date,
  ) {}
  async getBalance(customerId: string) {
    return structuredClone(this.balances.find((b) => b.customerId === customerId) ?? null);
  }
  async registerPaymentPromise(input: { customerId: string; amount: number; date: string }) {
    const p: PaymentPromise = { ...input, id: nextId("PRM"), createdAt: this.now().toISOString() };
    this.promises.push(p);
    return p;
  }
  async listPromises(customerId?: string) {
    return this.promises.filter((p) => !customerId || p.customerId === customerId);
  }
}

/** Agenda de visitas técnicas: franjas de mañana y tarde en días hábiles, por zona. */
export class MockCalendar implements CalendarAdapter {
  readonly name = "mock-calendar";
  private bookings: Booking[] = [];
  constructor(
    private readonly utcOffset: string,
    private readonly durationMin: number,
    private readonly blockedZones: string[] = [],
  ) {}

  async getAvailableSlots({ zone, from, limit }: { zone: string; from: Date; limit: number }) {
    if (this.blockedZones.includes(zone)) return [];
    const out: Slot[] = [];
    const offH = Number(this.utcOffset.slice(0, 3));
    const local = new Date(from.getTime() + offH * 3600_000);
    for (let d = 1; out.length < limit && d <= 14; d++) {
      const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d));
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (const hour of ["09:00", "14:00"]) {
        const date = day.toISOString().slice(0, 10);
        const start = `${date}T${hour}:00${this.utcOffset}`;
        const id = `S-${date.replace(/-/g, "")}-${hour.replace(":", "")}-${zone}`;
        if (this.bookings.some((b) => b.slotId === id)) continue;
        const end = new Date(new Date(start).getTime() + this.durationMin * 60_000).toISOString();
        out.push({ id, start, end, zone });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
  async book({ slotId, customerId, reason }: { slotId: string; customerId: string; reason: string }) {
    if (this.bookings.some((b) => b.slotId === slotId)) throw new Error("slot_taken");
    const m = slotId.match(/^S-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-/);
    if (!m) throw new Error("slot_invalid");
    const b: Booking = {
      id: nextId("VIS"),
      slotId,
      customerId,
      reason,
      start: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${this.utcOffset}`,
    };
    this.bookings.push(b);
    return b;
  }
  async listBookings(customerId?: string) {
    return this.bookings.filter((b) => !customerId || b.customerId === customerId);
  }
}

const OFFSETS: Record<string, string> = { fibrasur: "-03:00", andeslink: "-05:00" };

/** Arma las integraciones mock de un tenant. En producción, esta fábrica elige el adaptador real según el playbook. */
export function createMockIntegrations(tenantId: string, visitDurationMin: number, now: () => Date): Integrations {
  const seed = SEED[tenantId];
  if (!seed) throw new Error(`Sin datos semilla para ${tenantId}`);
  return {
    crm: new MockCrm(seed.contacts, now),
    erp: new MockErp(seed.balances, now),
    calendar: new MockCalendar(OFFSETS[tenantId] ?? "+00:00", visitDurationMin, seed.blockedZones),
  };
}
