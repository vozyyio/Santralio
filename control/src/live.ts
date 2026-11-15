// Santralio: canlı durum (bekleyenler, süren görüşmeler, temsilci durumu, uyarılar).
//
// Kaynak Asterisk'in kendisi: "core show channels concise" ve kiracının her kuyruğu için "queue show".
// Burada yalnızca çözümleme ve birleştirme var (saf işlevler, test edilebilir); AMI çağrısı api.ts'te,
// kiracı başına 2 saniyelik önbellekle (çok ekran açık olsa da santrale yük bindirmez).

import { audit, type Db } from "./db.ts";
import { UserError } from "./ops.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export type Channel = {
  name: string;
  context: string;
  exten: string;
  state: string;
  app: string;
  data: string;
  callerId: string;
  durationS: number;
  bridgeId: string;
  uniqueId: string;
};

// Asterisk 20/22: Channel!Context!Exten!Prio!State!App!Data!CallerID!Accountcode!PeerAccount!AMAflags!Duration!BridgeID!Uniqueid
export function parseConcise(lines: string[]): Channel[] {
  const out: Channel[] = [];
  for (const raw of lines) {
    const f = strip(raw).trim().split("!");
    if (f.length < 14) continue;
    out.push({
      name: f[0],
      context: f[1],
      exten: f[2],
      state: f[4],
      app: f[5],
      data: f[6],
      callerId: f[7],
      durationS: Number(f[11]) || 0,
      bridgeId: f[12],
      uniqueId: f[13],
    });
  }
  return out;
}

export type MemberState = "available" | "busy" | "ringing" | "paused" | "offline";
export type QueueSnapshot = {
  queue: string;
  waiting: { channel: string; position: number; waitS: number }[];
  members: { number: string; state: MemberState; pauseReason: string | null }[];
};

