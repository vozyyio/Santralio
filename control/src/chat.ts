// Santralio: web sitesi sohbet aracı. Telefondaki asistanla aynı mantık (respond, rezervasyon araçları), yazılı kanal.
//
// Güvenlik:
// - Sohbet penceresi api alan adındaki iframe'dir; Content-Security-Policy frame-ancestors yalnızca işletmenin izin verdiği siteler.
// - Oturum belirteci yalnızca iframe'in belleğinde; veritabanında özeti (sha256) tutulur.
// - Sınırlar: oturum başına 40 mesaj, IP başına saatte 20 oturum, işletme başına günde daily_limit oturum, mesaj en fazla 1000 karakter.
// - Kullanıcının yazdıkları veridir (bkz. claude.ts); fiyat/tutar yalnızca rezervasyon bağlantısından ve sunucudan gelir.

import { createHash, randomBytes } from "node:crypto";
import { audit, type Db } from "./db.ts";
import { UserError, type Tenant } from "./ops.ts";
import { randomToken } from "./crypto.ts";
import { emit } from "./webhooks.ts";
import { newState, respond, type ToolExec, type ToolState } from "./ai/assistant.ts";
import type { BookingService, FlowContext, LanguageModel, Turn } from "./ai/providers.ts";
import { DEFAULT_LANG, LANGUAGES } from "./ai/languages.ts";

export const MAX_MESSAGES = 40;
export const MAX_TEXT = 1000;
const IP_SESSIONS_PER_HOUR = 20;

export type Widget = {
  enabled: boolean;
  publicKey: string;
  flow: string;
  title: string;
  greeting: string;
  color: string;
  origins: string[];
  contactPhone: string | null;
  whatsapp: string | null;
  dailyLimit: number;
};

const COLS = `enabled, public_key AS "publicKey", flow, title, greeting, color, origins, contact_phone AS "contactPhone", whatsapp, daily_limit AS "dailyLimit"`;
const hash = (token: string) => createHash("sha256").update(token).digest();
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Site adresi: yalnızca https köken (yol yok). Yerel geliştirme için http://localhost izinli.
export function normalizeOrigin(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim().includes("://") ? v.trim() : `https://${v.trim()}`);
  } catch {
    throw new UserError(`site adresi geçersiz: ${v}`);
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if ((u.protocol !== "https:" && !local) || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes(".") && !local)
    throw new UserError(`site adresi https olmalı: ${v}`);
  return u.origin.toLowerCase();
}

const phone = (v: unknown, name: string): string | null => {
  if (v == null || v === "") return null;
  let s = String(v).replace(/[\s()-]/g, "");
  if (/^0?5\d{9}$/.test(s)) s = "+90" + s.replace(/^0/, "");
  else if (/^0[2-4]\d{9}$/.test(s) || /^0850\d{7}$/.test(s)) s = "+90" + s.slice(1);
  else if (/^90\d{10}$/.test(s)) s = "+" + s;
  if (!/^\+\d{8,15}$/.test(s)) throw new UserError(`${name} geçersiz`);
  return s;
};

export async function getWidget(db: Db, tenantId: number): Promise<Widget | null> {
  return (await db.query(`SELECT ${COLS} FROM chat_widgets WHERE tenant_id = $1`, [tenantId])).rows[0] ?? null;
}

export async function saveWidget(db: Db, t: Tenant, input: Record<string, unknown>, actor?: string): Promise<Widget> {
  const cur = await getWidget(db, t.id);
  const flow = String(input.flow ?? cur?.flow ?? "");
  if (!(await db.query("SELECT 1 FROM ai_flows WHERE tenant_id = $1 AND name = $2", [t.id, flow])).rowCount)
    throw new UserError("önce bir yapay zekâ akışı seçin (Yapay zekâ sekmesi)");
  const enabled = input.enabled === undefined ? (cur?.enabled ?? false) : input.enabled === true;
  const title = clean(input.title ?? cur?.title ?? "Canlı destek", 60) || "Canlı destek";
  const greeting = clean(input.greeting ?? cur?.greeting ?? "", 300);
  const color = String(input.color ?? cur?.color ?? "#1d6fe8").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new UserError("renk #rrggbb olmalı");
  const rawOrigins = input.origins === undefined ? (cur?.origins ?? []) : input.origins;
  if (!Array.isArray(rawOrigins) || rawOrigins.length > 10) throw new UserError("en fazla 10 site adresi");
  const origins = [...new Set(rawOrigins.filter((o) => String(o).trim()).map((o) => normalizeOrigin(String(o))))];
  if (enabled && !origins.length) throw new UserError("sohbetin açılacağı en az bir site adresi girin");
  const contactPhone = input.contactPhone === undefined ? (cur?.contactPhone ?? null) : phone(input.contactPhone, "iletişim telefonu");
  const whatsapp = input.whatsapp === undefined ? (cur?.whatsapp ?? null) : phone(input.whatsapp, "WhatsApp numarası");
  const dailyLimit = input.dailyLimit === undefined ? (cur?.dailyLimit ?? 300) : Number(input.dailyLimit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 10 || dailyLimit > 5000) throw new UserError("günlük sohbet sınırı 10–5000");
  await db.query(
    `INSERT INTO chat_widgets (tenant_id, public_key, enabled, flow, title, greeting, color, origins, contact_phone, whatsapp, daily_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = $3, flow = $4, title = $5, greeting = $6, color = $7, origins = $8,
       contact_phone = $9, whatsapp = $10, daily_limit = $11, updated_at = now()`,
    [t.id, cur?.publicKey ?? "wk_" + randomToken(24), enabled, flow, title, greeting, color, origins, contactPhone, whatsapp, dailyLimit],
  );
  await audit(db, "chat.widget", t.id, { enabled, flow, origins }, actor);
  return (await getWidget(db, t.id))!;
}

