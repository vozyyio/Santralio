// Santralio: kiracının kendi sistemlerine imzalı olay bildirimi (webhook).
//
// Olay doğduğu yerde emit() ile webhook_deliveries'e yazılır (aynı transaction; iş geri alınırsa olay da gider).
// deliver() bekleyenleri gönderir. Her istek:
//   POST <url>   Content-Type: application/json
//   X-Santralio-Event: payment.paid
//   X-Santralio-Event-Id: evt_…          (alıcı aynı kimliği ikinci kez işlememeli)
//   X-Santralio-Timestamp: <unix saniye>
//   X-Santralio-Signature: sha256=<hex(HMAC-SHA256(gizli_anahtar, timestamp + "." + ham_gövde))>
// Gövde: { "id": "evt_…", "type": "payment.paid", "created_at": "…Z", "tenant": "t12", "data": { … } }
// 2xx dışındaki her yanıt ve bağlantı hatası yeniden denenir: 1 dk, 5 dk, 30 dk, 2 sa, 12 sa, 24 sa; sonra "failed".
// Bir uç arka arkaya 50 teslimde başarısız olursa kendiliğinden kapanır (panelde nedeniyle görünür).

import { createHmac } from "node:crypto";
import { open, randomToken, seal } from "./crypto.ts";
import { audit, tx, type Db } from "./db.ts";
import { assertPublicHttps, postJson, type PostResult } from "./netguard.ts";
import { UserError } from "./ops.ts";

export const EVENTS: { type: string; label: string; group: string }[] = [
  { type: "call.missed", label: "Kaçan çağrı (kapattı, süre doldu, temsilci yok)", group: "Görüşmeler" },
  { type: "call.completed", label: "Cevaplanan görüşme bitti", group: "Görüşmeler" },
  { type: "ai.session.ended", label: "Yapay zekâ görüşmesi bitti (özetiyle)", group: "Yapay zekâ" },
  { type: "callback.answered", label: "Otomatik geri arama açıldı", group: "Yapay zekâ" },
  { type: "callback.failed", label: "Otomatik geri aramada ulaşılamadı", group: "Yapay zekâ" },
  { type: "payment.paid", label: "Ödeme alındı", group: "Ödeme" },
  { type: "payment.failed", label: "Ödeme başarısız (eksik tutar)", group: "Ödeme" },
  { type: "payment.expired", label: "Ödeme bağlantısının süresi doldu", group: "Ödeme" },
  { type: "payment.cancelled", label: "Ödeme talebi iptal edildi", group: "Ödeme" },
  { type: "contact.created", label: "Yeni müşteri kartı", group: "CRM" },
  { type: "note.saved", label: "Görüşme notu kaydedildi", group: "CRM" },
];
const TYPES = new Set(EVENTS.map((e) => e.type));
export const BACKOFF_S = [60, 300, 1800, 7200, 43200, 86400];
export const MAX_ATTEMPTS = BACKOFF_S.length + 1;
const MAX_HOOKS = 10;
const DISABLE_AFTER = 50;

export type Keys = { key: (id: string) => Buffer; currentId: string };
export type Send = (url: string, body: string, headers: Record<string, string>) => Promise<PostResult>;
export type Deps = { db: Db; keys: Keys; send?: Send; resolve?: Parameters<typeof assertPublicHttps>[1]; actor?: string };

const aadHook = (tenantId: number, ref: string) => `webhooks:${tenantId}:${ref}`;
const newSecret = () => "whsec_" + randomToken(40);
export const newEventId = () => "evt_" + randomToken(24);

