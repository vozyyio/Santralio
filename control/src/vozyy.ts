// Santralio: Vozyy lisans entegrasyonu (sözleşme v0.3).
// Vozyy -> Santralio: POST /api/vozyy/events (HMAC imzalı). Santralio -> Vozyy: lisans doğrulama, kurulum durumu.
// Kurallar: imza ham gövde üzerinde, JSON ayrıştırmadan önce doğrulanır; aynı event_id ikinci kez işlenmez;
// aynı lisans için uygulanmış olandan eski occurred_at taşıyan olay uygulanmaz. Vergi bilgileri saklanmaz.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword } from "./auth.ts";
import { CURRENT_KEY_ID, masterKey, PANEL_URL } from "./config.ts";
import { aad, open, seal } from "./crypto.ts";
import { audit, type Db } from "./db.ts";
import * as ops from "./ops.ts";
import { UserError } from "./ops.ts";

export const SIGNATURE_MAX_SKEW_S = 300;
export const RESERVED_SLUGS = new Set(["www", "api", "sip", "panel", "admin"]);
export const SECRET_SIGNING = "santralio-vozyy-signing-secret";
export const SECRET_INBOUND = "santralio-vozyy-inbound-key";
const INVITE_DAYS = 7;
const PLATFORM_RESELLER = 1;

// Lisans modülleri ve kapattıkları yetkiler. supervisor ve mobile henüz yok: yok sayılır.
export const MODULES = ["pbx", "agent_desk", "recording", "reports", "ai", "crm", "outbound", "supervisor", "mobile"] as const;

// --- İmza ---

export function signature(secret: string, timestamp: string, raw: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw])).digest("hex");
}

// Hata yoksa null, varsa nedeni (yanıt 401).
export function verifySignature(secret: string, timestamp: string | undefined, sig: string | undefined, raw: Buffer, nowS: number): string | null {
  if (!timestamp || !sig) return "imza yok";
  if (!/^\d{9,11}$/.test(timestamp)) return "geçersiz zaman damgası";
  if (Math.abs(nowS - Number(timestamp)) > SIGNATURE_MAX_SKEW_S) return "zaman damgası 5 dakikadan eski ya da ileri";
  const expected = Buffer.from(signature(secret, timestamp, raw), "utf8");
  const given = Buffer.from(sig.trim(), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "imza geçersiz";
  return null;
}

// --- Olay gövdesi ---

export type LicenseEvent = {
  event: "license.activated" | "license.updated" | "license.suspended" | "license.cancelled";
  event_id: string;
  occurred_at: Date;
  license: {
    id: string;
    plan: string;
    status: "active" | "suspended" | "cancelled";
    valid_from: Date | null;
    valid_until: Date | null;
    max_extensions: number;
    max_channels: number;
    modules: string[];
  };
  install: { mode: "hosted" | "self_hosted"; panel_domain: string | null; requested_prefix: string | null } | null;
  customer: { id: string | null; company_name: string; contact_name: string; email: string; phone: string; sector: string | null; locale: string | null } | null;
};

const bad = (code: string): never => {
  throw new UserError(code, 400);
};
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
function date(v: unknown, field: string, nullable = false): Date | null {
  if (v == null && nullable) return null;
  if (typeof v !== "string") return bad(`invalid_${field}`);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? bad(`invalid_${field}`) : d;
}
function text(v: unknown, field: string, max: number, required = false): string {
  if (v == null || v === "") return required ? bad(`missing_${field}`) : "";
  if (typeof v !== "string" || v.length > max || /[\r\n\0]/.test(v)) return bad(`invalid_${field}`);
  return v.trim();
}
function limit(v: unknown, field: string): number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100000 ? (v as number) : bad(`invalid_${field}`);
}

// Gerçek alan adı: IP, localhost ya da tek etiketli ad olamaz.
export function validDomain(v: string): boolean {
  const d = v.toLowerCase();
  if (d.length > 253 || d === "localhost" || d.endsWith(".localhost") || d.endsWith(".local") || d.endsWith(".internal")) return false;
  if (/^[0-9.]+$/.test(d) || d.includes(":")) return false;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
}

