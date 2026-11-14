// Santralio: kaçan çağrıya otomatik yapay zekâ geri araması.
//
// Akış: gelen çağrı kuyrukta kapatılır / süresi dolar / temsilci bulunamazsa (queue_log) iş oluşturulur.
// Gecikme (ör. 20 sn) sonra, izinli saat aralığındaysa, kiracının hattından arayan geri aranır; açınca
// tN-callback -> yapay zekâ akışı ("Az önce bizi aramışsınız…"). Yapay zekâ oturumu başlayınca iş "answered" olur.
//
// Kurallar:
// - Yalnızca gelen çağrılar; gizli/geçersiz numara aranmaz; varsayılan yalnızca Türkiye (sabit 2-4xx ve cep 5xx).
// - Aynı numara bekleme süresi (cooldown) içinde bir kez; aramak istemeyenler listesi; en fazla N deneme.
// - Arayan bu arada başka bir çağrıda görüşüldüyse (gelen ya da giden, cevaplanmış) iş "resolved" olur.
// - Eş zamanlı geri arama sınırı ve lisans kanal sınırı; gece/izinsiz saatte arama yok, çok eski kaçanlar düşer.
// - Geri arama her zaman yapay zekâ olduğunu söyleyerek başlar (karşılama metni).

import { listCalls, type CallRow } from "./reports.ts";
import { audit, type Db } from "./db.ts";
import { UserError } from "./ops.ts";
import { hasModule } from "./permissions.ts";
import { emit } from "./webhooks.ts";

export type Settings = {
  enabled: boolean;
  aiFlow: string;
  delayS: number;
  maxAttempts: number;
  retryMinutes: number;
  cooldownHours: number;
  maxAgeMinutes: number;
  maxConcurrent: number;
  windowStart: string; // HH:MM
  windowEnd: string;
  weekdays: number[]; // ISO 1-7
  timezone: string;
  international: boolean;
  greetingTr: string;
  greetingEn: string;
};

export const DEFAULT_GREETING_TR =
  "Merhaba, ben {firma} yapay zekâ asistanıyım. Az önce bizi aramışsınız ama çağrınızı cevaplayamadık, kusura bakmayın. Size nasıl yardımcı olabilirim?";
export const DEFAULT_GREETING_EN =
  "Hello, this is the AI assistant of {firma}. You called us a moment ago and we missed your call, sorry about that. How can I help you?";

// Yapay zekâ akışının talimatlarının önüne eklenir (yalnızca geri aramada).
export const CALLBACK_INSTRUCTIONS =
  "BU GÖRÜŞMEYİ SEN BAŞLATTIN: Karşındaki kişi az önce işletmeyi aradı, çağrısı cevaplanamadı ve sen onu geri arıyorsun. " +
  "Kısa ve kibar ol. Kişi müsait değilse ya da aranmak istemediğini söylerse özür dile, bir daha aranmayacağını söyle ve görüşmeyi bitir. " +
  "Satış baskısı yapma. Yardım edemediğin konuda temsilciye aktar.";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const FLOW = /^[a-z0-9_]{1,32}$/;

export function validateSettings(s: Partial<Settings>, base: Settings): Settings {
  const out = { ...base, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) } as Settings;
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new UserError(`${name} ${lo}-${hi} arasında olmalı`);
  };
  if (!FLOW.test(out.aiFlow)) throw new UserError("yapay zekâ akışı seçin");
  int(out.delayS, 5, 3600, "gecikme (sn)");
  int(out.maxAttempts, 1, 5, "deneme sayısı");
  int(out.retryMinutes, 2, 240, "yeniden deneme (dk)");
  int(out.cooldownHours, 1, 168, "aynı numarayı tekrar arama aralığı (saat)");
  int(out.maxAgeMinutes, 5, 1440, "en eski kaçan çağrı (dk)");
  int(out.maxConcurrent, 1, 10, "eş zamanlı geri arama");
  if (!HHMM.test(out.windowStart) || !HHMM.test(out.windowEnd) || out.windowStart >= out.windowEnd) throw new UserError("arama saatleri geçersiz (ör. 09:00-21:00)");
  if (!Array.isArray(out.weekdays) || !out.weekdays.length || out.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new UserError("günler 1-7 olmalı");
  out.weekdays = [...new Set(out.weekdays)].sort();
  try {
    new Intl.DateTimeFormat("en", { timeZone: out.timezone });
  } catch {
    throw new UserError("saat dilimi geçersiz");
  }
  for (const k of ["greetingTr", "greetingEn"] as const) {
    out[k] = String(out[k] ?? "").trim();
    if (out[k].length > 500) throw new UserError("karşılama metni en fazla 500 karakter");
  }
  out.enabled = !!out.enabled;
  out.international = !!out.international;
  return out;
}

