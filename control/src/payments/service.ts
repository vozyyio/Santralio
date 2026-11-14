// Ödeme modülü: sağlayıcı bağlama, profiller, ödeme talebi, sağlayıcı bildirimi ve durum takibi.
// Kurallar:
// - Tutar sunucuda belirlenir (profil sabiti, işletme sistemi ya da yetkili temsilci; her durumda üst sınır).
// - "Ödendi" yalnızca doğrulanmış sağlayıcı bildirimi ya da sunucudan durum sorgusuyla yazılır.
// - Kimlik bilgileri şifreli saklanır, API yanıtlarında hiçbir zaman dönmez.
// - Kart bilgisi Santralio'ya gelmez (tuşlama yalnızca sağlayıcının güvenli tuşlama hizmetiyle; henüz yok).

import { open, randomToken, seal } from "../crypto.ts";
import { audit, type Db } from "../db.ts";
import { UserError } from "../ops.ts";
import { assertPublicHttps as assertPublic, privateAddress } from "../netguard.ts";
import { emit } from "../webhooks.ts";
import { catalogEntry } from "./catalog.ts";
import { netgsmSend, smsText, validateNetgsm } from "./sms.ts";
import { minor, parseAmount, ProviderError, type CallbackInput, type Currency, type Fetch, type Mode, type ProviderStatus, type Reply } from "./types.ts";

export type Keys = { key: (id: string) => Buffer; currentId: string };
export type Deps = { db: Db; keys: Keys; fetch: Fetch; apiBase: string; actor: string };

const aadProvider = (tenantId: number, callbackKey: string) => `payment_providers:${tenantId}:${callbackKey}`;
const aadSms = (tenantId: number) => `payment_sms:${tenantId}`;
const publicId = () => "pay_" + randomToken(20);
const CURRENCIES = ["TRY", "USD", "EUR", "GBP"];
const NAME = /^[a-z0-9_]{1,32}$/;

function bad(msg: string): never {
  throw new UserError(msg);
}

// --- Sağlayıcılar ---

type ProviderRow = {
  id: number;
  tenant_id: number;
  provider: string;
  label: string;
  mode: Mode;
  credentials_enc: Buffer;
  key_id: string;
  callback_key: string;
  enabled: boolean;
  is_default: boolean;
  moto_confirmed_at: Date | null;
};

function creds(row: ProviderRow, keys: Keys): Record<string, string> {
  return JSON.parse(open(row.credentials_enc, aadProvider(row.tenant_id, row.callback_key), keys.key(row.key_id)));
}

// Panelde gösterilecek hal: gizli alanlar yalnızca "girildi" bilgisiyle.
function publicProvider(row: any, keys: Keys) {
  const entry = catalogEntry(row.provider);
  let filled: Record<string, string | boolean> = {};
  try {
    const c = creds(row, keys);
    filled = Object.fromEntries((entry?.fields ?? []).map((f) => [f.key, f.secret ? !!c[f.key] : (c[f.key] ?? "")]));
  } catch {
    filled = {};
  }
  return {
    id: row.id,
    provider: row.provider,
    name: entry?.name ?? row.provider,
    label: row.label,
    mode: row.mode,
    enabled: row.enabled,
    isDefault: row.is_default,
    fields: filled,
    motoConfirmed: !!row.moto_confirmed_at,
    lastTest: row.last_test_at ? { at: row.last_test_at, ok: row.last_test_ok, error: row.last_test_error } : null,
  };
}

export async function listProviders(d: Deps, tenantId: number) {
  const rows = (await d.db.query("SELECT * FROM payment_providers WHERE tenant_id = $1 ORDER BY id", [tenantId])).rows;
  return rows.map((r) => publicProvider(r, d.keys));
}

