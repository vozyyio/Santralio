// Santralio: "Sıranız gelince sizi arayalım" (kuyrukta beklemek yerine geri aranma).
//
// 1. Arayan kuyrukta cb_offer_after_s bekleyince duyuru çalar; 1'e basarsa dialplan SANTRALIO_QCB_REQUEST yazar ve kapatır.
// 2. scan(): queue_log'daki talepten iş açar (sırası: kuyruğa ilk giriş zamanı). Numara aranamıyorsa iş "failed".
// 3. tick(): her kuyruk için Asterisk'e sorulur: müsait temsilci var mı, kuyrukta kim, ne kadar bekliyor.
//    Temsilci boşsa ve kuyrukta bu talepten önce girmiş biri beklemiyorsa arayan kiracının hattından aranır.
// 4. Açınca dialplan SANTRALIO_QCB_ANSWERED yazar ve arayanı öncelikli olarak aynı kuyruğa alır; scan() işi "connected" yapar.
//    Açmazsa 2 dakika sonra tekrar (en fazla 3 deneme). cb_expire_min içinde aranamayan talep "expired".

import { normalizeCaller } from "./callbacks.ts";
import { audit, tx, type Db } from "./db.ts";
import { UserError } from "./ops.ts";
import { emit } from "./webhooks.ts";

export const RING_S = 30;
export const MAX_ATTEMPTS = 3;
export const RETRY_MIN = 2;

export type QueueState = { available: number; callers: number; longestWaitS: number };

export interface QDialer {
  // Kiracının hattından arar (asenkron). Açınca tN-qcb-out,q<kuyruk>'a girilir; QCB=<iş>_<numara rakamları>.
  originate(o: { prefix: string; queue: string; dial: string; e164: string; jobId: number; callerId: string; timeoutS: number }): Promise<void>;
  activeChannels(prefix: string): Promise<number>;
  // "queue show" çıktısından: müsait temsilci, bekleyen arayan, en uzun bekleme. Kuyruk yoksa null.
  queueState(prefix: string, queue: string): Promise<QueueState | null>;
}