export function parseEvent(raw: Buffer, headerEventId: string | undefined): LicenseEvent {
  let b: any;
  try {
    b = JSON.parse(raw.toString("utf8"));
  } catch {
    return bad("invalid_json");
  }
  if (!isObj(b)) return bad("invalid_body");
  const events = ["license.activated", "license.updated", "license.suspended", "license.cancelled"];
  if (!events.includes(b.event)) return bad("unknown_event");
  if (typeof b.event_id !== "string" || !/^evt_[A-Za-z0-9_-]{1,64}$/.test(b.event_id)) return bad("invalid_event_id");
  if (headerEventId !== b.event_id) return bad("event_id_mismatch");
  const l = b.license;
  if (!isObj(l)) return bad("missing_license");
  if (typeof l.id !== "string" || !/^lic_[A-Za-z0-9_-]{1,64}$/.test(l.id)) return bad("invalid_license_id");
  if (l.product !== undefined && l.product !== "santralio") return bad("invalid_product");
  if (!["active", "suspended", "cancelled"].includes(l.status)) return bad("invalid_license_status");
  if (!isObj(l.limits)) return bad("missing_limits");
  if (!Array.isArray(l.modules) || !l.modules.every((m: unknown) => typeof m === "string")) return bad("invalid_modules");
  const ev: LicenseEvent = {
    event: b.event,
    event_id: b.event_id,
    occurred_at: date(b.occurred_at, "occurred_at")!,
    license: {
      id: l.id,
      plan: text(l.plan, "plan", 32, true),
      status: l.status,
      valid_from: date(l.valid_from, "valid_from", true),
      valid_until: date(l.valid_until, "valid_until", true),
      max_extensions: limit(l.limits.max_extensions, "max_extensions"),
      max_channels: limit(l.limits.max_channels, "max_channels"),
      modules: l.modules.filter((m: string) => (MODULES as readonly string[]).includes(m)),
    },
    install: null,
    customer: null,
  };
  if (b.install != null) {
    const i = b.install;
    if (!isObj(i) || !["hosted", "self_hosted"].includes(i.mode)) return bad("invalid_install_mode");
    const domain = i.panel_domain == null || i.panel_domain === "" ? null : text(i.panel_domain, "panel_domain", 253).toLowerCase();
    if (i.mode === "self_hosted" && (!domain || !validDomain(domain))) return bad("invalid_panel_domain");
    const prefix = i.requested_prefix == null || i.requested_prefix === "" ? null : text(i.requested_prefix, "requested_prefix", 64);
    ev.install = { mode: i.mode, panel_domain: i.mode === "self_hosted" ? domain : null, requested_prefix: prefix };
  }
  if (b.customer != null) {
    const c = b.customer;
    if (!isObj(c)) return bad("invalid_customer");
    const email = text(c.email, "email", 254).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("invalid_email");
    // tax_office ve tax_number bilerek okunmaz (Santralio'da saklanmaz).
    ev.customer = {
      id: c.id == null ? null : text(c.id, "customer_id", 64),
      company_name: text(c.company_name, "company_name", 200),
      contact_name: text(c.contact_name, "contact_name", 200),
      email,
      phone: text(c.phone, "phone", 40),
      sector: c.sector == null ? null : text(c.sector, "sector", 20),
      locale: c.locale == null ? null : text(c.locale, "locale", 5),
    };
  }
  if (ev.event === "license.activated" && (!ev.install || !ev.customer)) return bad("missing_install_or_customer");
  return ev;
}

// Kısa ad (slug): benzersiz, [a-z0-9-], 3–30 karakter, ayrılmış kelime olamaz.
export async function assertSlug(db: Db, slug: string, exceptTenantId: number | null = null) {
  if (!/^[a-z0-9-]{3,30}$/.test(slug)) bad("invalid_slug");
  if (RESERVED_SLUGS.has(slug)) bad("reserved_slug");
  const taken = (await db.query("SELECT id FROM tenants WHERE slug = $1 AND id IS DISTINCT FROM $2", [slug, exceptTenantId])).rows[0];
  if (taken) bad("slug_taken");
}

// --- Olay işleme ---

export type EventResult = { body: Record<string, unknown>; apply: boolean };

