// Santralio: PostgreSQL bağlantısı ve migration'lar.
// Bağlantı Unix soketi ve peer kimlik doğrulamasıyla yapılır: veritabanı şifresi yoktur.

import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PG_DATABASE, PG_HOST } from "./config.ts";

// CLI tek bağlantı (Client), API havuzdan bağlantı (PoolClient) kullanır; ikisi de ClientBase.
export type Db = pg.ClientBase;

export async function connect(): Promise<pg.Client> {
  const db = new pg.Client({ host: PG_HOST, database: PG_DATABASE });
  await db.connect();
  return db;
}

// İç içe çağrılabilir: dıştaki işlem zaten açıksa içteki ayrı bir işlem açmaz, dıştakinin parçası olur.
const depth = new WeakMap<Db, number>();

export async function tx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  depth.set(db, 1);
  await db.query("BEGIN");
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    depth.delete(db);
  }
}

// actor verilmezse komutu çalıştıran sistem kullanıcısı yazılır (CLI); API giriş yapan kullanıcıyı verir.
export async function audit(db: Db, action: string, tenantId: number | null, details: object = {}, actor?: string) {
  actor ??= process.env.SUDO_USER ?? process.env.USER ?? "unknown";
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