export function parseQueue(queue: string, lines: string[]): QueueSnapshot | null {
  const clean = lines.map(strip);
  if (!clean.some((l) => /has \d+ calls? \(/.test(l))) return null;
  const snap: QueueSnapshot = { queue, waiting: [], members: [] };
  let section = "";
  for (const l of clean) {
    const t = l.trim();
    if (/^Members:/.test(t)) section = "m";
    else if (/^Callers:/.test(t)) section = "c";
    else if (/^No (Members|Callers)/.test(t)) section = "";
    else if (section === "m" && t) {
      const number = /^(\S+)/.exec(t)?.[1] ?? "";
      if (!/^\d{2,6}$/.test(number)) continue;
      const paused = /\(paused(?::([^)]*))?/.exec(t);
      let state: MemberState;
      if (/\((Unavailable|Invalid|Unknown)\)/.test(t)) state = "offline";
      else if (paused) state = "paused";
      else if (/\((Ringing|Ring\+Inuse)\)/.test(t)) state = "ringing";
      else if (/\(in call\)|\((In use|Busy|On Hold)\)/.test(t)) state = "busy";
      else if (/\(Not in use\)/.test(t)) state = "available";
      else state = "offline";
      snap.members.push({ number, state, pauseReason: paused ? (paused[1]?.trim() || null) : null });
    } else if (section === "c") {
      const m = /^(\d+)\.\s+(\S+)\s+\(wait:\s*(\d+):(\d{2})/.exec(t);
      if (m) snap.waiting.push({ position: Number(m[1]), channel: m[2], waitS: Number(m[3]) * 60 + Number(m[4]) });
    }
  }
  return snap;
}

export type LiveCall = {
  id: string;
  caller: string;
  direction: "in" | "out" | "internal";
  stage: "queue" | "ai" | "menu" | "ringing" | "talking" | "other";
  queue: string | null;
  agent: string | null;
  durationS: number;
  waitS: number | null;
};
export type LiveAgent = { number: string; name: string; state: MemberState; pauseReason: string | null; queues: string[]; online: boolean };
export type LiveAlert = { kind: "wait" | "waiting" | "no_agent"; queue: string; message: string };
export type LiveSettings = { waitAlertS: number; waitingAlertN: number };
export type Live = {
  at: string;
  waiting: number;
  longestWaitS: number;
  talking: number;
  ai: number;
  queues: { name: string; waiting: number; longestWaitS: number; available: number; busy: number; paused: number; members: number }[];
  agents: LiveAgent[];
  calls: LiveCall[];
  alerts: LiveAlert[];
};

const MENU_APPS = new Set(["Background", "WaitExten", "Read", "Playback", "Record", "SayDigits"]);

// Bir kiracının canlı görünümü. Kanal adlarında kiracı öneki vardır: PJSIP/t7_trunk-…, PJSIP/t7_1001-…, Local/1001@t7-agent….
export function buildLive(
  prefix: string,
  channels: Channel[],
  queues: QueueSnapshot[],
  extensions: { number: string; name: string }[],
  online: Set<string>,
  settings: LiveSettings,
  now = new Date(),
): Live {
  const mine = channels.filter((c) => c.name.startsWith(`PJSIP/${prefix}_`) || c.context.startsWith(`${prefix}-`) || c.name.includes(`@${prefix}-`));
  const byBridge = new Map<string, Channel[]>();
  for (const c of mine) if (c.bridgeId) byBridge.set(c.bridgeId, [...(byBridge.get(c.bridgeId) ?? []), c]);
  const waitOf = new Map<string, { queue: string; waitS: number }>();
  for (const q of queues) for (const w of q.waiting) waitOf.set(w.channel, { queue: q.queue, waitS: w.waitS });

  const agentOf = (c: Channel): string | null => {
    for (const o of byBridge.get(c.bridgeId) ?? []) {
      if (o === c) continue;
      const m = new RegExp(`^(?:PJSIP/${prefix}_(\\d{2,6})-|Local/(\\d{2,6})@${prefix}-agent)`).exec(o.name);
      if (m) return m[1] ?? m[2];
    }
    return null;
  };

  // Müşteri tarafı: operatör hattındaki kanallar. Dahiliden dahiliye aramalar: dahili kanalı Dial ile başka dahiliyi çaldıran.
  const calls: LiveCall[] = [];
  for (const c of mine) {
    const ext = new RegExp(`^PJSIP/${prefix}_trunk-`).test(c.name);
    const internal = new RegExp(`^PJSIP/${prefix}_\\d{2,6}-`).test(c.name) && c.app === "Dial" && !/_trunk/.test(c.data);
    if (!ext && !internal) continue;
    const w = waitOf.get(c.name);
    const agent = c.bridgeId ? agentOf(c) : null;
    let stage: LiveCall["stage"];
    // Kuyruktan bağlanan arayanın uygulaması görüşme boyunca "Queue" kalır: önce köprü (bridge) bakılır.
    if (c.bridgeId && byBridge.get(c.bridgeId)!.length > 1) stage = "talking";
    else if (w || c.app === "Queue") stage = "queue";
    else if (c.app === "AudioSocket") stage = "ai";
    else if (c.app === "Dial") stage = "ringing";
    else if (MENU_APPS.has(c.app)) stage = "menu";
    else stage = "other";
    const outbound = ext && (c.context.endsWith("-qcb-out") || c.context.endsWith("-callback") || c.app === "AppDial" || c.app === "(Outgoing Line)");
    calls.push({
      id: c.uniqueId,
      caller: internal ? new RegExp(`^PJSIP/${prefix}_(\\d+)`).exec(c.name)![1] : c.callerId || "gizli",
      direction: internal ? "internal" : outbound ? "out" : "in",
      stage,
      queue: w?.queue ?? (c.app === "Queue" ? c.data.split(",")[0].slice(prefix.length + 1) || null : null),
      agent,
      durationS: c.durationS,
      waitS: w?.waitS ?? null,
    });
  }
  calls.sort((a, b) => b.durationS - a.durationS);

  // Dahilinin durumu: üye olduğu kuyruklardaki en "meşgul" durum; kuyrukta değilse cihaz kaydına göre.
  const rank: Record<MemberState, number> = { offline: 0, available: 1, paused: 2, ringing: 3, busy: 4 };
  const seen = new Map<string, { state: MemberState; pauseReason: string | null; queues: string[] }>();
  for (const q of queues) {
    for (const m of q.members) {
      const cur = seen.get(m.number) ?? { state: "offline" as MemberState, pauseReason: null, queues: [] };
      cur.queues.push(q.queue);
      if (rank[m.state] > rank[cur.state]) cur.state = m.state;
      if (m.state === "paused") cur.pauseReason = m.pauseReason;
      seen.set(m.number, cur);
    }
  }
  const names = new Map(extensions.map((e) => [e.number, e.name]));
  const agents = new Map<string, LiveAgent>();
  for (const n of new Set([...names.keys(), ...seen.keys()])) {
    const q = seen.get(n);
    agents.set(n, {
      number: n,
      name: names.get(n) ?? "",
      state: q ? q.state : online.has(n) ? "available" : "offline",
      pauseReason: q?.pauseReason ?? null,
      queues: q?.queues ?? [],
      online: online.has(n),
    });
  }
  // Bir görüşmede görünen dahili meşguldür (kuyruk dışı aramalar dahil).
  for (const c of calls) if (c.agent && agents.has(c.agent) && c.stage === "talking") agents.get(c.agent)!.state = "busy";

  const qs = queues.map((q) => {
    const st = (s: MemberState) => q.members.filter((m) => m.state === s).length;
    return {
      name: q.queue,
      waiting: q.waiting.length,
      longestWaitS: Math.max(0, ...q.waiting.map((w) => w.waitS)),
      available: st("available"),
      busy: st("busy") + st("ringing"),
      paused: st("paused"),
      members: q.members.length,
    };
  });
  const alerts: LiveAlert[] = [];
  for (const q of qs) {
    if (q.waiting && q.longestWaitS >= settings.waitAlertS)
      alerts.push({ kind: "wait", queue: q.name, message: `${q.name}: ${Math.floor(q.longestWaitS / 60)}:${String(q.longestWaitS % 60).padStart(2, "0")} bekleyen var` });
    if (q.waiting >= settings.waitingAlertN) alerts.push({ kind: "waiting", queue: q.name, message: `${q.name}: ${q.waiting} kişi bekliyor` });
    if (q.waiting && q.available === 0 && q.busy === 0) alerts.push({ kind: "no_agent", queue: q.name, message: `${q.name}: bekleyen var ama bağlı temsilci yok` });
  }
  return {
    at: now.toISOString(),
    waiting: qs.reduce((s, q) => s + q.waiting, 0),
    longestWaitS: Math.max(0, ...qs.map((q) => q.longestWaitS)),
    talking: calls.filter((c) => c.stage === "talking").length,
    ai: calls.filter((c) => c.stage === "ai").length,
    queues: qs,
    agents: [...agents.values()].sort((a, b) => a.number.localeCompare(b.number)),
    calls,
    alerts,
  };
}

// --- Uyarı eşikleri ---

export async function getSettings(db: Db, tenantId: number): Promise<LiveSettings> {
  const r = (await db.query('SELECT wait_alert_s AS "waitAlertS", waiting_alert_n AS "waitingAlertN" FROM live_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ?? { waitAlertS: 60, waitingAlertN: 3 };
}

export async function saveSettings(db: Db, tenantId: number, input: Partial<LiveSettings>, actor?: string): Promise<LiveSettings> {
  const n = { ...(await getSettings(db, tenantId)), ...input };
  if (!Number.isInteger(n.waitAlertS) || n.waitAlertS < 10 || n.waitAlertS > 1800) throw new UserError("bekleme eşiği 10-1800 saniye");
  if (!Number.isInteger(n.waitingAlertN) || n.waitingAlertN < 1 || n.waitingAlertN > 100) throw new UserError("bekleyen sayısı eşiği 1-100");
  await db.query(
    `INSERT INTO live_settings (tenant_id, wait_alert_s, waiting_alert_n) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET wait_alert_s = $2, waiting_alert_n = $3, updated_at = now()`,
    [tenantId, n.waitAlertS, n.waitingAlertN],
  );
  await audit(db, "live.settings", tenantId, n, actor);
  return n;
}