// Asterisk "queue show <kuyruk>" çıktısı. Müsait: "(Not in use)" olup molada/erişilemez olmayan üye.
export function parseQueueShow(lines: string[]): QueueState | null {
  if (!lines.some((l) => /has \d+ calls? \(/.test(l))) return null;
  let section = "";
  let available = 0;
  let callers = 0;
  let longest = 0;
  for (const raw of lines) {
    // Asterisk konsol çıktısı renk kodu içerebilir.
    const t = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (/^Members:/.test(t)) section = "m";
    else if (/^Callers:/.test(t) || /^No Callers/.test(t)) section = "c";
    else if (/^No Members/.test(t)) section = "";
    else if (section === "m" && t) {
      if (/\(Not in use\)/.test(t) && !/\(paused/.test(t) && !/\(Unavailable\)|\(Invalid\)/.test(t)) available++;
    } else if (section === "c") {
      const m = /^\d+\.\s.*\(wait:\s*(\d+):(\d{2})/.exec(t);
      if (m) {
        callers++;
        longest = Math.max(longest, Number(m[1]) * 60 + Number(m[2]));
      }
    }
  }
  return { available, callers, longestWaitS: longest };
}

// --- Ayarlar ---

export type QueueCallbackSettings = {
  enabled: boolean;
  offerAfterS: number;
  expireMin: number;
  offerText: string;
  confirmText: string;
  connectText: string;
  nonumText: string;
};

const fromRow = (q: any): QueueCallbackSettings => ({
  enabled: q.cb_enabled,
  offerAfterS: q.cb_offer_after_s,
  expireMin: q.cb_expire_min,
  offerText: q.cb_offer_text,
  confirmText: q.cb_confirm_text,
  connectText: q.cb_connect_text,
  nonumText: q.cb_nonum_text,
});

export async function getSettings(db: Db, tenantId: number, queue: string): Promise<QueueCallbackSettings> {
  const q = (await db.query("SELECT * FROM queues WHERE tenant_id = $1 AND name = $2", [tenantId, queue])).rows[0];
  if (!q) throw new UserError("kuyruk bulunamadı", 404);
  return fromRow(q);
}

function text(v: unknown, label: string): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s || s.length > 300) throw new UserError(`${label} 1-300 karakter olmalı`);
  return s;
}

export async function saveSettings(db: Db, tenantId: number, queue: string, input: Partial<QueueCallbackSettings>, actor?: string): Promise<QueueCallbackSettings> {
  const cur = await getSettings(db, tenantId, queue);
  const n = { ...cur, ...input };
  if (typeof n.enabled !== "boolean") throw new UserError("enabled true/false olmalı");
  if (!Number.isInteger(n.offerAfterS) || n.offerAfterS < 20 || n.offerAfterS > 600) throw new UserError("teklif süresi 20-600 saniye");
  if (!Number.isInteger(n.expireMin) || n.expireMin < 10 || n.expireMin > 720) throw new UserError("geçerlilik süresi 10-720 dakika");
  const v = {
    offerText: text(n.offerText, "teklif metni"),
    confirmText: text(n.confirmText, "onay metni"),
    connectText: text(n.connectText, "bağlanma metni"),
    nonumText: text(n.nonumText, "numara görünmüyor metni"),
  };
  if (n.enabled && !/\b1\b|bir/i.test(v.offerText)) throw new UserError("teklif metni 1 tuşunu söylemeli (ör. \"1'e basın\")");
  if (n.enabled) {
    const trunk = (await db.query("SELECT 1 FROM trunks WHERE tenant_id = $1 AND enabled", [tenantId])).rowCount;
    if (!trunk) throw new UserError("geri arama için açık bir hat (SIP trunk) gerekli");
  }
  await db.query(
    `UPDATE queues SET cb_enabled = $3, cb_offer_after_s = $4, cb_expire_min = $5, cb_offer_text = $6, cb_confirm_text = $7, cb_connect_text = $8, cb_nonum_text = $9
      WHERE tenant_id = $1 AND name = $2`,
    [tenantId, queue, n.enabled, n.offerAfterS, n.expireMin, v.offerText, v.confirmText, v.connectText, v.nonumText],
  );
  // Kapatılınca bekleyen talepler iptal edilir: arayana söz verilmişti ama kuyruk artık bu özelliği kullanmıyor.
  if (!n.enabled && cur.enabled) {
    await db.query(
      `UPDATE queue_callbacks c SET status = 'cancelled', note = 'özellik kapatıldı', updated_at = now()
         FROM queues q WHERE q.id = c.queue_id AND q.tenant_id = $1 AND q.name = $2 AND c.status = 'waiting'`,
      [tenantId, queue],
    );
  }
  await audit(db, "queue.callback", tenantId, { queue, enabled: n.enabled, offerAfterS: n.offerAfterS, expireMin: n.expireMin }, actor);
  return { ...n, ...v } as QueueCallbackSettings;
}

// --- Talep ve bağlantı olayları (queue_log) ---

export async function scan(db: Db, batch = 500): Promise<{ requested: number; connected: number }> {
  return tx(db, async () => {
    const cur = (await db.query("SELECT last_id FROM event_cursors WHERE name = 'queue_callbacks' FOR UPDATE")).rows[0];
    const hi = Number((await db.query("SELECT COALESCE(max(id), 0) AS hi FROM queue_log")).rows[0].hi);
    if (!cur) {
      await db.query("INSERT INTO event_cursors (name, last_id) VALUES ('queue_callbacks', $1) ON CONFLICT (name) DO NOTHING", [hi]);
      return { requested: 0, connected: 0 };
    }
    const from = Number(cur.last_id);
    if (hi <= from) return { requested: 0, connected: 0 };
    const rows = (
      await db.query(
        `SELECT q.id, q.callid, q.queuename, q.event, q.data1, q.time AT TIME ZONE 'UTC' AS at,
                (SELECT min(time) AT TIME ZONE 'UTC' FROM queue_log e WHERE e.callid = q.callid AND e.queuename = q.queuename AND e.event = 'SANTRALIO_ENTER') AS entered
           FROM queue_log q
          WHERE q.id > $1 AND q.id <= $2 AND q.event IN ('SANTRALIO_QCB_REQUEST', 'SANTRALIO_QCB_ANSWERED')
          ORDER BY q.id LIMIT $3`,
        [from, hi, batch],
      )
    ).rows;
    const next = rows.length === batch ? Number(rows[rows.length - 1].id) : hi;
    let requested = 0;
    let connected = 0;
    for (const r of rows) {
      const qn = String(r.queuename);
      const prefix = qn.split("_")[0];
      const queue = (
        await db.query("SELECT q.id, q.tenant_id, q.name FROM queues q JOIN tenants t ON t.id = q.tenant_id WHERE t.prefix = $1 AND q.name = $2", [prefix, qn.slice(prefix.length + 1)])
      ).rows[0];
      if (!queue) continue;
      if (r.event === "SANTRALIO_QCB_REQUEST") {
        const n = normalizeCaller(r.data1, false);
        const ok = "dial" in n;
        const ins = await db.query(
          `INSERT INTO queue_callbacks (tenant_id, queue_id, source_callid, phone, entered_at, requested_at, status, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, source_callid) DO NOTHING RETURNING id`,
          [queue.tenant_id, queue.id, r.callid, ok ? n.e164 : (n.e164 ?? String(r.data1 ?? "").slice(0, 32)), r.entered ?? r.at, r.at, ok ? "waiting" : "failed", ok ? null : n.skip],
        );
        if (!ins.rowCount) continue;
        const id = ins.rows[0].id;
        if (ok) {
          requested++;
          await emit(db, queue.tenant_id, "queue_callback.requested", { job_id: Number(id), queue: queue.name, phone: n.e164, call_id: r.callid });
        } else {
          await emit(db, queue.tenant_id, "queue_callback.failed", { job_id: Number(id), queue: queue.name, phone: n.e164 ?? null, call_id: r.callid, reason: n.skip });
        }
      } else {
        const job = /^\d{1,18}$/.test(r.data1 ?? "") ? r.data1 : null;
        if (!job) continue;
        const u = await db.query(
          `UPDATE queue_callbacks SET status = 'connected', connected_at = $3, note = NULL, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status IN ('dialing', 'waiting', 'no_answer') RETURNING phone, attempts, source_callid`,
          [job, queue.tenant_id, r.at],
        );
        if (!u.rowCount) continue;
        connected++;
        await emit(db, queue.tenant_id, "queue_callback.connected", {
          job_id: Number(job),
          queue: queue.name,
          phone: u.rows[0].phone,
          attempts: u.rows[0].attempts,
          call_id: r.callid,
          request_call_id: u.rows[0].source_callid,
        });
      }
    }
    await db.query("UPDATE event_cursors SET last_id = $1 WHERE name = 'queue_callbacks'", [next]);
    return { requested, connected };
  });
}

// --- Zamanlayıcı ---

export async function tick(db: Db, dialer: QDialer, now = new Date()): Promise<{ dialed: number }> {
  // Takılan aramalar: çaldırma süresi + pay geçtiyse ve bağlanma olayı gelmediyse.
  const stale = (
    await db.query(
      `UPDATE queue_callbacks c SET status = CASE WHEN c.attempts >= $2 THEN 'no_answer' ELSE 'waiting' END,
              next_at = $1::timestamptz + make_interval(mins => $3), updated_at = now()
        WHERE c.status = 'dialing' AND c.last_attempt_at < $1::timestamptz - make_interval(secs => $4)
        RETURNING c.id, c.tenant_id, c.status, c.phone, c.attempts, c.source_callid, (SELECT name FROM queues WHERE id = c.queue_id) AS queue`,
      [now, MAX_ATTEMPTS, RETRY_MIN, RING_S + 60],
    )
  ).rows;
  for (const j of stale.filter((j) => j.status === "no_answer")) {
    await emit(db, j.tenant_id, "queue_callback.failed", { job_id: Number(j.id), queue: j.queue, phone: j.phone, attempts: j.attempts, call_id: j.source_callid, reason: "no_answer" });
  }
  const expired = (
    await db.query(
      `UPDATE queue_callbacks c SET status = 'expired', note = 'süresi içinde sıra gelmedi', updated_at = now()
         FROM queues q WHERE q.id = c.queue_id AND c.status = 'waiting' AND c.requested_at < $1::timestamptz - make_interval(mins => q.cb_expire_min)
        RETURNING c.id, c.tenant_id, c.phone, c.source_callid, q.name AS queue`,
      [now],
    )
  ).rows;
  for (const j of expired) {
    await emit(db, j.tenant_id, "queue_callback.failed", { job_id: Number(j.id), queue: j.queue, phone: j.phone, call_id: j.source_callid, reason: "expired" });
  }

  // Bekleyen işi olan, açık, lisanslı, hattı açık kiracıların geri aramalı kuyrukları.
  const queues = (
    await db.query(
      `SELECT DISTINCT q.id, q.name, t.id AS tenant_id, t.prefix, tr.username, l.max_channels
         FROM queue_callbacks c
         JOIN queues q ON q.id = c.queue_id AND q.cb_enabled
         JOIN tenants t ON t.id = q.tenant_id AND t.status = 'active' AND t.pbx_open
         JOIN trunks tr ON tr.tenant_id = t.id AND tr.enabled
         LEFT JOIN licenses l ON l.tenant_id = t.id
        WHERE c.status = 'waiting' AND c.next_at <= $1 AND COALESCE(l.active, false) AND (l.valid_until IS NULL OR l.valid_until > now())
        ORDER BY t.id, q.id`,
      [now],
    )
  ).rows;
  let dialed = 0;
  for (const q of queues) {
    const state = await dialer.queueState(q.prefix, q.name).catch(() => null);
    if (!state) continue;
    const dialing = Number((await db.query("SELECT count(*) FROM queue_callbacks WHERE queue_id = $1 AND status = 'dialing'", [q.id])).rows[0].count);
    let room = state.available - dialing;
    if (room <= 0) continue;
    if (q.max_channels) {
      const active = await dialer.activeChannels(q.prefix).catch(() => Infinity);
      room = Math.min(room, q.max_channels - active);
      if (room <= 0) continue;
    }
    // Sıra: kuyruğa ilk giriş. Kuyrukta bu talepten önce girmiş biri bekliyorsa (en uzun bekleme daha eski) önce o.
    const head = new Date(now.getTime() - state.longestWaitS * 1000);
    const due = (
      await db.query(
        `SELECT id, phone FROM queue_callbacks WHERE queue_id = $1 AND status = 'waiting' AND next_at <= $2
            AND ($3::int = 0 OR entered_at <= $4) ORDER BY entered_at LIMIT $5 FOR UPDATE SKIP LOCKED`,
        [q.id, now, state.callers, head, room],
      )
    ).rows;
    for (const j of due) {
      const n = normalizeCaller(j.phone, false);
      if (!("dial" in n)) {
        await db.query("UPDATE queue_callbacks SET status = 'failed', note = $2, updated_at = now() WHERE id = $1", [j.id, n.skip]);
        continue;
      }
      await db.query("UPDATE queue_callbacks SET status = 'dialing', attempts = attempts + 1, last_attempt_at = $2, updated_at = now() WHERE id = $1", [j.id, now]);
      try {
        await dialer.originate({ prefix: q.prefix, queue: q.name, dial: n.dial, e164: n.e164, jobId: Number(j.id), callerId: q.username, timeoutS: RING_S });
        dialed++;
      } catch (e) {
        const msg = `arama başlatılamadı: ${e instanceof Error ? e.message : e}`;
        await db.query("UPDATE queue_callbacks SET status = 'failed', note = $2, updated_at = now() WHERE id = $1", [j.id, msg.slice(0, 300)]);
        await emit(db, q.tenant_id, "queue_callback.failed", { job_id: Number(j.id), queue: q.name, phone: j.phone, reason: "originate_failed" });
      }
    }
  }
  return { dialed };
}

// --- Panel ---

export async function listJobs(db: Db, tenantId: number, limit = 100) {
  return (
    await db.query(
      `SELECT c.id, q.name AS queue, c.phone, c.status, c.attempts, c.note,
              to_char(c.requested_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "requestedAt",
              to_char(c.connected_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "connectedAt",
              CASE WHEN c.connected_at IS NOT NULL THEN extract(epoch FROM c.connected_at - c.requested_at)::int END AS "waitS"
         FROM queue_callbacks c JOIN queues q ON q.id = c.queue_id
        WHERE c.tenant_id = $1 ORDER BY c.id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
      [tenantId],
    )
  ).rows;
}

export async function cancelJob(db: Db, tenantId: number, id: number, actor?: string) {
  const r = await db.query("UPDATE queue_callbacks SET status = 'cancelled', note = 'panelden iptal', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'waiting'", [id, tenantId]);
  if (!r.rowCount) throw new UserError("bekleyen talep bulunamadı", 404);
  await audit(db, "queue.callback.cancel", tenantId, { id }, actor);
}
