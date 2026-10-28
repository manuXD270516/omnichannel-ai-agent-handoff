/**
 * Interfaces comunes de integración. Cada cliente trae su CRM/ERP/agenda:
 * cambiar de cliente significa escribir (o configurar) un adaptador, no tocar los agentes.
 */

export interface Contact {
  id: string;
  name: string;
  phone: string;
  email?: string;
  zone: string;
  plan: string;
  /** Segmento de valor; el humano lo ve en la bandeja. */
  segment: "residencial" | "pyme";
}

export interface Ticket {
  id: string;
  contactId?: string;
  subject: string;
  body: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "closed";
  pipeline: string;
  notes: string[];
  createdAt: string;
}

export interface CrmAdapter {
  readonly name: string;
  findContactByPhone(phone: string): Promise<Contact | null>;
  createTicket(input: Omit<Ticket, "id" | "status" | "notes" | "createdAt">): Promise<Ticket>;
  addNote(ticketId: string, note: string): Promise<void>;
  updateTicketStatus(ticketId: string, status: Ticket["status"]): Promise<void>;
  listTickets(): Promise<Ticket[]>;
}

export interface Invoice {
  id: string;
  period: string;
  amount: number;
  dueDate: string;
  paid: boolean;
}

export interface Balance {
  customerId: string;
  currency: string;
  total: number;
  overdueDays: number;
  nextDueDate: string;
  invoices: Invoice[];
}

export interface PaymentPromise {
  id: string;
  customerId: string;
  amount: number;
  date: string;
  createdAt: string;
}

export interface ErpAdapter {
  readonly name: string;
  getBalance(customerId: string): Promise<Balance | null>;
  registerPaymentPromise(input: { customerId: string; amount: number; date: string }): Promise<PaymentPromise>;
  listPromises(customerId?: string): Promise<PaymentPromise[]>;
}

export interface Slot {
  id: string;
  start: string;
  end: string;
  zone: string;
}

export interface Booking {
  id: string;
  slotId: string;
  customerId: string;
  start: string;
  reason: string;
}

export interface CalendarAdapter {
  readonly name: string;
  getAvailableSlots(input: { zone: string; from: Date; limit: number }): Promise<Slot[]>;
  book(input: { slotId: string; customerId: string; reason: string }): Promise<Booking>;
  listBookings(customerId?: string): Promise<Booking[]>;
}

export interface Integrations {
  crm: CrmAdapter;
  erp: ErpAdapter;
  calendar: CalendarAdapter;
}
