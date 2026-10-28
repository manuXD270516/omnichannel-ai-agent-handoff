import type { Balance, Contact } from "../types";

/** Datos 100% sintéticos. Teléfonos de rango ficticio y emails en example.com. */
export const SEED: Record<string, { contacts: Contact[]; balances: Balance[]; blockedZones: string[] }> = {
  fibrasur: {
    contacts: [
      { id: "C-1001", name: "Lucía Fernández", phone: "+5491155550101", email: "lucia.f@example.com", zone: "caba-norte", plan: "Fibra 300", segment: "residencial" },
      { id: "C-1002", name: "Martín Gómez", phone: "+5491155550102", email: "martin.g@example.com", zone: "caba-sur", plan: "Fibra 100", segment: "residencial" },
      { id: "C-1003", name: "Carla Ruiz", phone: "+5491155550103", email: "carla.r@example.com", zone: "zona-oeste", plan: "Fibra 1000", segment: "pyme" },
      { id: "C-1004", name: "Diego Paz", phone: "+5491155550104", email: "diego.p@example.com", zone: "caba-norte", plan: "Fibra 300", segment: "residencial" },
      { id: "C-1005", name: "Ana Torres", phone: "+5491155550105", email: "ana.t@example.com", zone: "rural-norte", plan: "Fibra 100", segment: "residencial" },
    ],
    balances: [
      {
        customerId: "C-1001", currency: "ARS", total: 18450, overdueDays: 17, nextDueDate: "2026-11-10",
        invoices: [{ id: "F-0001-88231", period: "2026-10", amount: 18450, dueDate: "2026-10-10", paid: false }],
      },
      { customerId: "C-1002", currency: "ARS", total: 0, overdueDays: 0, nextDueDate: "2026-11-10", invoices: [] },
      {
        customerId: "C-1003", currency: "ARS", total: 92300, overdueDays: 47, nextDueDate: "2026-11-10",
        invoices: [
          { id: "F-0001-87011", period: "2026-09", amount: 46150, dueDate: "2026-09-10", paid: false },
          { id: "F-0001-88232", period: "2026-10", amount: 46150, dueDate: "2026-10-10", paid: false },
        ],
      },
      {
        customerId: "C-1004", currency: "ARS", total: 36900, overdueDays: 78, nextDueDate: "2026-11-10",
        invoices: [
          { id: "F-0001-85502", period: "2026-08", amount: 18450, dueDate: "2026-08-10", paid: false },
          { id: "F-0001-87012", period: "2026-09", amount: 18450, dueDate: "2026-09-10", paid: false },
        ],
      },
      {
        customerId: "C-1005", currency: "ARS", total: 12990, overdueDays: 17, nextDueDate: "2026-11-10",
        invoices: [{ id: "F-0001-88240", period: "2026-10", amount: 12990, dueDate: "2026-10-10", paid: false }],
      },
    ],
    blockedZones: ["rural-norte"],
  },
  andeslink: {
    contacts: [
      { id: "A-2001", name: "Rosa Quispe", phone: "+51987650101", email: "rosa.q@example.com", zone: "miraflores", plan: "Fibra 200", segment: "residencial" },
      { id: "A-2002", name: "Jorge Huamán", phone: "+51987650102", email: "jorge.h@example.com", zone: "surco", plan: "Fibra 500", segment: "pyme" },
      { id: "A-2003", name: "Elena Rojas", phone: "+51987650103", email: "elena.r@example.com", zone: "san-borja", plan: "Fibra 200", segment: "residencial" },
    ],
    balances: [
      {
        customerId: "A-2001", currency: "PEN", total: 129.9, overdueDays: 12, nextDueDate: "2026-11-15",
        invoices: [{ id: "R-77120", period: "2026-10", amount: 129.9, dueDate: "2026-10-15", paid: false }],
      },
      { customerId: "A-2002", currency: "PEN", total: 0, overdueDays: 0, nextDueDate: "2026-11-15", invoices: [] },
      {
        customerId: "A-2003", currency: "PEN", total: 389.7, overdueDays: 42, nextDueDate: "2026-11-15",
        invoices: [
          { id: "R-74410", period: "2026-08", amount: 129.9, dueDate: "2026-08-15", paid: false },
          { id: "R-75980", period: "2026-09", amount: 129.9, dueDate: "2026-09-15", paid: false },
          { id: "R-77121", period: "2026-10", amount: 129.9, dueDate: "2026-10-15", paid: false },
        ],
      },
    ],
    blockedZones: [],
  },
};