const DEFAULTS: Settings = {
  enabled: false,
  aiFlow: "",
  delayS: 20,
  maxAttempts: 2,
  retryMinutes: 10,
  cooldownHours: 6,
  maxAgeMinutes: 120,
  maxConcurrent: 1,
  windowStart: "09:00",
  windowEnd: "21:00",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  timezone: "Europe/Istanbul",
  international: false,
  greetingTr: "",
  greetingEn: "",
};

const fromRow = (r: any): Settings => ({
  enabled: r.enabled,
  aiFlow: r.ai_flow,
  delayS: r.delay_s,
  maxAttempts: r.max_attempts,
  retryMinutes: r.retry_minutes,
  cooldownHours: r.cooldown_hours,
  maxAgeMinutes: r.max_age_minutes,
  maxConcurrent: r.max_concurrent,
  windowStart: r.window_start.slice(0, 5),
  windowEnd: r.window_end.slice(0, 5),
  weekdays: r.weekdays,
  timezone: r.timezone,
  international: r.international,
  greetingTr: r.greeting_tr,
  greetingEn: r.greeting_en,
});

export async function getSettings(db: Db, tenantId: number): Promise<Settings> {
  const r = (await db.query("SELECT *, window_start::text, window_end::text FROM callback_settings WHERE tenant_id = $1", [tenantId])).rows[0];
  return r ? fromRow(r) : { ...DEFAULTS };
}

export async function saveSettings(db: Db, tenantId: number, input: Partial<Settings>, actor: string): Promise<Settings> {
  const s = validateSettings(input, await getSettings(db, tenantId));
  const flow = (await db.query("SELECT enabled FROM ai_flows WHERE tenant_id = $1 AND name = $2", [tenantId, s.aiFlow])).rows[0];
  if (!flow) throw new UserError("seçilen yapay zekâ akışı yok");
  if (s.enabled && !flow.enabled) throw new UserError("seçilen yapay zekâ akışı kapalı");
  await db.query(
    `INSERT INTO callback_settings (tenant_id, enabled, ai_flow, delay_s, max_attempts, retry_minutes, cooldown_hours, max_age_minutes, max_concurrent,
       window_start, window_end, weekdays, timezone, international, greeting_tr, greeting_en, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, ai_flow = $3, delay_s = $4, max_attempts = $5, retry_minutes = $6, cooldown_hours = $7,
       max_age_minutes = $8, max_concurrent = $9, window_start = $10, window_end = $11, weekdays = $12, timezone = $13, international = $14,
       greeting_tr = $15, greeting_en = $16, updated_at = now()`,
    [tenantId, s.enabled, s.aiFlow, s.delayS, s.maxAttempts, s.retryMinutes, s.cooldownHours, s.maxAgeMinutes, s.maxConcurrent, s.windowStart, s.windowEnd, s.weekdays, s.timezone, s.international, s.greetingTr, s.greetingEn],
  );
  await audit(db, "callbacks.settings", tenantId, { enabled: s.enabled, aiFlow: s.aiFlow }, actor);
  return s;
}

// --- Numara ---

// Arayan numarası (queue_log'da rakamlar, + ile ya da 0'la) E.164'e çevrilir.
// Türkiye: yalnızca sabit (2-4xx) ve cep (5xx). 0850/444/0900 gibi numaralar aranmaz.
export function normalizeCaller(raw: string | null | undefined, international: boolean): { e164: string; dial: string } | { skip: string; e164?: string } {
  const s = String(raw ?? "").replace(/[^\d+]/g, "");
  if (!s || /^0+$/.test(s) || /anonymous|unknown/i.test(String(raw))) return { skip: "gizli numara" };
  let tr: string | null = null;
  if (/^\+90\d{10}$/.test(s)) tr = s.slice(3);
  else if (/^90\d{10}$/.test(s)) tr = s.slice(2);
  else if (/^0\d{10}$/.test(s)) tr = s.slice(1);
  else if (/^\d{10}$/.test(s) && /^[2-5]/.test(s)) tr = s;
  if (tr) {
    if (!/^[2-5]\d{9}$/.test(tr)) return { skip: "aranamayan numara türü" };
    return { e164: `+90${tr}`, dial: `0${tr}` };
  }
  const intl = s.startsWith("+") ? s.slice(1) : s.startsWith("00") ? s.slice(2) : null;
  if (!intl || !/^[1-9]\d{7,14}$/.test(intl)) return { skip: "geçersiz numara" };
  if (!international) return { skip: "yurt dışı numara (ayarlarda kapalı)", e164: `+${intl}` };
  return { e164: `+${intl}`, dial: `00${intl}` };
}

