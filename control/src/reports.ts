// Santralio: kuyruk olaylarından (queue_log) görüşme listesi ve özet raporlar.
// Her kuyruk girişi (SANTRALIO_ENTER) bir görüşme sayılır; sonucu aynı callid'nin sonraki olaylarından çıkar.
// Gün sınırları kiracının saat diliminde (varsayılan İstanbul) hesaplanır; queue_log'daki zaman UTC'dir.

import type { Db } from "./db.ts";
import { UserError } from "./ops.ts";

export type Range = { from: string; to: string; tz: string }; // from/to: YYYY-MM-DD (to dahil)

export function parseRange(from: unknown, to: unknown, tz = "Europe/Istanbul"): Range {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const f = typeof from === "string" && from ? from : today;
  const t = typeof to === "string" && to ? to : f;
  for (const d of [f, t]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new UserError(`geçersiz tarih: ${d}`);
  if (t < f) throw new UserError("bitiş tarihi başlangıçtan önce olamaz");
  if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 366) throw new UserError("en fazla bir yıllık aralık");
  return { from: f, to: t, tz };
}

// Kiracının kuyruk adları "<önek>_<kuyruk>", zamanlama olayları "<önek>__schedule_<ad>" biçimindedir.
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => "\\" + c)}\\_%`;

// Görüşmeler: kuyruk girişi başına bir satır. $1 önek LIKE, $2 başlangıç, $3 bitiş (yerel tarih), $4 saat dilimi.
const CALLS = `
WITH ev AS (
  SELECT * FROM queue_log
   WHERE queuename LIKE $1 ESCAPE '\\'
     AND time >= ($2::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
     AND time <  (($3::date + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
),
enter AS (
  SELECT callid, queuename, min(time) AS entered, max(data1) AS did, max(data2) AS caller
    FROM ev WHERE event = 'SANTRALIO_ENTER' GROUP BY callid, queuename
)
SELECT e.callid,
       to_char((e.entered AT TIME ZONE 'UTC') AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS started,
       to_char((e.entered AT TIME ZONE 'UTC') AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
       substr(e.queuename, length(split_part(e.queuename, '_', 1)) + 2) AS queue,
       e.caller, e.did,
       COALESCE(c.agent, CASE WHEN x.status = 'ANSWER' THEN x.agent END) AS agent,
       COALESCE(c.hold, ab.wait, tmo.wait, x.wait, 0) AS wait_s,
       COALESCE(done.talk, x.talk, 0) AS talk_s,
       CASE WHEN c.agent IS NOT NULL OR x.status = 'ANSWER' THEN 'answered'
            WHEN ab.callid IS NOT NULL OR x.status = 'CANCEL' THEN 'abandoned'
            WHEN tmo.callid IS NOT NULL THEN 'timeout'
            WHEN na.callid IS NOT NULL OR x.status IN ('NOANSWER', 'BUSY', 'CHANUNAVAIL', 'CONGESTION') THEN 'no_agent'
            ELSE 'open' END AS outcome,
       rec.file AS recording
  FROM enter e
  LEFT JOIN LATERAL (SELECT agent, data1::int AS hold FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event = 'CONNECT' ORDER BY time LIMIT 1) c ON true
  LEFT JOIN LATERAL (SELECT data2::int AS talk FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event IN ('COMPLETECALLER', 'COMPLETEAGENT') ORDER BY time LIMIT 1) done ON true
  LEFT JOIN LATERAL (SELECT callid, data3::int AS wait FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event = 'ABANDON' LIMIT 1) ab ON true
  LEFT JOIN LATERAL (SELECT callid, data3::int AS wait FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event = 'EXITWITHTIMEOUT' LIMIT 1) tmo ON true
  LEFT JOIN LATERAL (SELECT callid FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event = 'SANTRALIO_NOAGENT' LIMIT 1) na ON true
  LEFT JOIN LATERAL (SELECT data1 AS file FROM ev WHERE callid = e.callid AND event = 'SANTRALIO_RECORDING' LIMIT 1) rec ON true
  -- Doğrudan dahili araması (ext:<numara>): durum | toplam süre | konuşma süresi
  LEFT JOIN LATERAL (SELECT agent, data1 AS status, GREATEST(COALESCE(NULLIF(data2, '')::int, 0) - COALESCE(NULLIF(data3, '')::int, 0), 0) AS wait,
                            COALESCE(NULLIF(data3, '')::int, 0) AS talk
                       FROM ev WHERE callid = e.callid AND queuename = e.queuename AND event = 'SANTRALIO_EXT_DONE' LIMIT 1) x ON true
`;

export type CallRow = {
  callid: string;
  started: string;
  day: string;
  queue: string;
  caller: string;
  did: string;
  agent: string | null;
  wait_s: number;
  talk_s: number;
  outcome: "answered" | "abandoned" | "timeout" | "no_agent" | "open";
  recording: string | null;
};

const params = (prefix: string, r: Range) => [likePrefix(prefix), r.from, r.to, r.tz];

export async function listCalls(db: Db, prefix: string, r: Range, limit = 500): Promise<CallRow[]> {
  return (await db.query(`${CALLS} ORDER BY e.entered DESC LIMIT ${Math.min(Math.max(limit, 1), 2000)}`, params(prefix, r))).rows;
}

// Hizmet seviyesi: 20 saniye içinde cevaplanan görüşmelerin oranı.
const SLA_S = 20;

const summarize = (rows: CallRow[]) => {
  const answered = rows.filter((c) => c.outcome === "answered");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length ? Math.round(sum(xs) / xs.length) : 0);
  return {
    offered: rows.length,
    answered: answered.length,
    abandoned: rows.filter((c) => c.outcome === "abandoned").length,
    timeout: rows.filter((c) => c.outcome === "timeout").length,
    noAgent: rows.filter((c) => c.outcome === "no_agent").length,
    answerRate: rows.length ? answered.length / rows.length : null,
    serviceLevel: rows.length ? answered.filter((c) => c.wait_s <= SLA_S).length / rows.length : null,
    avgWaitS: avg(answered.map((c) => c.wait_s)),
    maxWaitS: Math.max(0, ...rows.map((c) => c.wait_s)),
    avgTalkS: avg(answered.map((c) => c.talk_s)),
    totalTalkS: sum(answered.map((c) => c.talk_s)),
  };
};

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

export async function summary(db: Db, prefix: string, r: Range) {
  // Özet için bütün görüşmeler gerekir (liste sınırı uygulanmaz).
  const rows: CallRow[] = (await db.query(CALLS, params(prefix, r))).rows;
  const closed = Number(
    (
      await db.query(
        `SELECT count(*) FROM queue_log WHERE queuename LIKE $1 ESCAPE '\\' AND event = 'SANTRALIO_CLOSED'
            AND time >= ($2::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
            AND time <  (($3::date + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`,
        params(prefix, r),
      )
    ).rows[0].count,
  );
  const missedRings = (
    await db.query(
      `SELECT agent, count(*)::int AS n FROM queue_log WHERE queuename LIKE $1 ESCAPE '\\' AND event = 'RINGNOANSWER'
          AND time >= ($2::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
          AND time <  (($3::date + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
        GROUP BY agent`,
      params(prefix, r),
    )
  ).rows as { agent: string; n: number }[];

  const agents = [...groupBy(rows.filter((c) => c.agent), (c) => c.agent!)].map(([agent, cs]) => ({
    agent,
    answered: cs.length,
    totalTalkS: cs.reduce((a, c) => a + c.talk_s, 0),
    avgTalkS: Math.round(cs.reduce((a, c) => a + c.talk_s, 0) / cs.length),
    missedRings: missedRings.find((m) => m.agent === agent)?.n ?? 0,
  }));
  for (const m of missedRings) {
    if (!agents.some((a) => a.agent === m.agent)) agents.push({ agent: m.agent, answered: 0, totalTalkS: 0, avgTalkS: 0, missedRings: m.n });
  }

  return {
    range: r,
    slaSeconds: SLA_S,
    totals: { ...summarize(rows), closedHours: closed },
    byQueue: [...groupBy(rows, (c) => c.queue)].map(([queue, cs]) => ({ queue, ...summarize(cs) })).sort((a, b) => a.queue.localeCompare(b.queue)),
    byAgent: agents.sort((a, b) => a.agent.localeCompare(b.agent)),
    byDay: [...groupBy(rows, (c) => c.day)].map(([day, cs]) => ({ day, ...summarize(cs) })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
