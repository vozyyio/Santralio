// Santralio: kullanıcı şifreleri, oturumlar ve kiracı erişim kuralı.
// Şifreler scrypt ile özetlenir. Oturum belirteci istemcide durur; veritabanında yalnızca SHA-256 özeti tutulur.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Db } from "./db.ts";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 32768;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

// Biçim: scrypt$N$r$p$tuz(base64)$özet(base64)
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error("şifre en az 10 karakter olmalı");
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFC"), salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password.normalize("NFC"), Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(key, expected);
}

// Kullanıcı yokken de aynı sürede yanıt vermek için kullanılan sahte özet.
let dummyHash: string | null = null;
export async function burnTime(password: string) {
  dummyHash ??= await hashPassword("santralio-dummy-password");
  await verifyPassword(password, dummyHash);
}

export const SESSION_DAYS = 7;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: number, ip: string | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [tokenHash(token), userId, SESSION_DAYS, ip],
  );
  return token;
}

export async function revokeSession(db: Db, token: string) {
  await db.query("UPDATE sessions SET revoked = true WHERE token_hash = $1", [tokenHash(token)]);
}

export type User = {
  id: number;
  email: string;
  name: string;
  role: "platform_admin" | "reseller_admin" | "tenant_admin" | "agent";
  reseller_id: number | null;
  tenant_id: number | null;
  extension_id: number | null;
};

export async function userBySession(db: Db, token: string): Promise<User | null> {
  const row = (
    await db.query(
      `UPDATE sessions s SET last_seen = now()
         FROM users u
        WHERE s.token_hash = $1 AND s.user_id = u.id AND NOT s.revoked AND s.expires_at > now() AND NOT u.disabled
        RETURNING u.id, u.email, u.name, u.role, u.reseller_id, u.tenant_id, u.extension_id`,
      [tokenHash(token)],
    )
  ).rows[0];
  return row ?? null;
}

// Kiracı erişim kuralı. Bütün API uçları kiracıya bu fonksiyondan geçerek ulaşır.
//   read  : kiracının ayarlarını görmek
//   admin : kiracının ayarlarını değiştirmek
export function canAccessTenant(user: User, tenant: { id: number; reseller_id: number }, level: "read" | "admin"): boolean {
  switch (user.role) {
    case "platform_admin":
      return true;
    case "reseller_admin":
      return user.reseller_id !== null && tenant.reseller_id === user.reseller_id;
    case "tenant_admin":
      return user.tenant_id === tenant.id;
    case "agent":
      return level === "read" && user.tenant_id === tenant.id;
    default:
      return false;
  }
}

// Kullanıcının görebileceği kiracıları seçen SQL koşulu ve parametreleri (tenants tablosu "t" takma adıyla).
export function tenantScope(user: User): { where: string; params: unknown[] } {
  switch (user.role) {
    case "platform_admin":
      return { where: "true", params: [] };
    case "reseller_admin":
      return { where: "t.reseller_id = $1", params: [user.reseller_id] };
    default:
      return { where: "t.id = $1", params: [user.tenant_id] };
  }
}
