import type { Channel, Conversation, ConversationStatus, OutboundMessage, Trace } from "../core/types";

export interface Store {
  getConversation(id: string): Promise<Conversation | null>;
  findOpenConversation(tenantId: string, channel: Channel, contactId: string): Promise<Conversation | null>;
  saveConversation(c: Conversation): Promise<void>;
  listConversations(filter?: { tenantId?: string; status?: ConversationStatus }): Promise<Conversation[]>;
  appendTrace(t: Trace): Promise<void>;
  listTraces(conversationId: string): Promise<Trace[]>;
  saveOutbound(m: OutboundMessage): Promise<void>;
  listOutbound(filter?: { to?: string; tenantId?: string }): Promise<OutboundMessage[]>;
  /** Idempotencia de webhooks: devuelve false si el id ya se procesó (Meta reintenta entregas). */
  markProcessed(eventId: string): Promise<boolean>;
}

export class MemoryStore implements Store {
  private conversations = new Map<string, Conversation>();
  private traces: Trace[] = [];
  private outbound: OutboundMessage[] = [];
  private processed = new Set<string>();

  async getConversation(id: string) {
    const c = this.conversations.get(id);
    return c ? structuredClone(c) : null;
  }
  async findOpenConversation(tenantId: string, channel: Channel, contactId: string) {
    for (const c of this.conversations.values()) {
      if (c.tenantId === tenantId && c.channel === channel && c.contactId === contactId && c.status !== "closed") return structuredClone(c);
    }
    return null;
  }
  async saveConversation(c: Conversation) {
    this.conversations.set(c.id, structuredClone(c));
  }
  async listConversations(filter: { tenantId?: string; status?: ConversationStatus } = {}) {
    return [...this.conversations.values()]
      .filter((c) => (!filter.tenantId || c.tenantId === filter.tenantId) && (!filter.status || c.status === filter.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => structuredClone(c));
  }
  async appendTrace(t: Trace) {
    this.traces.push(structuredClone(t));
  }
  async listTraces(conversationId: string) {
    return this.traces.filter((t) => t.conversationId === conversationId);
  }
  async saveOutbound(m: OutboundMessage) {
    this.outbound.push(m);
  }
  async listOutbound(filter: { to?: string; tenantId?: string } = {}) {
    return this.outbound.filter((m) => (!filter.to || m.to === filter.to) && (!filter.tenantId || m.tenantId === filter.tenantId));
  }
  async markProcessed(eventId: string) {
    if (this.processed.has(eventId)) return false;
    this.processed.add(eventId);
    return true;
  }
}

/** Esquema SQL compartido por SQLite (Node) y D1 (Workers). */
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel TEXT NOT NULL, contact_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_open ON conversations (tenant_id, channel, contact_id, status)`,
  `CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_conv ON traces (conversation_id)`,
  `CREATE TABLE IF NOT EXISTS outbound (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recipient TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, at TEXT NOT NULL)`,
];

/** Ejecutor SQL mínimo: lo implementan node:sqlite y D1, así el store es uno solo. */
export interface SqlExec {
  run(sql: string, params: unknown[]): Promise<{ changes: number }>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

export class SqlStore implements Store {
  constructor(private readonly db: SqlExec) {}

  async init() {
    for (const s of SCHEMA_SQL) await this.db.run(s, []);
  }
  async getConversation(id: string) {
    const rows = await this.db.all<{ data: string }>(`SELECT data FROM conversations WHERE id = ?`, [id]);
    return rows[0] ? (JSON.parse(rows[0].data) as Conversation) : null;
  }
  async findOpenConversation(tenantId: string, channel: Channel, contactId: string) {
    const rows = await this.db.all<{ data: string }>(
      `SELECT data FROM conversations WHERE tenant_id = ? AND channel = ? AND contact_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, channel, contactId],
    );
    return rows[0] ? (JSON.parse(rows[0].data) as Conversation) : null;
  }
  async saveConversation(c: Conversation) {
    await this.db.run(
      `INSERT INTO conversations (id, tenant_id, channel, contact_id, status, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      [c.id, c.tenantId, c.channel, c.contactId, c.status, JSON.stringify(c), c.updatedAt],
    );
  }
  async listConversations(filter: { tenantId?: string; status?: ConversationStatus } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId) (where.push("tenant_id = ?"), params.push(filter.tenantId));
    if (filter.status) (where.push("status = ?"), params.push(filter.status));
    const rows = await this.db.all<{ data: string }>(
      `SELECT data FROM conversations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 500`,
      params,
    );
    return rows.map((r) => JSON.parse(r.data) as Conversation);
  }
  async appendTrace(t: Trace) {
    await this.db.run(`INSERT INTO traces (id, conversation_id, data, at) VALUES (?, ?, ?, ?)`, [t.id, t.conversationId, JSON.stringify(t), t.at]);
  }
  async listTraces(conversationId: string) {
    const rows = await this.db.all<{ data: string }>(`SELECT data FROM traces WHERE conversation_id = ? ORDER BY at`, [conversationId]);
    return rows.map((r) => JSON.parse(r.data) as Trace);
  }
  async saveOutbound(m: OutboundMessage) {
    await this.db.run(`INSERT INTO outbound (id, tenant_id, recipient, data, at) VALUES (?, ?, ?, ?, ?)`, [m.id, m.tenantId, m.to, JSON.stringify(m), m.at]);
  }
  async listOutbound(filter: { to?: string; tenantId?: string } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.to) (where.push("recipient = ?"), params.push(filter.to));
    if (filter.tenantId) (where.push("tenant_id = ?"), params.push(filter.tenantId));
    const rows = await this.db.all<{ data: string }>(
      `SELECT data FROM outbound ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at, rowid`,
      params,
    );
    return rows.map((r) => JSON.parse(r.data) as OutboundMessage);
  }
  async markProcessed(eventId: string) {
    const r = await this.db.run(`INSERT OR IGNORE INTO processed_events (id, at) VALUES (?, ?)`, [eventId, new Date().toISOString()]);
    return r.changes > 0;
  }
}

/** Adaptador D1 (Cloudflare Workers). */
export function d1Exec(db: D1Database): SqlExec {
  return {
    async run(sql, params) {
      const r = await db.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async all<T>(sql: string, params: unknown[]) {
      const r = await db.prepare(sql).bind(...params).all<T>();
      return r.results;
    },
  };
}
