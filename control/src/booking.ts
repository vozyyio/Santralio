// Santralio: rezervasyon bağlantısı (yerleşik ya da işletmenin sistemi) ve rezervasyon kayıtları.
//
// Yapay zekâ (telefon ve web sohbeti) bilgileri toplar; fiyat ve müsaitliği burası söyler, rezervasyonu burası oluşturur.
// İşletme sistemi sözleşmesi (docs/booking-contract.md):
//   POST <api_url>  JSON  { "action": "quote" | "create" | "lookup" | "cancel", ... }
//   X-Santralio-Timestamp, X-Santralio-Signature: sha256=hex(HMAC-SHA256(gizli, zaman + "." + gövde))  (webhook ile aynı)
//   quote  -> { "available": bool, "price": { "amount": "85.00", "currency": "EUR" } | null, "message": "…" | null }
//   create -> { "reference": "…", "status": "confirmed" | "pending", "price": {…} | null, "payment": "none" | "optional" | "required" }
//   lookup -> { "bookings": [ { "reference", "service", "summary", "date", "status" } ] }   (en fazla 5)
//   cancel -> { "ok": bool, "message": "…" | null }

import { randomBytes } from "node:crypto";
import { open, randomToken, seal } from "./crypto.ts";
import { audit, type Db } from "./db.ts";
import { assertPublicHttps, postJson, type PostResult } from "./netguard.ts";
import { UserError } from "./ops.ts";
import { normalizeNumber } from "./outbound.ts";
import { parseAmount } from "./payments/types.ts";
import { emit, sign } from "./webhooks.ts";

export type FieldType = "text" | "date" | "time" | "datetime" | "number" | "phone" | "choice";
export type Field = { key: string; label: string; type: FieldType; required: boolean; choices?: string[] };
export type Service = {
  key: string;
  label: string;
  description: string;
  fields: Field[];
  price: string | null; // yalnızca yerleşik modda: sabit fiyat
  currency: string;
  payment: "none" | "optional" | "required";
};
export type Settings = { mode: "off" | "builtin" | "api"; apiUrl: string | null; services: Service[]; hasSecret: boolean };
export type Keys = { key: (id: string) => Buffer; currentId: string };
export type Post = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<PostResult>;
export type Deps = { db: Db; keys: Keys; post?: Post; resolve?: Parameters<typeof assertPublicHttps>[1]; actor?: string };

const FIELD_TYPES: FieldType[] = ["text", "date", "time", "datetime", "number", "phone", "choice"];
const CURRENCIES = ["TRY", "EUR", "USD", "GBP"];
const aad = (tenantId: number, ref: string) => `booking:${tenantId}:${ref}`;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// --- Hizmet tanımları ---

export function validateServices(v: unknown): Service[] {
  if (!Array.isArray(v)) throw new UserError("hizmetler liste olmalı");
  if (v.length > 20) throw new UserError("en fazla 20 hizmet");
  const keys = new Set<string>();
  return v.map((s: any, i) => {
    const key = String(s?.key ?? "");
    if (!/^[a-z0-9_]{1,32}$/.test(key)) throw new UserError(`${i + 1}. hizmet: kısa ad [a-z0-9_] olmalı`);
    if (keys.has(key)) throw new UserError(`hizmet iki kez: ${key}`);
    keys.add(key);
    const label = clean(s.label, 80);
    if (!label) throw new UserError(`${key}: ad gerekli`);
    if (!Array.isArray(s.fields) || !s.fields.length || s.fields.length > 15) throw new UserError(`${key}: 1-15 alan olmalı`);
    const fk = new Set<string>();
    const fields: Field[] = s.fields.map((f: any) => {
      const k = String(f?.key ?? "");
      if (!/^[a-z0-9_]{1,32}$/.test(k)) throw new UserError(`${key}: alan kısa adı [a-z0-9_] olmalı`);
      if (fk.has(k)) throw new UserError(`${key}: alan iki kez: ${k}`);
      fk.add(k);
      const type = String(f.type ?? "text") as FieldType;
      if (!FIELD_TYPES.includes(type)) throw new UserError(`${key}.${k}: alan türü geçersiz`);
      const fl = clean(f.label, 80);
      if (!fl) throw new UserError(`${key}.${k}: etiket gerekli`);
      const out: Field = { key: k, label: fl, type, required: f.required !== false };
      if (type === "choice") {
        const ch = (Array.isArray(f.choices) ? f.choices : []).map((c: unknown) => clean(c, 60)).filter(Boolean);
        if (ch.length < 2 || ch.length > 20) throw new UserError(`${key}.${k}: seçenek 2-20 olmalı`);
        out.choices = [...new Set<string>(ch)];
      }
      return out;
    });
    const price = s.price === null || s.price === undefined || s.price === "" ? null : parseAmount(s.price);
    if (s.price && !price) throw new UserError(`${key}: fiyat geçersiz (ör. 85.00)`);
    const currency = String(s.currency ?? "TRY");
    if (!CURRENCIES.includes(currency)) throw new UserError(`${key}: para birimi ${CURRENCIES.join(", ")}`);
    const payment = String(s.payment ?? "none") as Service["payment"];
    if (!["none", "optional", "required"].includes(payment)) throw new UserError(`${key}: ödeme none, optional ya da required`);
    return { key, label, description: clean(s.description, 300), fields, price, currency, payment };
  });
}