// --- Zaman ---

function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) + 1;
  return { weekday: wd, hhmm: `${g("hour")}:${g("minute")}` };
}

export function inWindow(s: Pick<Settings, "windowStart" | "windowEnd" | "weekdays" | "timezone">, now: Date): boolean {
  const { weekday, hhmm } = localParts(now, s.timezone);
  return s.weekdays.includes(weekday) && hhmm >= s.windowStart && hhmm < s.windowEnd;
}

// Raporların yerel zaman metnini ("YYYY-MM-DD HH:MM:SS", kiracı saat dilimi) UTC'ye çevirir.
export function localToDate(local: string, tz: string): Date {
  const asUtc = Date.parse(local.replace(" ", "T") + "Z");
  const offset = (d: number) => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .format(new Date(d))
      .replace(", ", "T");
    return Date.parse(p + "Z") - d;
  };
  return new Date(asUtc - offset(asUtc - offset(asUtc)));
}

const isoDay = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// --- Arayıcı (Asterisk) ---

export interface Dialer {
  // Kiracının hattından geri arama başlatır (asenkron). Açınca tN-callback,s,1'e girilir.
  originate(o: { prefix: string; dial: string; e164: string; jobId: number; callerId: string; timeoutS: number }): Promise<void>;
  // Kiracının şu an açık kanal sayısı (lisans kanal sınırı için).
  activeChannels(prefix: string): Promise<number>;
}

const RING_S = 30;

// --- Zamanlayıcı ---

type TenantRow = { id: number; prefix: string; max_channels: number | null; username: string; settings: Settings };

async function eligibleTenants(db: Db): Promise<TenantRow[]> {
  const rows = (
    await db.query(
      `SELECT t.id, t.prefix, l.max_channels, tr.username, cs.*, cs.window_start::text, cs.window_end::text,
              CASE WHEN l.source = 'vozyy' THEN l.modules END AS modules
         FROM callback_settings cs
         JOIN tenants t ON t.id = cs.tenant_id
         JOIN trunks tr ON tr.tenant_id = t.id AND tr.enabled
         JOIN ai_flows f ON f.tenant_id = t.id AND f.name = cs.ai_flow AND f.enabled
         LEFT JOIN licenses l ON l.tenant_id = t.id
        WHERE cs.enabled AND t.status = 'active' AND t.ai_enabled AND l.active AND (l.valid_until IS NULL OR l.valid_until > now())`,
    )
  ).rows;
  return rows
    .filter((r) => hasModule(r.modules, "ai") && hasModule(r.modules, "outbound"))
    .map((r) => ({ id: r.id, prefix: r.prefix, max_channels: r.max_channels, username: r.username, settings: fromRow(r) }));
}

const MISSED = new Set(["abandoned", "timeout", "no_agent"]);

// Yeni kaçan çağrılar için iş oluşturur.
export async function scan(db: Db, t: TenantRow, now: Date): Promise<number> {
  const s = t.settings;
  const since = new Date(now.getTime() - s.maxAgeMinutes * 60_000);
  const calls: CallRow[] = await listCalls(db, t.prefix, { from: isoDay(since, s.timezone), to: isoDay(now, s.timezone), tz: s.timezone }, 2000);
  let created = 0;
  for (const c of calls) {
    if (c.queue === "out" || !MISSED.has(c.outcome)) continue;
    const missedAt = localToDate(c.started, s.timezone);
    if (missedAt < since || missedAt > now) continue;
    const n = normalizeCaller(c.caller, s.international);
    let status = "pending";
    let note: string | null = null;
    // Atlanan numara da (biliniyorsa) listede görünsün diye kaydedilir; gizli numara kaydedilmez.
    let phone: string | null = n.e164 ?? null;
    if ("skip" in n) {
      status = "skipped";
      note = n.skip;
    } else {
      const out = (await db.query("SELECT 1 FROM callback_optout WHERE tenant_id = $1 AND phone = $2", [t.id, phone])).rows.length;
      const recent = (
        await db.query(
          `SELECT 1 FROM callback_jobs WHERE tenant_id = $1 AND phone = $2 AND source_callid <> $3
              AND status IN ('pending', 'dialing', 'answered') AND created_at > $4::timestamptz - make_interval(hours => $5) LIMIT 1`,
          [t.id, phone, c.callid, now, s.cooldownHours],
        )
      ).rows.length;
      if (out) [status, note] = ["skipped", "aranmak istemiyor"];
      else if (recent) [status, note] = ["skipped", "yakın zamanda geri arandı / aranacak"];
    }
    // Gizli numarada telefon alanı zorunlu olduğundan kayıt tutulmaz (yalnızca sayılır).
    if (!phone) continue;
    const ins = await db.query(
      `INSERT INTO callback_jobs (tenant_id, phone, source_callid, reason, missed_at, status, next_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, source_callid) DO NOTHING RETURNING id`,
      [t.id, phone, c.callid, c.outcome, missedAt, status, new Date(missedAt.getTime() + s.delayS * 1000), note],
    );
    if (ins.rows.length && status === "pending") created++;
  }
  return created;
}

