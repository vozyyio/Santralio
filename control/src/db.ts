// Santralio: PostgreSQL bağlantısı ve migration'lar.
// Bağlantı Unix soketi ve peer kimlik doğrulamasıyla yapılır: veritabanı şifresi yoktur.

import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PG_DATABASE, PG_HOST } from "./config.ts";

export type Db = pg.Client;

export async function connect(): Promise<Db> {
  const db = new pg.Client({ host: PG_HOST, database: PG_DATABASE });
  await db.connect();
  return db;
}

export async function tx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function audit(db: Db, action: string, tenantId: number | null, details: object = {}) {
  const actor = process.env.SUDO_USER ?? process.env.USER ?? "unknown";
  await db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, $3, $4)", [
    actor,
    tenantId,
    action,
    JSON.stringify(details),
  ]);
}

export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await tx(db, async () => {
      await db.query(readFileSync(join(dir, name), "utf8"));
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}