// --- Ayarlar ---

export async function getSettings(db: Db, tenantId: number): Promise<Settings> {
  const r = (await db.query("SELECT mode, api_url, services, secret_enc IS NOT NULL AS has_secret FROM booking_settings WHERE tenant_id = $1", [tenantId])).rows[0];
  if (!r) return { mode: "off", apiUrl: null, services: [], hasSecret: false };
  return { mode: r.mode, apiUrl: r.api_url, services: r.services, hasSecret: r.has_secret };
}

export async function saveSettings(d: Deps, tenantId: number, input: { mode?: unknown; apiUrl?: unknown; services?: unknown }) {
  const cur = await getSettings(d.db, tenantId);
  const mode = String(input.mode ?? cur.mode) as Settings["mode"];
  if (!["off", "builtin", "api"].includes(mode)) throw new UserError("mod off, builtin ya da api olmalı");
  const services = input.services !== undefined ? validateServices(input.services) : cur.services;
  let apiUrl = input.apiUrl !== undefined ? (input.apiUrl ? String(input.apiUrl) : null) : cur.apiUrl;
  if (mode === "api") {
    if (!apiUrl) throw new UserError("işletme sistemi adresi gerekli");
    apiUrl = (await assertPublicHttps(apiUrl, d.resolve, "işletme sistemi adresi")).toString();
  }
  if (mode !== "off" && !services.length) throw new UserError("en az bir hizmet tanımlayın");
  await d.db.query(
    `INSERT INTO booking_settings (tenant_id, mode, api_url, services) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET mode = $2, api_url = $3, services = $4, updated_at = now()`,
    [tenantId, mode, apiUrl, JSON.stringify(services)],
  );
  let secret: string | null = null;
  if (mode === "api" && !cur.hasSecret) secret = (await rotateSecret(d, tenantId)).secret;
  await audit(d.db, "booking.settings", tenantId, { mode, services: services.map((s) => s.key), host: apiUrl ? new URL(apiUrl).hostname : null }, d.actor);
  return { ...(await getSettings(d.db, tenantId)), secret };
}

export async function rotateSecret(d: Deps, tenantId: number) {
  const secret = "bksec_" + randomToken(40);
  const ref = (await d.db.query("SELECT secret_ref FROM booking_settings WHERE tenant_id = $1", [tenantId])).rows[0]?.secret_ref ?? randomToken(24);
  const s = seal(secret, aad(tenantId, ref), d.keys.key(d.keys.currentId), d.keys.currentId);
  const r = await d.db.query("UPDATE booking_settings SET secret_enc = $2, key_id = $3, secret_ref = $4, updated_at = now() WHERE tenant_id = $1", [tenantId, s.enc, s.keyId, ref]);
  if (!r.rowCount) throw new UserError("önce ayarları kaydedin");
  await audit(d.db, "booking.rotate", tenantId, {}, d.actor);
  return { secret };
}