export function sign(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

// Olayı kiracının bu olaya abone açık uçlarına sıraya koyar. Abone yoksa hiçbir şey yazılmaz.
export async function emit(db: Db, tenantId: number, type: string, data: Record<string, unknown>, only?: { webhookId: number }): Promise<string | null> {
  if (!TYPES.has(type) && type !== "webhook.test") throw new Error(`bilinmeyen olay: ${type}`);
  const id = newEventId();
  const r = await db.query(
    `INSERT INTO webhook_deliveries (webhook_id, tenant_id, event_id, type, payload)
     SELECT w.id, w.tenant_id, $2, $3,
            jsonb_build_object('id', $2::text, 'type', $3::text, 'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                               'tenant', t.prefix, 'data', $4::jsonb)
       FROM webhooks w JOIN tenants t ON t.id = w.tenant_id
      WHERE w.tenant_id = $1 AND w.enabled AND ($5::int IS NULL OR w.id = $5) AND ($5::int IS NOT NULL OR $3 = ANY (w.events))`,
    [tenantId, id, type, JSON.stringify(data), only?.webhookId ?? null],
  );
  return r.rowCount ? id : null;
}

// --- Panel ---

function cleanEvents(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new UserError("en az bir olay seçin");
  const out = [...new Set(v.map(String))];
  const unknown = out.filter((e) => !TYPES.has(e));
  if (unknown.length) throw new UserError(`bilinmeyen olay: ${unknown.join(", ")}`);
  return out;
}

function cleanDescription(v: unknown): string {
  const s = String(v ?? "").trim();
  if (s.length > 200) throw new UserError("açıklama en fazla 200 karakter");
  return s;
}

export async function listWebhooks(db: Db, tenantId: number) {
  return (
    await db.query(
      `SELECT w.id, w.url, w.description, w.events, w.enabled, w.fail_streak AS "failStreak", w.disabled_reason AS "disabledReason",
              to_char(w.created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "createdAt",
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed' AND d.created_at > now() - interval '7 days') AS "failed7d",
              (SELECT to_char(max(d.delivered_at) AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS "lastDeliveredAt"
         FROM webhooks w WHERE w.tenant_id = $1 ORDER BY w.id`,
      [tenantId],
    )
  ).rows;
}

export async function createWebhook(d: Deps, tenantId: number, input: { url: unknown; events: unknown; description?: unknown }) {
  const u = await assertPublicHttps(input.url, d.resolve, "webhook adresi");
  const events = cleanEvents(input.events);
  const description = cleanDescription(input.description);
  const count = Number((await d.db.query("SELECT count(*) FROM webhooks WHERE tenant_id = $1", [tenantId])).rows[0].count);
  if (count >= MAX_HOOKS) throw new UserError(`en fazla ${MAX_HOOKS} webhook`);
  const secret = newSecret();
  const ref = randomToken(24);
  const sealed = seal(secret, aadHook(tenantId, ref), d.keys.key(d.keys.currentId), d.keys.currentId);
  const id = (
    await d.db.query(
      `INSERT INTO webhooks (tenant_id, url, description, events, secret_enc, key_id, secret_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tenantId, u.toString(), description, events, sealed.enc, sealed.keyId, ref, d.actor ?? null],
    )
  ).rows[0].id as number;
  await audit(d.db, "webhook.add", tenantId, { id, host: u.hostname, events }, d.actor);
  // Gizli anahtar yalnızca burada (ve yenilemede) bir kez döner.
  return { id, secret };
}

export async function updateWebhook(d: Deps, tenantId: number, id: number, input: { url?: unknown; events?: unknown; description?: unknown; enabled?: unknown }) {
  const row = (await d.db.query("SELECT * FROM webhooks WHERE id = $1 AND tenant_id = $2", [id, tenantId])).rows[0];
  if (!row) throw new UserError("webhook bulunamadı", 404);
  const url = input.url !== undefined ? (await assertPublicHttps(input.url, d.resolve, "webhook adresi")).toString() : row.url;
  const events = input.events !== undefined ? cleanEvents(input.events) : row.events;
  const description = input.description !== undefined ? cleanDescription(input.description) : row.description;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new UserError("enabled true/false olmalı");
  const enabled = input.enabled ?? row.enabled;
  // Yeniden açılırsa sayaç sıfırlanır.
  await d.db.query(
    `UPDATE webhooks SET url = $3, events = $4, description = $5, enabled = $6,
            fail_streak = CASE WHEN $6 AND NOT enabled THEN 0 ELSE fail_streak END,
            disabled_reason = CASE WHEN $6 THEN NULL ELSE COALESCE(disabled_reason, 'yönetici kapattı') END, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, url, events, description, enabled],
  );
  await audit(d.db, "webhook.update", tenantId, { id, host: new URL(url).hostname, events, enabled }, d.actor);
}

export async function rotateSecret(d: Deps, tenantId: number, id: number) {
  const row = (await d.db.query("SELECT secret_ref FROM webhooks WHERE id = $1 AND tenant_id = $2", [id, tenantId])).rows[0];
  if (!row) throw new UserError("webhook bulunamadı", 404);
  const secret = newSecret();
  const sealed = seal(secret, aadHook(tenantId, row.secret_ref), d.keys.key(d.keys.currentId), d.keys.currentId);
  await d.db.query("UPDATE webhooks SET secret_enc = $3, key_id = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2", [id, tenantId, sealed.enc, sealed.keyId]);
  await audit(d.db, "webhook.rotate", tenantId, { id }, d.actor);
  return { secret };
}

export async function deleteWebhook(d: Deps, tenantId: number, id: number) {
  const r = await d.db.query("DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!r.rowCount) throw new UserError("webhook bulunamadı", 404);
  await audit(d.db, "webhook.delete", tenantId, { id }, d.actor);
}

export async function sendTest(d: Deps, tenantId: number, id: number) {
  const ok = (await d.db.query("SELECT enabled FROM webhooks WHERE id = $1 AND tenant_id = $2", [id, tenantId])).rows[0];
  if (!ok) throw new UserError("webhook bulunamadı", 404);
  if (!ok.enabled) throw new UserError("webhook kapalı; önce açın");
  const eventId = await emit(d.db, tenantId, "webhook.test", { message: "Santralio test bildirimi" }, { webhookId: id });
  return { eventId };
}

export async function listDeliveries(db: Db, tenantId: number, webhookId: number, limit = 50) {
  return (
    await db.query(
      `SELECT d.id, d.event_id AS "eventId", d.type, d.status, d.attempts, d.last_code AS "lastCode", d.last_error AS "lastError", d.payload,
              to_char(d.created_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
              to_char(d.next_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "nextAt",
              to_char(d.delivered_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') AS "deliveredAt"
         FROM webhook_deliveries d WHERE d.tenant_id = $1 AND d.webhook_id = $2 ORDER BY d.id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
      [tenantId, webhookId],
    )
  ).rows;
}

export async function retryDelivery(d: Deps, tenantId: number, deliveryId: number) {
  const r = await d.db.query(
    "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_at = now() WHERE id = $1 AND tenant_id = $2 AND status <> 'pending'",
    [deliveryId, tenantId],
  );
  if (!r.rowCount) throw new UserError("teslim bulunamadı ya da zaten sırada", 404);
}

// --- Gönderici ---

export async function deliver(d: Deps, now = new Date(), limit = 25): Promise<{ sent: number; failed: number }> {
  const send: Send = d.send ?? ((url, body, headers) => postJson(url, body, headers));
  // Vakti 1 saniye içinde gelecek olanlar da alınır (veritabanı ve uygulama saatinin mikro saniye farkı).
  // Sahiplenme: deneme sayısı artar ve 2 dakikalık kira verilir; süreç düşerse kira bitince başka tur alır.
  const rows = (
    await d.db.query(
      `UPDATE webhook_deliveries x SET attempts = x.attempts + 1, next_at = $1::timestamptz + interval '2 minutes'
         FROM (SELECT dd.id FROM webhook_deliveries dd JOIN webhooks w ON w.id = dd.webhook_id
                WHERE dd.status = 'pending' AND dd.next_at <= $1::timestamptz + interval '1 second' AND w.enabled ORDER BY dd.next_at LIMIT $2 FOR UPDATE OF dd SKIP LOCKED) s
        WHERE x.id = s.id
        RETURNING x.id, x.webhook_id, x.tenant_id, x.event_id, x.type, x.payload, x.attempts`,
      [now, limit],
    )
  ).rows;
  if (!rows.length) return { sent: 0, failed: 0 };
  const hooks = new Map(
    (await d.db.query("SELECT id, tenant_id, url, secret_enc, key_id, secret_ref FROM webhooks WHERE id = ANY ($1)", [[...new Set(rows.map((r) => r.webhook_id))]])).rows.map((h) => [
      h.id as number,
      h,
    ]),
  );
  let sent = 0;
  let failed = 0;
  await Promise.all(
    rows.map(async (r) => {
      const h = hooks.get(r.webhook_id);
      if (!h) return;
      const body = JSON.stringify(r.payload);
      const ts = Math.floor(now.getTime() / 1000);
      let code: number | null = null;
      let error: string | null = null;
      try {
        const secret = open(h.secret_enc, aadHook(h.tenant_id, h.secret_ref), d.keys.key(h.key_id));
        const res = await send(h.url, body, {
          "x-santralio-event": r.type,
          "x-santralio-event-id": r.event_id,
          "x-santralio-timestamp": String(ts),
          "x-santralio-signature": sign(secret, ts, body),
        });
        code = res.status;
        if (res.status < 200 || res.status > 299) error = `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`;
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
      if (!error) {
        sent++;
        await d.db.query("UPDATE webhook_deliveries SET status = 'delivered', delivered_at = $2, last_code = $3, last_error = NULL WHERE id = $1", [r.id, now, code]);
        await d.db.query("UPDATE webhooks SET fail_streak = 0 WHERE id = $1", [h.id]);
        return;
      }
      failed++;
      const final = r.attempts >= MAX_ATTEMPTS;
      await d.db.query(
        `UPDATE webhook_deliveries SET status = $2, last_code = $3, last_error = $4, next_at = $5::timestamptz + make_interval(secs => $6) WHERE id = $1`,
        [r.id, final ? "failed" : "pending", code, error, now, final ? 0 : BACKOFF_S[r.attempts - 1]],
      );
      const streak = (await d.db.query("UPDATE webhooks SET fail_streak = fail_streak + 1 WHERE id = $1 RETURNING fail_streak", [h.id])).rows[0]?.fail_streak ?? 0;
      if (streak >= DISABLE_AFTER) {
        const off = await d.db.query(
          "UPDATE webhooks SET enabled = false, disabled_reason = $2, updated_at = now() WHERE id = $1 AND enabled RETURNING tenant_id",
          [h.id, `arka arkaya ${DISABLE_AFTER} teslim başarısız (son hata: ${error})`.slice(0, 300)],
        );
        if (off.rowCount) await audit(d.db, "webhook.auto_disable", h.tenant_id, { id: h.id, error }, "webhooks");
      }
    }),
  );
  return { sent, failed };
}

// --- Görüşme olayları (queue_log) ---
// Asterisk queue_log'a doğrudan yazar; nerede kalındığı event_cursors'ta tutulur. İlk çalışmada geçmiş gönderilmez.

const CALL_EVENTS = ["ABANDON", "EXITWITHTIMEOUT", "SANTRALIO_NOAGENT", "COMPLETECALLER", "COMPLETEAGENT", "SANTRALIO_EXT_DONE"];

export async function scanCalls(db: Db, batch = 1000): Promise<number> {
  return tx(db, async () => {
    const cur = (await db.query("SELECT last_id FROM event_cursors WHERE name = 'queue_log' FOR UPDATE")).rows[0];
    const hi = Number((await db.query("SELECT COALESCE(max(id), 0) AS hi FROM queue_log")).rows[0].hi);
    if (!cur) {
      await db.query("INSERT INTO event_cursors (name, last_id) VALUES ('queue_log', $1) ON CONFLICT (name) DO NOTHING", [hi]);
      return 0;
    }
    const from = Number(cur.last_id);
    if (hi <= from) return 0;
    const rows = (
      await db.query(
        `SELECT q.id, q.callid, q.queuename, q.agent, q.event, q.data1, q.data2, q.data3,
                to_char(q.time, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, e.did, e.caller
           FROM queue_log q
           LEFT JOIN LATERAL (SELECT data1 AS did, data2 AS caller FROM queue_log
                               WHERE callid = q.callid AND queuename = q.queuename AND event = 'SANTRALIO_ENTER' ORDER BY id LIMIT 1) e ON true
          WHERE q.id > $1 AND q.id <= $2 AND q.event = ANY ($3)
          ORDER BY q.id LIMIT $4`,
        [from, hi, CALL_EVENTS, batch],
      )
    ).rows;
    const next = rows.length === batch ? Number(rows[rows.length - 1].id) : hi;
    const prefixes = [...new Set(rows.map((r) => String(r.queuename).split("_")[0]))];
    const tenants = new Map(
      (await db.query("SELECT id, prefix FROM tenants WHERE prefix = ANY ($1)", [prefixes])).rows.map((t) => [t.prefix as string, t.id as number]),
    );
    let n = 0;
    for (const r of rows) {
      const q = String(r.queuename);
      const prefix = q.split("_")[0];
      const queue = q.slice(prefix.length + 1);
      const tenantId = tenants.get(prefix);
      // Zamanlama olayları (t1__schedule_x) ve dış aramalar (…_out) görüşme olayı değildir.
      if (!tenantId || !queue || queue.startsWith("_") || queue === "out") continue;
      const base = { call_id: r.callid, queue, caller: r.caller ?? null, did: r.did ?? null, at: r.at };
      const int = (v: string) => (/^\d+$/.test(v ?? "") ? Number(v) : 0);
      let type: string | null = null;
      let data: Record<string, unknown> = {};
      switch (r.event) {
        case "ABANDON":
          type = "call.missed";
          data = { ...base, reason: "abandoned", wait_s: int(r.data3) };
          break;
        case "EXITWITHTIMEOUT":
          type = "call.missed";
          data = { ...base, reason: "timeout", wait_s: int(r.data3) };
          break;
        case "SANTRALIO_NOAGENT":
          type = "call.missed";
          data = { ...base, reason: "no_agent" };
          break;
        case "COMPLETECALLER":
        case "COMPLETEAGENT":
          type = "call.completed";
          data = { ...base, agent: r.agent || null, wait_s: int(r.data1), talk_s: int(r.data2), hung_up_by: r.event === "COMPLETECALLER" ? "caller" : "agent" };
          break;
        case "SANTRALIO_EXT_DONE": {
          const talk = int(r.data3);
          const total = int(r.data2);
          if (r.data1 === "ANSWER") {
            type = "call.completed";
            data = { ...base, agent: r.agent || null, wait_s: Math.max(total - talk, 0), talk_s: talk };
          } else {
            type = "call.missed";
            data = { ...base, reason: String(r.data1 || "no_answer").toLowerCase(), wait_s: total };
          }
          break;
        }
      }
      if (type && (await emit(db, tenantId, type, data))) n++;
    }
    await db.query("UPDATE event_cursors SET last_id = $1 WHERE name = 'queue_log'", [next]);
    return n;
  });
}