export async function saveProvider(
  d: Deps,
  tenantId: number,
  input: { id?: number; provider?: string; label?: string; mode?: string; credentials?: Record<string, unknown>; enabled?: boolean; isDefault?: boolean },
) {
  let row: ProviderRow | undefined;
  if (input.id) {
    row = (await d.db.query("SELECT * FROM payment_providers WHERE id = $1 AND tenant_id = $2", [input.id, tenantId])).rows[0];
    if (!row) throw new UserError("sağlayıcı bulunamadı", 404);
  }
  const providerId = row?.provider ?? String(input.provider ?? "");
  const entry = catalogEntry(providerId);
  if (!entry) bad("bilinmeyen sağlayıcı");
  if (entry.status !== "available" || !entry.impl) bad(`${entry.name} henüz bağlanamıyor (yakında)`);
  const mode = (input.mode ?? row?.mode ?? "test") as Mode;
  if (mode !== "test" && mode !== "live") bad("mod test ya da live olmalı");
  if (entry.kind === "test" && mode !== "test") bad("test sağlayıcısı canlıya alınamaz");
  const label = String(input.label ?? row?.label ?? entry.name).trim();
  if (!label || label.length > 80) bad("ad 1-80 karakter olmalı");

  // Gizli alanlar boş gönderilirse eski değer korunur.
  const old = row ? creds(row, d.keys) : {};
  const next: Record<string, string> = {};
  for (const f of entry.fields) {
    const v = input.credentials?.[f.key];
    if (typeof v === "string" && v.trim() !== "") next[f.key] = v.trim();
    else if (old[f.key]) next[f.key] = old[f.key];
  }
  const err = entry.impl.validate(next);
  if (err) bad(err);

  const callbackKey = row?.callback_key ?? randomToken(32);
  const sealed = seal(JSON.stringify(next), aadProvider(tenantId, callbackKey), d.keys.key(d.keys.currentId), d.keys.currentId);
  const enabled = input.enabled ?? row?.enabled ?? true;
  const count = Number((await d.db.query("SELECT count(*) FROM payment_providers WHERE tenant_id = $1", [tenantId])).rows[0].count);
  const isDefault = input.isDefault ?? row?.is_default ?? count === 0;
  if (isDefault) await d.db.query("UPDATE payment_providers SET is_default = false WHERE tenant_id = $1 AND is_default", [tenantId]);

  let id: number;
  if (row) {
    // Mod değişirse önceki test sonucu geçersizdir; canlıya geçişte MOTO onayı yeniden istenir.
    const modeChanged = row.mode !== mode;
    await d.db.query(
      `UPDATE payment_providers SET label = $3, mode = $4, credentials_enc = $5, key_id = $6, enabled = $7, is_default = $8,
         last_test_at = CASE WHEN $9 THEN NULL ELSE last_test_at END, last_test_ok = CASE WHEN $9 THEN NULL ELSE last_test_ok END,
         moto_confirmed_at = CASE WHEN $9 THEN NULL ELSE moto_confirmed_at END, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [row.id, tenantId, label, mode, sealed.enc, sealed.keyId, enabled, isDefault, modeChanged],
    );
    id = row.id;
  } else {
    id = (
      await d.db.query(
        `INSERT INTO payment_providers (tenant_id, provider, label, mode, credentials_enc, key_id, callback_key, enabled, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [tenantId, providerId, label, mode, sealed.enc, sealed.keyId, callbackKey, enabled, isDefault],
      )
    ).rows[0].id;
  }
  await audit(d.db, row ? "payments.provider.update" : "payments.provider.add", tenantId, { id, provider: providerId, mode, enabled }, d.actor);
  return id;
}

export async function testProvider(d: Deps, tenantId: number, id: number) {
  const row: ProviderRow = (await d.db.query("SELECT * FROM payment_providers WHERE id = $1 AND tenant_id = $2", [id, tenantId])).rows[0];
  if (!row) throw new UserError("sağlayıcı bulunamadı", 404);
  const impl = catalogEntry(row.provider)?.impl;
  if (!impl) bad("sağlayıcı desteklenmiyor");
  let error: string | null = null;
  try {
    await impl.test(creds(row, d.keys), row.mode, d.fetch);
  } catch (e) {
    error = e instanceof ProviderError ? e.message : "sağlayıcıya ulaşılamadı";
  }
  await d.db.query("UPDATE payment_providers SET last_test_at = now(), last_test_ok = $3, last_test_error = $4 WHERE id = $1 AND tenant_id = $2", [
    id,
    tenantId,
    !error,
    error,
  ]);
  await audit(d.db, "payments.provider.test", tenantId, { id, ok: !error }, d.actor);
  return { ok: !error, error };
}

