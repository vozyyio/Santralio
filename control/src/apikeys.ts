// Santralio: işletme API anahtarları. "Authorization: Bearer sk_..." ile panel API'sinin izin verilen uçları kullanılır.
// Anahtar bir kullanıcı gibi davranır: kiracıya bağlı, yalnızca seçilen yetkiler; ayar/personel/ödeme ayarı yetkisi verilemez.

import { createHash } from "node:crypto";
import { randomToken } from "./crypto.ts";
import { audit, type Db } from "./db.ts";
import { UserError } from "./ops.ts";
import { effectivePermissions, type Permission } from "./permissions.ts";
import type { User } from "./auth.ts";

// Anahtara verilebilecek yetkiler.
export const KEY_PERMISSIONS: Permission[] = ["calls.all", "recordings.listen", "reports.view", "crm.use", "payments.request", "bookings.manage"];
const MAX_KEYS = 10;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createKey(db: Db, tenantId: number, creator: User, input: { name?: unknown; permissions?: unknown }) {
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) throw new UserError("anahtar adı gerekli");
  const perms = Array.isArray(input.permissions) ? [...new Set(input.permissions.map(String))] : [];
  if (!perms.length) throw new UserError("en az bir yetki seçin");
  for (const p of perms) {
    if (!KEY_PERMISSIONS.includes(p as Permission)) throw new UserError(`bu yetki anahtara verilemez: ${p}`);
    if (!creator.permissions.includes(p as Permission)) throw new UserError(`sizde olmayan yetki anahtara verilemez: ${p}`);
  }
  const active = (await db.query("SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL", [tenantId])).rows[0].n;
  if (active >= MAX_KEYS) throw new UserError(`en fazla ${MAX_KEYS} etkin anahtar`);
  const token = `sk_${randomToken(36)}`;
  const prefix = token.slice(0, 11);
  const id = (
    await db.query("INSERT INTO api_keys (tenant_id, name, key_prefix, token_hash, permissions, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
      tenantId,
      name,
      prefix,
      hash(token),
      perms,
      creator.email,
    ])
  ).rows[0].id;
  await audit(db, "apikey.create", tenantId, { id, name, permissions: perms }, `api:${creator.email}`);
  return { id, key: token };
}

export async function listKeys(db: Db, tenantId: number) {
  return (
    await db.query(
      `SELECT id, name, key_prefix AS "prefix", permissions, created_by AS "createdBy",
              to_char(created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "createdAt",
              to_char(last_used_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "lastUsedAt",
              to_char(revoked_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "revokedAt"
         FROM api_keys WHERE tenant_id = $1 ORDER BY revoked_at IS NOT NULL, id DESC`,
      [tenantId],
    )
  ).rows;
}

export async function revokeKey(db: Db, tenantId: number, id: number, actor: string) {
  const r = await db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING name", [id, tenantId]);
  if (!r.rowCount) throw new UserError("anahtar bulunamadı", 404);
  await audit(db, "apikey.revoke", tenantId, { id, name: r.rows[0].name }, actor);
}

// Dakikada 300 istek (süreç içi; tek API süreci var).
const windows = new Map<number, { at: number; n: number }>();
export function rateLimited(id: number, now = Date.now()): boolean {
  const w = windows.get(id);
  if (!w || now - w.at > 60_000) {
    windows.set(id, { at: now, n: 1 });
    return false;
  }
  return ++w.n > 300;
}

export async function userByApiKey(db: Db, token: string): Promise<(User & { apiKeyId: number }) | null> {
  if (!/^sk_[a-z0-9]{36}$/.test(token)) return null;
  const row = (
    await db.query(
      `UPDATE api_keys k SET last_used_at = now()
         FROM tenants t LEFT JOIN licenses l ON l.tenant_id = t.id
        WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND t.id = k.tenant_id AND t.status = 'active'
        RETURNING k.id, k.name, k.tenant_id, k.permissions, CASE WHEN l.source = 'vozyy' THEN l.modules END AS modules`,
      [hash(token)],
    )
  ).rows[0];
  if (!row) return null;
  const perms = (row.permissions as Permission[]).filter((p) => KEY_PERMISSIONS.includes(p));
  return {
    id: -row.id,
    apiKeyId: row.id,
    email: `apikey:${row.name}`,
    name: row.name,
    role: "tenant_user",
    reseller_id: null,
    tenant_id: row.tenant_id,
    extension_id: null,
    role_id: null,
    role_name: "API anahtarı",
    permissions: effectivePermissions(perms, row.modules),
  };
}
