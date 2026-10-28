import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqlStore, type SqlExec } from "./store";

/** Store persistente en SQLite usando el módulo nativo de Node 22 (sin dependencias nativas que compilar). */
export async function createSqliteStore(path: string): Promise<SqlStore> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const exec: SqlExec = {
    async run(sql, params) {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  const store = new SqlStore(exec);
  await store.init();
  return store;
}