export async function deleteProvider(d: Deps, tenantId: number, id: number) {
  const used = (await d.db.query("SELECT 1 FROM payment_requests WHERE provider_id = $1 LIMIT 1", [id])).rows.length > 0;
  if (used) {
    // Geçmiş ödemeler korunur: silmek yerine kapatılır (iade/sorgu için kimlik bilgisi gerekebilir).
    await d.db.query("UPDATE payment_providers SET enabled = false, is_default = false, updated_at = now() WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  } else {
    await d.db.query("UPDATE payment_profiles SET provider_id = NULL WHERE provider_id = $1 AND tenant_id = $2", [id, tenantId]);
    const r = await d.db.query("DELETE FROM payment_providers WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    if (!r.rowCount) throw new UserError("sağlayıcı bulunamadı", 404);
  }
  await audit(d.db, "payments.provider.remove", tenantId, { id, keptForHistory: used }, d.actor);
}

// Tuşlama (MOTO) için işletmenin onayı: 3D Secure yapılamaz, sahtekârlık sorumluluğu işletmededir.
export async function confirmMoto(d: Deps, tenantId: number, id: number, confirmed: boolean) {
  const r = await d.db.query(
    "UPDATE payment_providers SET moto_confirmed_at = CASE WHEN $3 THEN now() END, moto_confirmed_by = CASE WHEN $3 THEN $4 END WHERE id = $1 AND tenant_id = $2",
    [id, tenantId, confirmed, d.actor],
  );
  if (!r.rowCount) throw new UserError("sağlayıcı bulunamadı", 404);
  await audit(d.db, "payments.provider.moto", tenantId, { id, confirmed }, d.actor);
}

// --- SMS ---

export async function getSms(d: Deps, tenantId: number) {
  const row = (await d.db.query("SELECT * FROM payment_sms WHERE tenant_id = $1", [tenantId])).rows[0];
  if (!row) return { sender: "provider" as const, fields: {} };
  let fields: Record<string, string | boolean> = {};
  if (row.credentials_enc) {
    const c = JSON.parse(open(row.credentials_enc, aadSms(tenantId), d.keys.key(row.key_id)));
    fields = { usercode: c.usercode ?? "", msgheader: c.msgheader ?? "", password: !!c.password };
  }
  return { sender: row.sender, fields };
}

export async function saveSms(d: Deps, tenantId: number, input: { sender?: string; credentials?: Record<string, unknown> }) {
  const sender = String(input.sender ?? "");
  if (!["netgsm", "provider", "none"].includes(sender)) bad("SMS gönderici netgsm, provider ya da none olmalı");
  let enc: Buffer | null = null;
  let keyId: string | null = null;
  if (sender === "netgsm") {
    const row = (await d.db.query("SELECT * FROM payment_sms WHERE tenant_id = $1", [tenantId])).rows[0];
    const old = row?.credentials_enc ? JSON.parse(open(row.credentials_enc, aadSms(tenantId), d.keys.key(row.key_id))) : {};
    const next: Record<string, string> = {};
    for (const k of ["usercode", "password", "msgheader"]) {
      const v = input.credentials?.[k];
      next[k] = typeof v === "string" && v.trim() ? v.trim() : (old[k] ?? "");
    }
    const err = validateNetgsm(next);
    if (err) bad(err);
    const s = seal(JSON.stringify(next), aadSms(tenantId), d.keys.key(d.keys.currentId), d.keys.currentId);
    enc = s.enc;
    keyId = s.keyId;
  }
  await d.db.query(
    `INSERT INTO payment_sms (tenant_id, sender, credentials_enc, key_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET sender = $2, credentials_enc = $3, key_id = $4, updated_at = now()`,
    [tenantId, sender, enc, keyId],
  );
  await audit(d.db, "payments.sms.update", tenantId, { sender }, d.actor);
}

// --- Profiller ---

export async function listProfiles(d: Deps, tenantId: number) {
  return (
    await d.db.query(
      `SELECT id, name, title, provider_id AS "providerId", amount_source AS "amountSource", fixed_amount::text AS "fixedAmount",
              max_amount::text AS "maxAmount", currency, lookup_url AS "lookupUrl", methods, max_installment AS "maxInstallment",
              expires_minutes AS "expiresMinutes", ask_text AS "askText", sms_text AS "smsText", success_text AS "successText", enabled
       FROM payment_profiles WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    )
  ).rows;
}

export async function saveProfile(d: Deps, tenantId: number, p: Record<string, any>) {
  const name = String(p.name ?? "");
  if (!NAME.test(name)) bad("profil adı küçük harf, rakam ve _ olmalı (en fazla 32)");
  const title = String(p.title ?? "").trim();
  if (title.length < 4 || title.length > 120) bad("başlık 4-120 karakter olmalı");
  const amountSource = String(p.amountSource ?? "agent");
  if (!["fixed", "agent", "lookup"].includes(amountSource)) bad("tutar kaynağı fixed, agent ya da lookup olmalı");
  const maxAmount = parseAmount(p.maxAmount);
  if (!maxAmount) bad("üst sınır tutarı geçersiz (ör. 5000.00)");
  const fixedAmount = p.fixedAmount == null || p.fixedAmount === "" ? null : parseAmount(p.fixedAmount);
  if (amountSource === "fixed" && !fixedAmount) bad("sabit tutar gerekli");
  if (fixedAmount && minor(fixedAmount) > minor(maxAmount)) bad("sabit tutar üst sınırı aşıyor");
  const currency = String(p.currency ?? "TRY");
  if (!CURRENCIES.includes(currency)) bad("para birimi TRY, USD, EUR ya da GBP olmalı");
  const lookupUrl = p.lookupUrl ? String(p.lookupUrl) : null;
  if (amountSource === "lookup") await assertPublicHttps(lookupUrl);
  const methods = String(p.methods ?? "link");
  if (!["link", "dtmf", "both"].includes(methods)) bad("yöntem link, dtmf ya da both olmalı");
  const maxInstallment = Number(p.maxInstallment ?? 1);
  if (!Number.isInteger(maxInstallment) || maxInstallment < 1 || maxInstallment > 12) bad("taksit 1-12 olmalı");
  const expires = Number(p.expiresMinutes ?? 60);
  if (!Number.isInteger(expires) || expires < 5 || expires > 10080) bad("geçerlilik 5 dakika ile 7 gün arasında olmalı");
  const providerId = p.providerId == null || p.providerId === "" ? null : Number(p.providerId);
  if (providerId !== null) {
    const ok = (await d.db.query("SELECT 1 FROM payment_providers WHERE id = $1 AND tenant_id = $2", [providerId, tenantId])).rows.length;
    if (!ok) bad("sağlayıcı bulunamadı");
  }
  const text = (v: unknown, max: number) => {
    const s = String(v ?? "").trim();
    if (s.length > max) bad(`metin en fazla ${max} karakter olabilir`);
    return s;
  };
  await d.db.query(
    `INSERT INTO payment_profiles (tenant_id, name, title, provider_id, amount_source, fixed_amount, max_amount, currency, lookup_url,
       methods, max_installment, expires_minutes, ask_text, sms_text, success_text, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, name) DO UPDATE SET title = $3, provider_id = $4, amount_source = $5, fixed_amount = $6, max_amount = $7,
       currency = $8, lookup_url = $9, methods = $10, max_installment = $11, expires_minutes = $12, ask_text = $13, sms_text = $14,
       success_text = $15, enabled = $16`,
    [tenantId, name, title, providerId, amountSource, fixedAmount, maxAmount, currency, lookupUrl, methods, maxInstallment, expires, text(p.askText, 400), text(p.smsText, 300), text(p.successText, 300), p.enabled !== false],
  );
  await audit(d.db, "payments.profile.save", tenantId, { name }, d.actor);
}

export async function deleteProfile(d: Deps, tenantId: number, name: string) {
  const r = await d.db.query("UPDATE payment_profiles SET enabled = false WHERE tenant_id = $1 AND name = $2", [tenantId, name]);
  if (!r.rowCount) throw new UserError("profil bulunamadı", 404);
  await audit(d.db, "payments.profile.disable", tenantId, { name }, d.actor);
}

// --- İşletme sisteminden tutar sorgusu (lookup) ---

export async function assertPublicHttps(url: string | null, resolve?: Parameters<typeof assertPublic>[1]): Promise<URL> {
  return assertPublic(url, resolve, "sorgu adresi");
}

async function lookupAmount(d: Deps, url: string, q: { phone: string | null; callId: string | null; reference: string }) {
  const u = await assertPublicHttps(url);
  const res = await d
    .fetch(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: q.phone, call_id: q.callId, reference: q.reference }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
    .catch(() => null);
  if (!res || !res.ok) bad("işletme sisteminden tutar alınamadı");
  const body: any = await res.json().catch(() => null);
  const amount = parseAmount(body?.amount);
  if (!amount) bad("işletme sistemi geçerli bir tutar dönmedi");
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 200) : null;
  return { amount, description };
}

// --- Ödeme talebi ---

export type CreateInput = {
  profile?: string;
  amount?: unknown;
  description?: string;
  phone?: string | null;
  callId?: string | null;
  contactId?: number | null;
  method?: string;
  createdBy: "agent" | "ai" | "ivr" | "api";
  user?: string | null;
  sendSms?: boolean;
  locale?: "tr" | "en";
};

export function normalizePhone(v: unknown): string | null {
  if (v == null || v === "") return null;
  let s = String(v).replace(/[\s()-]/g, "");
  if (/^0?5\d{9}$/.test(s)) s = "+90" + s.replace(/^0/, "");
  else if (/^90\d{10}$/.test(s)) s = "+" + s;
  else if (/^00\d{8,15}$/.test(s)) s = "+" + s.slice(2);
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

export async function createRequest(d: Deps, tenant: { id: number; name: string }, input: CreateInput) {
  const profile = input.profile
    ? (await d.db.query("SELECT * FROM payment_profiles WHERE tenant_id = $1 AND name = $2 AND enabled", [tenant.id, input.profile])).rows[0]
    : null;
  if (input.profile && !profile) bad("ödeme profili bulunamadı ya da kapalı");

  const providerRow: ProviderRow | undefined = (
    await d.db.query(
      profile?.provider_id
        ? "SELECT * FROM payment_providers WHERE id = $2 AND tenant_id = $1 AND enabled"
        : "SELECT * FROM payment_providers WHERE tenant_id = $1 AND enabled AND is_default",
      profile?.provider_id ? [tenant.id, profile.provider_id] : [tenant.id],
    )
  ).rows[0];
  if (!providerRow) bad("etkin bir ödeme sağlayıcısı yok");
  const entry = catalogEntry(providerRow.provider);
  if (!entry?.impl) bad("sağlayıcı desteklenmiyor");

  const method = String(input.method ?? "link");
  if (method !== "link" && method !== "dtmf") bad("yöntem link ya da dtmf olmalı");
  if (profile && profile.methods !== "both" && profile.methods !== method) bad(`bu profilde yalnızca ${profile.methods === "link" ? "bağlantı" : "tuşlama"} kullanılabilir`);
  if (method === "dtmf") {
    if (!entry.features.secureDtmf) bad(`${entry.name} güvenli tuşlama hizmeti sunmuyor; ödeme bağlantısı kullanın`);
    if (!providerRow.moto_confirmed_at) bad("tuşlama için işletmenin MOTO onayı gerekli");
    bad("tuşlamayla ödeme henüz açılmadı");
  }

  const reference = publicId();
  const phone = normalizePhone(input.phone);
  if (input.phone && !phone) bad("telefon numarası geçersiz");

  // Tutar: yapay zekâ ve IVR yalnızca profildeki sabit tutarı ya da işletme sistemini kullanabilir.
  let amount: string | null = null;
  let description = (input.description ?? "").trim();
  const source = profile?.amount_source ?? "agent";
  if (source === "fixed") amount = String(profile.fixed_amount);
  else if (source === "lookup") {
    const r = await lookupAmount(d, profile.lookup_url, { phone, callId: input.callId ?? null, reference });
    amount = r.amount;
    if (r.description) description = r.description;
  } else {
    if (input.createdBy === "ai" || input.createdBy === "ivr") bad("yapay zekâ ve IVR tutarı kendisi belirleyemez; sabit ya da sorgulu profil kullanın");
    amount = parseAmount(input.amount);
    if (!amount) bad("tutar geçersiz (ör. 1500.00)");
  }
  const max = profile ? String(profile.max_amount) : null;
  if (max && minor(amount) > minor(max)) bad(`tutar bu profilin üst sınırını (${max}) aşıyor`);
  if (!profile && minor(amount) > minor("50000.00")) bad("profil olmadan en fazla 50.000 istenebilir");
  if (!description) description = profile?.title ?? "";
  if (description.length < 4 || description.length > 200) bad("açıklama 4-200 karakter olmalı");
  const currency: Currency = (profile?.currency ?? "TRY") as Currency;
  const expiresAt = new Date(Date.now() + (profile?.expires_minutes ?? 60) * 60_000);

  const id = (
    await d.db.query(
      `INSERT INTO payment_requests (public_id, tenant_id, provider_id, profile_id, call_id, contact_id, phone, amount, currency, description,
         method, status, created_by, created_by_user, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'link','created',$11,$12,$13) RETURNING id`,
      [reference, tenant.id, providerRow.id, profile?.id ?? null, input.callId ?? null, input.contactId ?? null, phone, amount, currency, description, input.createdBy, input.user ?? null, expiresAt],
    )
  ).rows[0].id;

  const c = creds(providerRow, d.keys);
  let link;
  try {
    link = await entry.impl.createLink(
      c,
      providerRow.mode,
      {
        reference,
        description,
        money: { amount, currency },
        maxInstallment: profile?.max_installment ?? 1,
        expiresAt,
        callbackUrl: `${d.apiBase}/api/payments/callback/${providerRow.callback_key}`,
        phone,
        locale: input.locale ?? "tr",
      },
      d.fetch,
    );
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : "sağlayıcıya ulaşılamadı";
    // Kayıt kalsın: bu hata işlemi geri almaz (talep "başarısız" olarak görünür).
    await d.db.query("UPDATE payment_requests SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, msg]);
    await audit(d.db, "payments.request.failed", tenant.id, { reference, error: msg }, d.actor);
    return { ...(await getRequest(d, tenant.id, reference)), failed: true as const };
  }
  await d.db.query("UPDATE payment_requests SET provider_ref = $2, link_url = $3, updated_at = now() WHERE id = $1", [id, link.providerRef, link.url]);

  // SMS: işletmenin seçtiği gönderici (sağlayıcının kendi SMS'i, Netgsm ya da hiçbiri).
  let smsStatus: "sent" | "failed" | "skipped" = "skipped";
  let smsError: string | null = null;
  if (phone && input.sendSms !== false) {
    const sms = (await d.db.query("SELECT * FROM payment_sms WHERE tenant_id = $1", [tenant.id])).rows[0] ?? { sender: "provider" };
    try {
      if (sms.sender === "netgsm") {
        const sc = JSON.parse(open(sms.credentials_enc, aadSms(tenant.id), d.keys.key(sms.key_id)));
        await netgsmSend(sc, phone, smsText(profile?.sms_text ?? "", { company: tenant.name, amount, currency, description, link: link.url }), d.fetch);
        smsStatus = "sent";
      } else if (sms.sender === "provider" && entry.impl.sendLinkSms) {
        await entry.impl.sendLinkSms(c, providerRow.mode, link.providerRef, phone, d.fetch);
        smsStatus = "sent";
      } else if (sms.sender !== "none") {
        smsError = `${entry.name} kendi SMS'ini göndermiyor; Ödeme ayarlarından bir SMS hesabı tanımlayın`;
        smsStatus = "failed";
      }
    } catch (e) {
      smsStatus = "failed";
      smsError = e instanceof ProviderError ? e.message : "SMS gönderilemedi";
    }
  }
  await d.db.query("UPDATE payment_requests SET status = $2, sms_status = $3, error = $4, updated_at = now() WHERE id = $1", [
    id,
    smsStatus === "sent" ? "sent" : "created",
    phone ? smsStatus : null,
    smsError,
  ]);
  await audit(d.db, "payments.request.create", tenant.id, { reference, amount, currency, by: input.createdBy, sms: smsStatus }, d.actor);
  return getRequest(d, tenant.id, reference);
}

const REQUEST_COLUMNS = `r.public_id AS id, r.status, r.method, r.amount::text AS amount, r.currency, r.description, r.phone, r.call_id AS "callId",
  r.contact_id AS "contactId", r.link_url AS "linkUrl", r.sms_status AS "smsStatus", r.card_last4 AS "cardLast4",
  r.paid_amount::text AS "paidAmount", r.error, r.created_by AS "createdBy", r.created_by_user AS "createdByUser",
  r.expires_at AS "expiresAt", r.paid_at AS "paidAt", r.created_at AS "createdAt", p.provider, p.label AS "providerLabel", p.mode,
  pr.name AS profile`;

export async function getRequest(d: Deps, tenantId: number, reference: string) {
  const row = (
    await d.db.query(
      `SELECT ${REQUEST_COLUMNS} FROM payment_requests r JOIN payment_providers p ON p.id = r.provider_id
       LEFT JOIN payment_profiles pr ON pr.id = r.profile_id WHERE r.tenant_id = $1 AND r.public_id = $2`,
      [tenantId, reference],
    )
  ).rows[0];
  if (!row) throw new UserError("ödeme talebi bulunamadı", 404);
  return row;
}

export async function listRequests(d: Deps, tenantId: number, f: { status?: string; callId?: string; user?: string | null; limit?: number }) {
  const where = ["r.tenant_id = $1"];
  const args: unknown[] = [tenantId];
  if (f.status) {
    args.push(f.status);
    where.push(`r.status = $${args.length}`);
  }
  if (f.callId) {
    args.push(f.callId);
    where.push(`r.call_id = $${args.length}`);
  }
  if (f.user) {
    args.push(f.user);
    where.push(`r.created_by_user = $${args.length}`);
  }
  args.push(Math.min(500, Math.max(1, Number.isFinite(f.limit) ? f.limit! : 100)));
  return (
    await d.db.query(
      `SELECT ${REQUEST_COLUMNS} FROM payment_requests r JOIN payment_providers p ON p.id = r.provider_id
       LEFT JOIN payment_profiles pr ON pr.id = r.profile_id WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT $${args.length}`,
      args,
    )
  ).rows;
}

export async function cancelRequest(d: Deps, tenantId: number, reference: string) {
  const row = (
    await d.db.query("SELECT r.* FROM payment_requests r WHERE r.tenant_id = $1 AND r.public_id = $2 FOR UPDATE", [tenantId, reference])
  ).rows[0];
  if (!row) throw new UserError("ödeme talebi bulunamadı", 404);
  if (!["created", "sent"].includes(row.status)) bad("yalnızca bekleyen talepler iptal edilebilir");
  await d.db.query("UPDATE payment_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [row.id]);
  await emit(d.db, tenantId, "payment.cancelled", payEvent(row));
  await closeLink(d, row.provider_id, row.provider_ref);
  await audit(d.db, "payments.request.cancel", tenantId, { reference }, d.actor);
}

async function closeLink(d: Deps, providerId: number, ref: string | null) {
  if (!ref) return;
  const p: ProviderRow = (await d.db.query("SELECT * FROM payment_providers WHERE id = $1", [providerId])).rows[0];
  const impl = p && catalogEntry(p.provider)?.impl;
  await impl?.cancelLink?.(creds(p, d.keys), p.mode, ref, d.fetch).catch(() => {});
}

// Webhook gövdesi (kart bilgisi yok; yalnızca son 4 hane sağlayıcıdan geldiyse).
function payEvent(r: any, extra: Record<string, unknown> = {}) {
  return {
    reference: r.public_id,
    amount: String(r.amount),
    currency: r.currency,
    description: r.description,
    method: r.method,
    phone: r.phone ?? null,
    call_id: r.call_id ?? null,
    created_by: r.created_by,
    ...extra,
  };
}

// --- Durum güncelleme (tek kapı) ---

async function applyStatus(d: Deps, requestId: number, st: ProviderStatus, source: string): Promise<string> {
  const r = (await d.db.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
  if (!r) return "talep yok";
  if (r.status === "paid") return "zaten ödendi";
  if (st.state === "paid") {
    const paid = st.paidAmount ? parseAmount(st.paidAmount) : null;
    // Ödenen tutar talep tutarından azsa "ödendi" yazılmaz.
    if (paid && minor(paid) < minor(String(r.amount))) {
      await d.db.query("UPDATE payment_requests SET status = 'failed', error = $2, paid_amount = $3, updated_at = now() WHERE id = $1", [requestId, "ödenen tutar talep edilenden az", paid]);
      await audit(d.db, "payments.request.amount_mismatch", r.tenant_id, { reference: r.public_id, paid, source }, "payments");
      await emit(d.db, r.tenant_id, "payment.failed", payEvent(r, { paid_amount: paid, reason: "amount_mismatch" }));
      return "tutar uyuşmuyor";
    }
    // Süresi dolmuş/iptal edilmiş olsa bile para alındıysa kayıt "ödendi" olur (iade kararı işletmenin).
    await d.db.query(
      "UPDATE payment_requests SET status = 'paid', paid_at = now(), paid_amount = $2, card_last4 = $3, error = CASE WHEN status IN ('expired','cancelled') THEN 'süre dolduktan / iptalden sonra ödendi' ELSE NULL END, updated_at = now() WHERE id = $1",
      [requestId, paid ?? r.amount, st.last4 ?? null],
    );
    await audit(d.db, "payments.request.paid", r.tenant_id, { reference: r.public_id, source }, "payments");
    await emit(d.db, r.tenant_id, "payment.paid", payEvent(r, { paid_amount: String(paid ?? r.amount), card_last4: st.last4 ?? null, late: ["expired", "cancelled"].includes(r.status) }));
    return "ödendi";
  }
  if (st.state === "failed" && ["created", "sent"].includes(r.status)) {
    // Başarısız deneme talebi kapatmaz: müşteri aynı bağlantıyla tekrar deneyebilir.
    await d.db.query("UPDATE payment_requests SET error = 'başarısız ödeme denemesi', updated_at = now() WHERE id = $1", [requestId]);
    return "başarısız deneme";
  }
  return "değişiklik yok";
}

// Sağlayıcı bildirimi. callbackKey adresten gelir; imzayı sağlayıcı adaptörü doğrular.
export async function handleCallback(d: Deps, callbackKey: string, input: CallbackInput): Promise<Reply> {
  const notFound: Reply = { status: 404, type: "text/plain", body: "not found" };
  if (!/^[a-z0-9]{32}$/.test(callbackKey)) return notFound;
  const p: ProviderRow = (await d.db.query("SELECT * FROM payment_providers WHERE callback_key = $1", [callbackKey])).rows[0];
  const impl = p && catalogEntry(p.provider)?.impl;
  if (!impl?.verifyCallback) return notFound;
  const v = impl.verifyCallback(creds(p, d.keys), p.mode, input);
  if (!v.ok) {
    await audit(d.db, "payments.callback.rejected", p.tenant_id, { provider: p.provider, reason: v.reason }, "payments");
    return v.reply;
  }
  const req = (
    await d.db.query("SELECT id FROM payment_requests WHERE provider_id = $1 AND (public_id = $2 OR ($3::text IS NOT NULL AND provider_ref = $3))", [
      p.id,
      v.reference ?? "",
      v.providerRef ?? null,
    ])
  ).rows[0];
  const ins = await d.db.query("INSERT INTO payment_events (provider_id, dedupe_key, request_id, outcome) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id", [
    p.id,
    v.dedupeKey,
    req?.id ?? null,
    v.status.state,
  ]);
  if (!ins.rows.length) return v.reply; // aynı bildirim: yeniden işlenmez
  if (req) await applyStatus(d, req.id, v.status, `callback:${p.provider}`);
  else await audit(d.db, "payments.callback.unknown", p.tenant_id, { provider: p.provider, dedupe: v.dedupeKey }, "payments");
  return v.reply;
}

// Test sağlayıcısının sayfası: yalnızca test modundaki "test" sağlayıcısının talepleri için.
export async function testPageInfo(d: Deps, reference: string) {
  const r = (
    await d.db.query(
      `SELECT r.id, r.public_id, r.amount::text AS amount, r.currency, r.description, r.status, r.expires_at, t.name AS tenant
       FROM payment_requests r JOIN payment_providers p ON p.id = r.provider_id JOIN tenants t ON t.id = r.tenant_id
       WHERE r.public_id = $1 AND p.provider = 'test' AND p.mode = 'test'`,
      [reference],
    )
  ).rows[0];
  return r ?? null;
}

export async function testPageResult(d: Deps, reference: string, outcome: "paid" | "failed") {
  const r = await testPageInfo(d, reference);
  if (!r) throw new UserError("bulunamadı", 404);
  if (new Date(r.expires_at) < new Date() && r.status !== "paid") throw new UserError("bağlantının süresi dolmuş", 410);
  return applyStatus(d, r.id, outcome === "paid" ? { state: "paid", paidAmount: r.amount, last4: "0000" } : { state: "failed" }, "test-page");
}

// Arka plan işi: süresi dolanları kapatır; bildirimi olmayan sağlayıcılarda durumu sorgular.
export async function poll(d: Deps): Promise<{ checked: number; paid: number; expired: number }> {
  let paid = 0;
  const expired = (
    await d.db.query(
      "UPDATE payment_requests SET status = 'expired', updated_at = now() WHERE status IN ('created','sent') AND expires_at < now() - interval '2 minutes' RETURNING *",
    )
  ).rows;
  for (const e of expired) {
    await emit(d.db, e.tenant_id, "payment.expired", payEvent(e));
    await closeLink(d, e.provider_id, e.provider_ref);
  }
  const open = (
    await d.db.query(
      `SELECT r.id AS request_id, r.provider_ref, p.* FROM payment_requests r JOIN payment_providers p ON p.id = r.provider_id
       WHERE r.status IN ('created','sent') AND r.provider_ref IS NOT NULL ORDER BY r.updated_at LIMIT 200`,
    )
  ).rows;
  let checked = 0;
  for (const row of open) {
    const impl = catalogEntry(row.provider)?.impl;
    if (!impl?.fetchStatus) continue;
    checked++;
    try {
      const st = await impl.fetchStatus(creds(row, d.keys), row.mode, row.provider_ref, d.fetch);
      if (st.state !== "pending" && (await applyStatus(d, row.request_id, st, `poll:${row.provider}`)) === "ödendi") paid++;
      else await d.db.query("UPDATE payment_requests SET updated_at = now() WHERE id = $1", [row.request_id]);
    } catch {
      await d.db.query("UPDATE payment_requests SET updated_at = now() WHERE id = $1", [row.request_id]);
    }
  }
  return { checked, paid, expired: expired.length };
}

export const _test = { privateAddress };
