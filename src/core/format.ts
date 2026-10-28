import type { Playbook } from "./playbook";

const LOCALES: Record<string, string> = { AR: "es-AR", PE: "es-PE", CL: "es-CL", MX: "es-MX", CO: "es-CO", UY: "es-UY" };

export const locale = (pb: Playbook) => LOCALES[pb.tenant.country] ?? "es";

export function money(pb: Playbook, amount: number): string {
  return new Intl.NumberFormat(locale(pb), {
    style: "currency",
    currency: pb.tenant.currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Fecha local del tenant en formato YYYY-MM-DD. */
export function localDate(pb: Playbook, d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: pb.tenant.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
}

function dayLabel(pb: Playbook, d: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat(locale(pb), { weekday: "long", timeZone }).format(d);
  const [y, m, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-");
  void y;
  return `${weekday} ${Number(day)}/${Number(m)}`;
}

export function prettyDate(pb: Playbook, isoDate: string): string {
  return dayLabel(pb, new Date(`${isoDate}T12:00:00Z`), "UTC");
}

export function prettySlot(pb: Playbook, start: string, durationMin: number): string {
  const d = new Date(start);
  const day = dayLabel(pb, d, pb.tenant.timezone);
  const hm = (x: Date) => new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: pb.tenant.timezone }).format(x);
  return `${day} de ${hm(d)} a ${hm(new Date(d.getTime() + durationMin * 60_000))}`;
}

export function todayLabel(pb: Playbook, now: Date): string {
  const iso = localDate(pb, now);
  return `${prettyDate(pb, iso)} (${iso})`;
}

export function withinBusinessHours(pb: Playbook, now: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: pb.tenant.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "") + 1;
  const hm = `${parts.hour}:${parts.minute}`;
  return pb.businessHours.days.includes(dow) && hm >= pb.businessHours.open && hm < pb.businessHours.close;
}

/** Elige el texto según el trato configurado (vos / tú / usted). */
export function say(pb: Playbook, v: { vos: string; usted: string; tu?: string }): string {
  if (pb.tone.address === "usted") return v.usted;
  if (pb.tone.address === "tu") return v.tu ?? v.vos;
  return v.vos;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
}