// Arayan bu arada (kaçırılan çağrıdan sonra) cevaplanmış bir görüşme yaptıysa iş kapanır.
async function resolveReached(db: Db, t: TenantRow, now: Date) {
  const open = (await db.query("SELECT id, phone, missed_at FROM callback_jobs WHERE tenant_id = $1 AND status = 'pending'", [t.id])).rows;
  if (!open.length) return;
  const s = t.settings;
  const oldest = new Date(Math.min(...open.map((j) => new Date(j.missed_at).getTime())));
  const calls = await listCalls(db, t.prefix, { from: isoDay(oldest, s.timezone), to: isoDay(now, s.timezone), tz: s.timezone }, 2000);
  const answered = calls
    .filter((c) => c.outcome === "answered")
    .map((c) => ({ at: localToDate(c.started, s.timezone), n: normalizeCaller(c.caller, true), out: c.queue === "out" }))
    .filter((c) => !("skip" in c.n));
  for (const j of open) {
    const hit = answered.find((c) => (c.n as { e164: string }).e164 === j.phone && c.at > new Date(j.missed_at));
    if (hit)
      await db.query("UPDATE callback_jobs SET status = 'resolved', note = $2, updated_at = now() WHERE id = $1", [
        j.id,
        hit.out ? "temsilci geri aradı" : "arayan tekrar aradı ve görüşüldü",
      ]);
  }
}