// --- Herkese açık taraf ---

type Loaded = { tenant: { id: number; prefix: string; name: string }; widget: Widget; flow: any };

export async function loadByKey(db: Db, key: string): Promise<Loaded | null> {
  if (!/^wk_[a-z0-9]{24}$/.test(key)) return null;
  const r = (
    await db.query(
      `SELECT w.enabled, w.public_key AS "publicKey", w.flow, w.title, w.greeting, w.color, w.origins, w.contact_phone AS "contactPhone",
              w.whatsapp, w.daily_limit AS "dailyLimit", t.id AS tid, t.prefix, t.name AS tname, t.status, t.ai_enabled, row_to_json(f) AS flowrow
         FROM chat_widgets w JOIN tenants t ON t.id = w.tenant_id
         LEFT JOIN ai_flows f ON f.tenant_id = w.tenant_id AND f.name = w.flow
        WHERE w.public_key = $1`,
      [key],
    )
  ).rows[0];
  if (!r || !r.enabled || r.status !== "active" || !r.ai_enabled || !r.flowrow?.enabled) return null;
  const { tid, prefix, tname, flowrow } = r;
  return {
    tenant: { id: tid, prefix, name: tname },
    widget: { enabled: r.enabled, publicKey: r.publicKey, flow: r.flow, title: r.title, greeting: r.greeting, color: r.color, origins: r.origins, contactPhone: r.contactPhone, whatsapp: r.whatsapp, dailyLimit: r.dailyLimit },
    flow: flowrow,
  };
}

export function greetingOf(l: Loaded): string {
  return l.widget.greeting || `Merhaba, ${l.tenant.name} hoş geldiniz. Size nasıl yardımcı olabilirim?`;
}

// Pencerenin ihtiyaç duyduğu, gizli olmayan bilgiler.
export const publicConfig = (l: Loaded) => ({
  title: l.widget.title,
  company: l.tenant.name,
  color: l.widget.color,
  greeting: greetingOf(l),
  contactPhone: l.widget.contactPhone,
  whatsapp: l.widget.whatsapp,
});

export async function start(db: Db, l: Loaded, ip: string, page: string | null) {
  const perIp = (await db.query("SELECT count(*)::int AS n FROM chat_sessions WHERE ip = $1 AND created_at > now() - interval '1 hour'", [ip])).rows[0].n;
  if (perIp >= IP_SESSIONS_PER_HOUR) throw new UserError("çok fazla sohbet başlatıldı; biraz sonra tekrar deneyin", 429);
  const today = (
    await db.query("SELECT count(*)::int AS n FROM chat_sessions WHERE tenant_id = $1 AND created_at > date_trunc('day', now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'", [l.tenant.id])
  ).rows[0].n;
  if (today >= l.widget.dailyLimit) throw new UserError("sohbet şu an kullanılamıyor", 429);
  const token = "cs_" + randomBytes(24).toString("base64url");
  const history: Turn[] = [{ role: "assistant", text: greetingOf(l) }];
  await db.query("INSERT INTO chat_sessions (tenant_id, token_hash, ip, page, history) VALUES ($1, $2, $3, $4, $5)", [
    l.tenant.id,
    hash(token),
    ip,
    page ? clean(page, 300) : null,
    JSON.stringify(history),
  ]);
  return { token, greeting: greetingOf(l) };
}

export type ChatReply = {
  reply: string;
  status: "open" | "handoff" | "ended" | "limit";
  booking: { reference: string; paymentUrl: string | null } | null;
  contact: { phone: string | null; whatsapp: string | null } | null;
};

export type ChatDeps = {
  db: Db;
  llm: LanguageModel | null;
  exec: (tenant: Loaded["tenant"]) => ToolExec;
  services: (tenantId: number) => Promise<BookingService[]>;
};

const today = () => {
  const d = new Date(Date.now() + 3 * 3600_000);
  return `${d.toISOString().slice(0, 10)} ${["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][d.getUTCDay()]}`;
};

// Web sohbetinde numara bilinmez: her hizmete zorunlu "telefon" alanı eklenir (yoksa).
const withContact = (s: BookingService[]): BookingService[] =>
  s.map((x) => (x.fields.some((f) => f.type === "phone") ? x : { ...x, fields: [...x.fields, { key: "telefon", label: "Cep telefonu", type: "phone", required: true }] }));