// --- İşletme sistemi ---

async function callApi(d: Deps, tenantId: number, body: Record<string, unknown>): Promise<any> {
  const row = (await d.db.query("SELECT api_url, secret_enc, key_id, secret_ref FROM booking_settings WHERE tenant_id = $1 AND mode = 'api'", [tenantId])).rows[0];
  if (!row?.api_url || !row.secret_enc) throw new UserError("işletme sistemi bağlantısı yapılandırılmamış");
  const secret = open(row.secret_enc, aad(tenantId, row.secret_ref), d.keys.key(row.key_id));
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const post: Post = d.post ?? ((u, b, h, t) => postJson(u, b, h, t));
  const res = await post(row.api_url, raw, { "x-santralio-timestamp": String(ts), "x-santralio-signature": sign(secret, ts, raw), "x-santralio-action": String(body.action) }, 6000).catch(
    (e) => {
      throw new UserError(`işletme sistemine ulaşılamadı: ${e instanceof Error ? e.message : e}`, 502);
    },
  );
  if (res.status < 200 || res.status > 299) throw new UserError(`işletme sistemi hata döndü (HTTP ${res.status})`, 502);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new UserError("işletme sistemi geçerli JSON dönmedi", 502);
  }
}

const priceOf = (p: any): { amount: string; currency: string } | null => {
  const amount = parseAmount(p?.amount);
  const currency = String(p?.currency ?? "");
  return amount && CURRENCIES.includes(currency) ? { amount, currency } : null;
};

// --- Yapay zekânın kullandığı işlemler ---

export type Request = { service: string; fields: Record<string, string> };
export type Quote = { available: boolean; price: { amount: string; currency: string } | null; message: string | null };

// Büyük/küçük harf farkı yok sayılır; Türkçe I/ı/İ/i aynı kabul edilir (model "VITO" da yazabilir).
export const fold = (v: string) => v.trim().toLocaleLowerCase("tr").replace(/ı/g, "i");

// Alanları hizmet tanımına göre denetler: eksik zorunlu alan, bilinmeyen alan, seçenek dışı değer.
export function checkFields(svc: Service, fields: Record<string, unknown>): { ok: Record<string, string> } | { missing: string[]; invalid: string[] } {
  const ok: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const f of svc.fields) {
    const v = clean(fields?.[f.key], 200);
    if (!v) {
      if (f.required) missing.push(f.label);
      continue;
    }
    if (f.type === "choice" && !f.choices!.some((c) => fold(c) === fold(v))) invalid.push(f.label);
    else if (f.type === "number" && !/^\d{1,6}$/.test(v)) invalid.push(f.label);
    else if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) invalid.push(f.label);
    else if (f.type === "datetime" && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(v)) invalid.push(f.label);
    else if (f.type === "time" && !/^\d{2}:\d{2}$/.test(v)) invalid.push(f.label);
    else if (f.type === "phone" && !normalizeNumber(v)) invalid.push(f.label);
    else ok[f.key] = f.type === "choice" ? f.choices!.find((c) => fold(c) === fold(v))! : v;
  }
  return missing.length || invalid.length ? { missing, invalid } : { ok };
}

function serviceOf(s: Settings, key: string): Service {
  const svc = s.services.find((x) => x.key === key);
  if (!svc) throw new UserError(`hizmet yok: ${key}`);
  return svc;
}

export async function quote(d: Deps, tenantId: number, req: Request, ctx: { phone: string | null }): Promise<Quote> {
  const s = await getSettings(d.db, tenantId);
  if (s.mode === "off") throw new UserError("rezervasyon kapalı");
  const svc = serviceOf(s, req.service);
  const c = checkFields(svc, req.fields);
  if (!("ok" in c)) return { available: false, price: null, message: `eksik ya da geçersiz: ${[...c.missing, ...c.invalid].join(", ")}` };
  if (s.mode === "builtin") return { available: true, price: svc.price ? { amount: svc.price, currency: svc.currency } : null, message: null };
  const r = await callApi(d, tenantId, { action: "quote", service: svc.key, fields: c.ok, phone: ctx.phone });
  return { available: r?.available === true, price: priceOf(r?.price), message: r?.message ? clean(r.message, 300) : null };
}