export async function tick(db: Db, dialer: Dialer, now = new Date()): Promise<{ created: number; dialed: number }> {
  let created = 0;
  let dialed = 0;
  for (const t of await eligibleTenants(db)) {
    const s = t.settings;
    created += await scan(db, t, now);
    // Çaldırma süresi + pay geçtiyse ve yapay zekâ oturumu başlamadıysa: cevapsız.
    const stale = (
      await db.query(
        `UPDATE callback_jobs SET status = CASE WHEN attempts >= $2 THEN 'no_answer' ELSE 'pending' END,
                next_at = $3::timestamptz + make_interval(mins => $4), updated_at = now()
          WHERE tenant_id = $1 AND status = 'dialing' AND last_attempt_at < $3::timestamptz - make_interval(secs => $5) RETURNING id, status, phone, attempts, source_callid`,
        [t.id, s.maxAttempts, now, s.retryMinutes, RING_S + 60],
      )
    ).rows;
    for (const j of stale.filter((j) => j.status === "no_answer")) {
      await emit(db, t.id, "callback.failed", { job_id: j.id, phone: j.phone, attempts: j.attempts, reason: "no_answer", missed_call_id: j.source_callid });
    }
    await db.query(
      `UPDATE callback_jobs SET status = 'skipped', note = 'süre geçti', updated_at = now()
        WHERE tenant_id = $1 AND status = 'pending' AND missed_at < $2::timestamptz - make_interval(mins => $3)`,
      [t.id, now, s.maxAgeMinutes],
    );
    await resolveReached(db, t, now);
    if (!inWindow(s, now)) continue;

    const busy = Number((await db.query("SELECT count(*) FROM callback_jobs WHERE tenant_id = $1 AND status = 'dialing'", [t.id])).rows[0].count);
    let room = s.maxConcurrent - busy;
    if (room <= 0) continue;
    if (t.max_channels) {
      const active = await dialer.activeChannels(t.prefix).catch(() => Infinity);
      room = Math.min(room, t.max_channels - active);
      if (room <= 0) continue;
    }
    const due = (
      await db.query(
        `SELECT id, phone FROM callback_jobs WHERE tenant_id = $1 AND status = 'pending' AND next_at <= $2 ORDER BY next_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [t.id, now, room],
      )
    ).rows;
    for (const j of due) {
      const n = normalizeCaller(j.phone, true) as { e164: string; dial: string };
      await db.query("UPDATE callback_jobs SET status = 'dialing', attempts = attempts + 1, last_attempt_at = $2, updated_at = now() WHERE id = $1", [j.id, now]);
      try {
        await dialer.originate({ prefix: t.prefix, dial: n.dial, e164: n.e164, jobId: j.id, callerId: t.username, timeoutS: RING_S });
        dialed++;
      } catch (e) {
        await db.query("UPDATE callback_jobs SET status = 'failed', note = $2, updated_at = now() WHERE id = $1", [j.id, `arama başlatılamadı: ${e instanceof Error ? e.message : e}`]);
        await emit(db, t.id, "callback.failed", { job_id: j.id, phone: j.phone, reason: "originate_failed" });
      }
    }
  }
  return { created, dialed };
}

// Yapay zekâ servisi geri arama açıldığında çağırır.
export async function markAnswered(db: Db, tenantId: number, jobId: number, aiSessionId: number | null) {
  const r = await db.query(
    "UPDATE callback_jobs SET status = 'answered', ai_session_id = $3, note = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING phone, attempts, source_callid",
    [jobId, tenantId, aiSessionId],
  );
  const j = r.rows[0];
  if (j) await emit(db, tenantId, "callback.answered", { job_id: jobId, phone: j.phone, attempts: j.attempts, ai_session_id: aiSessionId, missed_call_id: j.source_callid });
}

// --- Panel ---

export async function listJobs(db: Db, tenantId: number, limit = 100) {
  return (
    await db.query(
      `SELECT j.id, j.phone, j.reason, j.status, j.attempts, j.note, j.missed_at AS "missedAt", j.next_at AS "nextAt",
              j.last_attempt_at AS "lastAttemptAt", a.summary AS "aiSummary", a.route_target AS "aiRoute"
         FROM callback_jobs j LEFT JOIN ai_sessions a ON a.id = j.ai_session_id
        WHERE j.tenant_id = $1 ORDER BY j.missed_at DESC LIMIT $2`,
      [tenantId, Math.min(500, Math.max(1, limit))],
    )
  ).rows;
}

export async function cancelJob(db: Db, tenantId: number, id: number, actor: string) {
  const r = await db.query("UPDATE callback_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'pending'", [id, tenantId]);
  if (!r.rowCount) throw new UserError("yalnızca bekleyen geri arama iptal edilebilir");
  await audit(db, "callbacks.cancel", tenantId, { id }, actor);
}

export async function listOptout(db: Db, tenantId: number) {
  return (await db.query(`SELECT phone, reason, created_by AS "createdBy", created_at AS "createdAt" FROM callback_optout WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])).rows;
}

export async function addOptout(db: Db, tenantId: number, raw: string, reason: string, actor: string) {
  const n = normalizeCaller(raw, true);
  if ("skip" in n) throw new UserError("numara geçersiz");
  await db.query("INSERT INTO callback_optout (tenant_id, phone, reason, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [tenantId, n.e164, reason.slice(0, 200), actor]);
  await db.query("UPDATE callback_jobs SET status = 'cancelled', note = 'aranmak istemiyor', updated_at = now() WHERE tenant_id = $1 AND phone = $2 AND status = 'pending'", [tenantId, n.e164]);
  await audit(db, "callbacks.optout.add", tenantId, { phone: n.e164 }, actor);
}

export async function removeOptout(db: Db, tenantId: number, phone: string, actor: string) {
  await db.query("DELETE FROM callback_optout WHERE tenant_id = $1 AND phone = $2", [tenantId, phone]);
  await audit(db, "callbacks.optout.remove", tenantId, { phone }, actor);
}

// Karşılama metni: arayanın diline göre; {firma} işletme adıyla değiştirilir.
export function greetingFor(s: Pick<Settings, "greetingTr" | "greetingEn">, language: string, company: string) {
  const text = language === "tr" ? s.greetingTr || DEFAULT_GREETING_TR : s.greetingEn || DEFAULT_GREETING_EN;
  return text.replaceAll("{firma}", company);
}