export async function message(d: ChatDeps, l: Loaded, token: string, text: string): Promise<ChatReply> {
  const msg = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!msg) throw new UserError("mesaj boş");
  if (msg.length > MAX_TEXT) throw new UserError(`mesaj en fazla ${MAX_TEXT} karakter`);
  if (typeof token !== "string" || !token.startsWith("cs_")) throw new UserError("sohbet bulunamadı", 404);
  // Aynı oturumda iki mesaj aynı anda işlenmez (satır kilidi, çağıran işlem içinde).
  const s = (await d.db.query("SELECT * FROM chat_sessions WHERE token_hash = $1 AND tenant_id = $2 FOR UPDATE", [hash(token), l.tenant.id])).rows[0];
  if (!s) throw new UserError("sohbet bulunamadı", 404);
  const contact = { phone: l.widget.contactPhone, whatsapp: l.widget.whatsapp };
  if (s.status !== "open") return { reply: "Bu sohbet sona erdi. Yeni bir sohbet başlatabilirsiniz.", status: s.status, booking: null, contact };
  if (s.messages >= MAX_MESSAGES) {
    await d.db.query("UPDATE chat_sessions SET status = 'limit', updated_at = now() WHERE id = $1", [s.id]);
    return { reply: "Sohbet uzunluk sınırına ulaştı. Ekibimize aşağıdaki yollardan ulaşabilirsiniz.", status: "limit", booking: null, contact };
  }
  if (!d.llm) throw new UserError("sohbet asistanı şu an kullanılamıyor", 503);

  const history: Turn[] = s.history;
  history.push({ role: "caller", text: msg });
  const languages = [...new Set([DEFAULT_LANG, ...((l.flow.languages as string[]) ?? [])])].filter((c) => LANGUAGES.some((x) => x.code === c));
  const fc: FlowContext = {
    company: l.tenant.name,
    instructions: l.flow.instructions ?? "",
    routes: [],
    defaultTarget: null,
    model: l.flow.model,
    languages,
    channel: "chat",
  };
  let tools: { exec: ToolExec; state: ToolState } | null = null;
  if (l.flow.booking) {
    const services = await d.services(l.tenant.id);
    if (services.length) {
      const st: ToolState = s.tool_state ?? newState("chat");
      st.channel = "chat";
      st.created = null;
      fc.booking = { services: withContact(services), nonce: randomBytes(6).toString("hex"), today: today() };
      tools = { exec: d.exec(l.tenant), state: st };
    }
  }
  const dec = await respond(d.llm, fc, history, tools, async (t) => void history.push({ role: "assistant", text: t }));
  const reply = dec.say.trim() || (dec.action === "transfer" ? "Talebinizi ekibimize iletiyorum; en kısa sürede size dönecekler." : "Anlayamadım, tekrar yazar mısınız?");
  history.push({ role: "assistant", text: reply, language: dec.language });
  const status: ChatReply["status"] = dec.action === "transfer" ? "handoff" : dec.action === "end" ? "ended" : "open";
  const created = tools?.state.created ?? null;
  await d.db.query(
    `UPDATE chat_sessions SET history = $2, tool_state = $3, messages = messages + 1, status = $4, language = $5,
            summary = COALESCE($6, summary), booking_ref = COALESCE($7, booking_ref),
            input_tokens = input_tokens + $8, output_tokens = output_tokens + $9, updated_at = now() WHERE id = $1`,
    [s.id, JSON.stringify(history.slice(-80)), tools ? JSON.stringify({ ...tools.state, created: null }) : s.tool_state, status, dec.language, dec.summary, created?.reference ?? null, dec.inputTokens, dec.outputTokens],
  );
  if (status === "handoff")
    await emit(d.db, l.tenant.id, "chat.handoff", { session_id: Number(s.id), summary: dec.summary ?? null, language: dec.language, page: s.page });
  return { reply, status, booking: created, contact: status === "open" ? null : contact };
}

// --- Panel ---

export async function listSessions(db: Db, tenantId: number, limit = 50) {
  return (
    await db.query(
      `SELECT id, status, messages, language, summary, booking_ref AS "bookingRef", page,
              to_char(created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "createdAt",
              (SELECT string_agg(e->>'text', ' ') FROM jsonb_array_elements(history) WITH ORDINALITY x(e, i) WHERE e->>'role' = 'caller' AND i <= 4) AS "firstMessage"
         FROM chat_sessions WHERE tenant_id = $1 AND messages > 0 ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
      [tenantId],
    )
  ).rows;
}

export async function getSession(db: Db, tenantId: number, id: number) {
  const r = (
    await db.query(
      `SELECT id, status, summary, booking_ref AS "bookingRef", page, history, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              to_char(created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "createdAt"
         FROM chat_sessions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!r) throw new UserError("sohbet bulunamadı", 404);
  // Sistem sonuçları (tool) panelde de gösterilir; arayanın/kullanıcının sözleri ayrı.
  return r;
}

// Sohbet penceresi sayfasının CSP'si: yalnızca izin verilen siteler gömebilir.
export const frameHeaders = (origins: string[]) => ({
  "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origins.join(" ") || "'none'"}`,
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
});