const newRef = () => "RZ" + randomBytes(8).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8).padEnd(8, "X");

export type Created = {
  reference: string;
  status: "pending" | "confirmed";
  price: { amount: string; currency: string } | null;
  payment: Service["payment"];
  bookingId: number;
};

export async function create(
  d: Deps,
  tenantId: number,
  req: Request,
  ctx: { source: "phone" | "chat"; phone: string | null; customerName: string | null; callId: string | null; aiSessionId: number | null },
): Promise<Created> {
  const s = await getSettings(d.db, tenantId);
  if (s.mode === "off") throw new UserError("rezervasyon kapalı");
  const svc = serviceOf(s, req.service);
  const c = checkFields(svc, req.fields);
  if (!("ok" in c)) throw new UserError(`eksik ya da geçersiz: ${[...c.missing, ...c.invalid].join(", ")}`);
  const ref = newRef();
  let status: Created["status"] = "pending";
  let price = svc.price ? { amount: svc.price, currency: svc.currency } : null;
  let payment = svc.payment;
  let external: string | null = null;
  if (s.mode === "api") {
    const r = await callApi(d, tenantId, {
      action: "create",
      service: svc.key,
      fields: c.ok,
      phone: ctx.phone,
      customer_name: ctx.customerName,
      call_id: ctx.callId,
      santralio_reference: ref,
    });
    if (typeof r?.reference !== "string" || !r.reference.trim()) throw new UserError("işletme sistemi rezervasyon numarası dönmedi", 502);
    external = clean(r.reference, 64);
    status = r.status === "confirmed" ? "confirmed" : "pending";
    price = priceOf(r.price);
    if (["none", "optional", "required"].includes(r.payment)) payment = r.payment;
  }
  const id = (
    await d.db.query(
      `INSERT INTO bookings (tenant_id, public_ref, source, service, service_label, fields, customer_name, phone, amount, currency, status, external_ref, call_id, ai_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [tenantId, ref, ctx.source, svc.key, svc.label, JSON.stringify(c.ok), ctx.customerName, ctx.phone, price?.amount ?? null, price?.currency ?? null, status, external, ctx.callId, ctx.aiSessionId],
    )
  ).rows[0].id as number;
  await audit(d.db, "booking.create", tenantId, { reference: ref, service: svc.key, source: ctx.source, external }, d.actor ?? "ai");
  await emit(d.db, tenantId, "booking.created", {
    reference: ref,
    external_reference: external,
    service: svc.key,
    fields: c.ok,
    customer_name: ctx.customerName,
    phone: ctx.phone,
    amount: price?.amount ?? null,
    currency: price?.currency ?? null,
    status,
    source: ctx.source,
    call_id: ctx.callId,
  });
  return { reference: external ?? ref, status, price, payment, bookingId: id };
}

export type Found = { reference: string; service: string; summary: string; date: string | null; status: string };

// Arayanın rezervasyonları: numara taklit edilebileceği için yalnızca kısa özet (tarih, hizmet, durum).
export async function lookup(d: Deps, tenantId: number, phone: string | null): Promise<Found[]> {
  if (!phone) return [];
  const s = await getSettings(d.db, tenantId);
  if (s.mode === "off") return [];
  if (s.mode === "api") {
    const r = await callApi(d, tenantId, { action: "lookup", phone });
    return (Array.isArray(r?.bookings) ? r.bookings : []).slice(0, 5).map((b: any) => ({
      reference: clean(b.reference, 64),
      service: clean(b.service, 80),
      summary: clean(b.summary, 200),
      date: b.date ? clean(b.date, 32) : null,
      status: clean(b.status, 32),
    }));
  }
  const rows = (
    await d.db.query(
      `SELECT public_ref, service_label, fields, status, created_at FROM bookings
        WHERE tenant_id = $1 AND phone = $2 AND status <> 'cancelled' AND created_at > now() - interval '180 days' ORDER BY id DESC LIMIT 5`,
      [tenantId, phone],
    )
  ).rows;
  return rows.map((b) => {
    const f = b.fields as Record<string, string>;
    const e = Object.entries(f);
    const date = (e.find(([k]) => /tarih|date|gun/.test(k)) ?? e.find(([k]) => /saat|time/.test(k)))?.[1] ?? null;
    return { reference: b.public_ref, service: b.service_label, summary: Object.values(f).slice(0, 4).join(", "), date, status: b.status };
  });
}

// --- Panel ---

export async function list(db: Db, tenantId: number, status?: string | null, limit = 100) {
  const args: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  if (status && ["pending", "confirmed", "cancelled"].includes(status)) where.push(`status = $${args.push(status)}`);
  const services = (await getSettings(db, tenantId)).services;
  const labels = (svc: string) => Object.fromEntries(services.find((x) => x.key === svc)?.fields.map((f) => [f.key, f.label]) ?? []);
  const rows = (
    await db.query(
      `SELECT id, public_ref AS "reference", external_ref AS "externalRef", source, service, service_label AS "serviceLabel", fields,
              customer_name AS "customerName", phone, amount, currency, status, payment_ref AS "paymentRef", note,
              to_char(created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "createdAt"
         FROM bookings WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
      args,
    )
  ).rows;
  // Alanlar panelde etiketleriyle gösterilir (hizmet sonradan değiştiyse kısa ad kalır).
  return rows.map((r) => ({ ...r, labels: labels(r.service) }));
}

export async function setStatus(d: Deps, tenantId: number, id: number, status: "confirmed" | "cancelled", note?: string) {
  const r = await d.db.query(
    `UPDATE bookings SET status = $3, note = COALESCE($4, note), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status <> 'cancelled' AND status <> $3 RETURNING public_ref, external_ref, phone, service`,
    [id, tenantId, status, note ? clean(note, 300) : null],
  );
  if (!r.rowCount) throw new UserError("rezervasyon bulunamadı ya da zaten bu durumda", 404);
  const b = r.rows[0];
  const s = await getSettings(d.db, tenantId);
  if (status === "cancelled" && s.mode === "api" && b.external_ref) await callApi(d, tenantId, { action: "cancel", reference: b.external_ref, phone: b.phone });
  await audit(d.db, `booking.${status}`, tenantId, { reference: b.public_ref }, d.actor);
  await emit(d.db, tenantId, status === "confirmed" ? "booking.confirmed" : "booking.cancelled", { reference: b.public_ref, external_reference: b.external_ref, service: b.service, phone: b.phone });
}

export async function testConnection(d: Deps, tenantId: number) {
  const s = await getSettings(d.db, tenantId);
  if (s.mode !== "api") throw new UserError("yalnızca işletme sistemi modunda");
  const r = await callApi(d, tenantId, { action: "lookup", phone: "+900000000000", test: true });
  return { ok: Array.isArray(r?.bookings) };
}

// İç uçtan ya da sohbetten gelen isteğin biçim denetimi (alan değerleri ayrıca hizmete göre checkFields'ta denetlenir).
export function toRequest(v: any): { service: string; fields: Record<string, string>; payNow: boolean; customerName: string | null } {
  if (!v || typeof v.service !== "string" || !/^[a-z0-9_]{1,32}$/.test(v.service)) throw new UserError("geçersiz hizmet");
  const fields: Record<string, string> = {};
  if (v.fields && typeof v.fields === "object") {
    for (const [k, x] of Object.entries(v.fields).slice(0, 20)) if (/^[a-z0-9_]{1,32}$/.test(k) && typeof x === "string") fields[k] = x.slice(0, 300);
  }
  const name = typeof v.customerName === "string" ? v.customerName.trim().slice(0, 100) : "";
  return { service: v.service, fields, payNow: v.payNow === true, customerName: name || null };
}