// Çağıran bir veritabanı işlemi (tx) içinde çağırır; 5xx/401 hatalarında işlem geri alınır ve Vozyy yeniden dener.
export async function handleEvent(db: Db, ev: LicenseEvent): Promise<EventResult> {
  const inserted = (
    await db.query(
      `INSERT INTO vozyy_events (event_id, event, license_id, occurred_at, outcome, response) VALUES ($1, $2, $3, $4, 'processing', '{}')
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [ev.event_id, ev.event, ev.license.id, ev.occurred_at],
    )
  ).rowCount;
  if (!inserted) {
    const prev = (await db.query("SELECT response FROM vozyy_events WHERE event_id = $1", [ev.event_id])).rows[0];
    return { body: { ...prev.response, duplicate: true }, apply: false };
  }
  const { outcome, result } = await applyEvent(db, ev);
  await db.query("UPDATE vozyy_events SET outcome = $2, response = $3 WHERE event_id = $1", [ev.event_id, outcome, JSON.stringify(result.body)]);
  return result;
}

async function applyEvent(db: Db, ev: LicenseEvent): Promise<{ outcome: string; result: EventResult }> {
  const lic = (await db.query("SELECT * FROM vozyy_licenses WHERE license_id = $1 FOR UPDATE", [ev.license.id])).rows[0];
  if (lic && ev.occurred_at < lic.last_event_at) {
    return { outcome: "stale", result: { body: { ok: true, status: "ignored_stale" }, apply: false } };
  }
  if (lic?.status === "cancelled") {
    return { outcome: "ignored", result: { body: { ok: true, status: "cancelled" }, apply: false } };
  }
  if (ev.event === "license.activated") return { outcome: "applied", result: await activated(db, ev, lic) };
  // Henüz bilinmeyen lisans: etkinleştirme olayı daha işlenmemiş olabilir; 503 ile Vozyy yeniden dener.
  if (!lic) throw new UserError("license_unknown", 503);
  const status = ev.event === "license.suspended" ? "suspended" : ev.event === "license.cancelled" ? "cancelled" : ev.license.status;
  await saveLicense(db, ev, status, lic.install_mode, lic.install_status, lic.panel_domain, lic.tenant_id);
  if (lic.tenant_id) {
    await db.query("UPDATE tenants SET status = $2 WHERE id = $1", [lic.tenant_id, status]);
    await syncTenantLicense(db, lic.tenant_id, ev, status);
    if (status !== "active") {
      // Panel pasif: kiracı kullanıcılarının oturumları kapanır (veri silinmez).
      await db.query("UPDATE sessions SET revoked = true WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1) AND NOT revoked", [lic.tenant_id]);
    }
    await audit(db, ev.event, lic.tenant_id, { license: ev.license.id, plan: ev.license.plan, status }, "vozyy");
  }
  return { outcome: "applied", result: { body: { ok: true, status: lic.install_status, license_status: status }, apply: !!lic.tenant_id } };
}

async function activated(db: Db, ev: LicenseEvent, lic: any): Promise<EventResult> {
  const install = ev.install!;
  const customer = ev.customer!;
  if (lic && lic.install_mode !== install.mode) bad("install_mode_changed");
  if (install.mode === "self_hosted") {
    await saveLicense(db, ev, "active", "self_hosted", lic?.install_status ?? "awaiting_install", install.panel_domain, null, customer);
    return { body: { ok: true, status: lic?.install_status ?? "awaiting_install" }, apply: false };
  }

  // hosted: kiracı zaten açıksa (yeniden etkinleştirme) yeniden açılmaz.
  if (lic?.tenant_id) {
    await saveLicense(db, ev, "active", "hosted", "provisioned", null, lic.tenant_id, customer);
    await db.query("UPDATE tenants SET status = 'active' WHERE id = $1", [lic.tenant_id]);
    await syncTenantLicense(db, lic.tenant_id, ev, "active");
    const t = (await db.query("SELECT prefix FROM tenants WHERE id = $1", [lic.tenant_id])).rows[0];
    return { body: provisioned(t.prefix, lic.email, false), apply: true };
  }

  const slug = install.requested_prefix ? install.requested_prefix.toLowerCase() : null;
  if (slug) await assertSlug(db, slug);
  if (!customer.email) bad("missing_email");
  if ((await db.query("SELECT 1 FROM users WHERE email = $1", [customer.email])).rowCount) bad("email_in_use");
  const name = customer.company_name || slug || ev.license.id;
  const t = await ops.createTenant(db, name, PLATFORM_RESELLER, slug, "vozyy");
  await saveLicense(db, ev, "active", "hosted", "provisioned", null, t.id, customer);
  await syncTenantLicense(db, t.id, ev, "active");
  const role = (await db.query("SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Patron'", [t.id])).rows[0];
  // Şifre davetle belirlenir; o zamana kadar hesapla giriş yapılamaz (özet biçimi geçersiz).
  const user = (
    await db.query("INSERT INTO users (email, name, password_hash, role, tenant_id, role_id) VALUES ($1, $2, '!davet', 'tenant_user', $3, $4) RETURNING id", [
      customer.email,
      customer.contact_name,
      t.id,
      role.id,
    ])
  ).rows[0];
  const invite = await createInvite(db, user.id);
  const sent = await sendInvite(customer.email, invite.link);
  if (sent) await db.query("UPDATE user_invites SET sent = true WHERE id = $1", [invite.id]);
  await audit(db, "vozyy.provision", t.id, { license: ev.license.id, plan: ev.license.plan, slug, admin: customer.email, inviteSent: sent }, "vozyy");
  return { body: provisioned(t.prefix, customer.email, sent), apply: true };
}

const provisioned = (prefix: string, email: string, inviteSent: boolean) => ({
  ok: true,
  status: "provisioned",
  tenant_prefix: prefix,
  panel_url: PANEL_URL,
  admin_email: email,
  invite_sent: inviteSent,
});

async function saveLicense(
  db: Db,
  ev: LicenseEvent,
  status: string,
  mode: string,
  installStatus: string,
  domain: string | null,
  tenantId: number | null,
  c: LicenseEvent["customer"] = null,
) {
  const l = ev.license;
  await db.query(
    `INSERT INTO vozyy_licenses (license_id, customer_id, plan, status, install_mode, install_status, panel_domain, requested_slug,
                                 valid_from, valid_until, max_extensions, max_channels, modules, tenant_id,
                                 company_name, contact_name, email, phone, sector, locale, last_event_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (license_id) DO UPDATE SET
       customer_id = COALESCE($2, vozyy_licenses.customer_id), plan = $3, status = $4, install_status = $6,
       panel_domain = COALESCE($7, vozyy_licenses.panel_domain), valid_from = $9, valid_until = $10, max_extensions = $11,
       max_channels = $12, modules = $13, tenant_id = COALESCE($14, vozyy_licenses.tenant_id),
       company_name = COALESCE(NULLIF($15, ''), vozyy_licenses.company_name), contact_name = COALESCE(NULLIF($16, ''), vozyy_licenses.contact_name),
       email = COALESCE(NULLIF($17, ''), vozyy_licenses.email), phone = COALESCE(NULLIF($18, ''), vozyy_licenses.phone),
       sector = COALESCE($19, vozyy_licenses.sector), locale = COALESCE($20, vozyy_licenses.locale),
       last_event_at = GREATEST(vozyy_licenses.last_event_at, $21), updated_at = now()`,
    [
      l.id, c?.id ?? null, l.plan, status, mode, installStatus, domain, ev.install?.requested_prefix?.toLowerCase() ?? null,
      l.valid_from, l.valid_until, l.max_extensions, l.max_channels, l.modules, tenantId,
      c?.company_name ?? "", c?.contact_name ?? "", c?.email ?? "", c?.phone ?? "", c?.sector ?? null, c?.locale ?? null, ev.occurred_at,
    ],
  );
}

// Kiracının santral lisansı (licenses) Vozyy lisansından türetilir.
async function syncTenantLicense(db: Db, tenantId: number, ev: LicenseEvent, status: string) {
  const l = ev.license;
  await db.query(
    `INSERT INTO licenses (tenant_id, source, active, valid_until, max_extensions, max_channels, modules, note)
     VALUES ($1, 'vozyy', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET source = 'vozyy', active = $2, valid_until = $3, max_extensions = $4, max_channels = $5,
       modules = $6, note = $7, updated_at = now()`,
    [tenantId, status === "active", l.valid_until, l.max_extensions, l.max_channels, l.modules, `${l.id} · ${l.plan}`],
  );
}

// --- Davet ---

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const inviteLink = (token: string) => `${PANEL_URL}/#/davet/${token}`;

export async function createInvite(db: Db, userId: number): Promise<{ id: number; link: string }> {
  const token = randomBytes(24).toString("base64url");
  const sealed = seal(token, aad.invite(userId), masterKey(CURRENT_KEY_ID), CURRENT_KEY_ID);
  const row = (
    await db.query(
      `INSERT INTO user_invites (user_id, token_hash, token_enc, key_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id`,
      [userId, sha256(token), sealed.enc, sealed.keyId, INVITE_DAYS],
    )
  ).rows[0];
  return { id: row.id, link: inviteLink(token) };
}

// E-posta gönderimi henüz yapılandırılmadı: davet bağlantısı platform panelinde gösterilir.
export async function sendInvite(_email: string, _link: string): Promise<boolean> {
  return false;
}

const INVITE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export async function inviteInfo(db: Db, token: string) {
  if (!INVITE_TOKEN.test(token)) return null;
  return (
    (
      await db.query(
        `SELECT u.email, u.name, t.name AS company FROM user_invites i JOIN users u ON u.id = i.user_id JOIN tenants t ON t.id = u.tenant_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND NOT u.disabled AND t.status = 'active'`,
        [sha256(token)],
      )
    ).rows[0] ?? null
  );
}

export async function acceptInvite(db: Db, token: string, password: string): Promise<string> {
  if (!INVITE_TOKEN.test(token)) throw new UserError("davet bağlantısı geçersiz ya da süresi dolmuş", 404);
  const i = (
    await db.query(
      `SELECT i.id, i.user_id, u.email, u.tenant_id FROM user_invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND NOT u.disabled FOR UPDATE OF i`,
      [sha256(token)],
    )
  ).rows[0];
  if (!i) throw new UserError("davet bağlantısı geçersiz ya da süresi dolmuş", 404);
  if (typeof password !== "string" || password.length < 10 || password.length > 200) throw new UserError("şifre en az 10 karakter olmalı");
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [i.user_id, await hashPassword(password)]);
  await db.query("UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [i.user_id]);
  await audit(db, "user.invite_accepted", i.tenant_id, { email: i.email }, `api:${i.email}`);
  return i.email;
}

// Platform paneli: Vozyy lisansları ve kullanılmamış davet bağlantıları.
export async function listLicenses(db: Db) {
  const rows = (
    await db.query(
      `SELECT l.license_id AS "licenseId", l.plan, l.status, l.install_mode AS "installMode", l.install_status AS "installStatus",
              l.panel_domain AS "panelDomain", l.requested_slug AS slug, l.valid_until AS "validUntil", l.max_extensions AS "maxExtensions",
              l.max_channels AS "maxChannels", l.modules, l.company_name AS company, l.email, l.last_checked_at AS "lastCheckedAt",
              l.check_error AS "checkError", t.prefix,
              (SELECT json_build_object('userId', i.user_id, 'enc', encode(i.token_enc, 'base64'), 'keyId', i.key_id, 'expiresAt', i.expires_at, 'sent', i.sent)
                 FROM user_invites i JOIN users u ON u.id = i.user_id
                WHERE u.tenant_id = l.tenant_id AND i.used_at IS NULL AND i.expires_at > now() ORDER BY i.id DESC LIMIT 1) AS invite
         FROM vozyy_licenses l LEFT JOIN tenants t ON t.id = l.tenant_id ORDER BY l.created_at DESC`,
    )
  ).rows;
  return rows.map(({ invite, ...r }) => ({
    ...r,
    invite: invite
      ? {
          link: inviteLink(open(Buffer.from(invite.enc, "base64"), aad.invite(invite.userId), masterKey(invite.keyId))),
          expiresAt: invite.expiresAt,
          sent: invite.sent,
        }
      : null,
  }));
}
