// Santralio yönetim API'si istemcisi. Oturum HttpOnly çerezde durur; JavaScript belirteci hiç görmez.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-santralio-client": "web", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export type Role = "platform_admin" | "reseller_admin" | "tenant_admin" | "agent";
export type Me = { email: string; name: string; role: Role; tenant: { prefix: string; name: string } | null; extension: string | null };
export type TenantRow = {
  prefix: string;
  name: string;
  status: string;
  licensed: boolean | null;
  valid_until: string | null;
  max_extensions: number | null;
  max_channels: number | null;
};
export type Hours = { weekdays: string; opens: string; closes: string };
export type Tenant = {
  prefix: string;
  name: string;
  status: string;
  recording: { enabled: boolean; retentionDays: number; noticeText: string };
  license: { source: string; active: boolean; valid_until: string | null; max_extensions: number; max_channels: number } | null;
  trunk: { operator: string; server: string; port: number; transport: string; username: string; enabled: boolean } | null;
  entryPoints: { channel: string; address: string; flow: string; enabled: boolean }[];
  extensions: { number: string; display_name: string; enabled: boolean }[];
  queues: { name: string; number: string | null; strategy: string; ring_s: number; max_wait_s: number; unavailable_text: string; members: string[] }[];
  menus: {
    name: string;
    prompt_text: string;
    invalid_text: string;
    timeout_s: number;
    max_tries: number;
    default_target: string | null;
    options: Record<string, string>;
  }[];
  schedules: {
    name: string;
    timezone: string;
    open_target: string;
    closed_text: string;
    closed_target: string | null;
    hours: Hours[];
    holidays: { day: string; note: string | null }[];
  }[];
};
export type Status = { registration: string; onlineExtensions: string[] };
export type StaffRow = { email: string; name: string; role: Role; extension: string | null; disabled: boolean; last_seen: string | null };
export type AuditRow = { id: number; at: string; actor: string; action: string; tenant: string | null; details: Record<string, unknown> };
export type SystemStatus = {
  asterisk: { uptimeS: number; activeCalls: number; registrations: { name: string; status: string }[] };
  disk: { freeBytes: number; totalBytes: number };
  tenants: number;
  users: number;
  recentProblems: string[];
};
export type Outcome = "answered" | "abandoned" | "timeout" | "no_agent" | "open";
export type CallRow = {
  callid: string;
  started: string;
  queue: string;
  caller: string;
  did: string;
  agent: string | null;
  wait_s: number;
  talk_s: number;
  outcome: Outcome;
  recording: string | null;
};
export type Totals = {
  offered: number;
  answered: number;
  abandoned: number;
  timeout: number;
  noAgent: number;
  answerRate: number | null;
  serviceLevel: number | null;
  avgWaitS: number;
  maxWaitS: number;
  avgTalkS: number;
  totalTalkS: number;
};
export type Summary = {
  slaSeconds: number;
  totals: Totals & { closedHours: number };
  byQueue: (Totals & { queue: string })[];
  byAgent: { agent: string; answered: number; totalTalkS: number; avgTalkS: number; missedRings: number }[];
  byDay: (Totals & { day: string })[];
};
export type Sip = { server: string; port: number; transport: string; username: string; password: string };
export type Agent = {
  tenant: string;
  extension: string;
  displayName: string;
  paused: boolean;
  pausedReason: string | null;
  queues: string[];
  sip: { wsServer: string; uri: string; username: string; password: string };
};

const t = (prefix: string) => `/api/tenants/${encodeURIComponent(prefix)}`;
const seg = encodeURIComponent;

export const api = {
  login: (email: string, password: string) => call<{ user: { email: string; role: Role } }>("POST", "/api/login", { email, password }),
  logout: () => call("POST", "/api/logout"),
  me: () => call<Me>("GET", "/api/me"),
  tenants: () => call<TenantRow[]>("GET", "/api/tenants"),
  tenant: (p: string) => call<Tenant>("GET", t(p)),
  status: (p: string) => call<Status>("GET", `${t(p)}/status`),
  promptUrl: (p: string, name: string) => `${t(p)}/prompts/${seg(name)}`,
  saveMenu: (p: string, name: string, body: object) => call("PUT", `${t(p)}/menus/${seg(name)}`, body),
  saveSchedule: (p: string, name: string, body: object) => call("PUT", `${t(p)}/schedules/${seg(name)}`, body),
  addHoliday: (p: string, name: string, day: string, note: string) =>
    call("POST", `${t(p)}/schedules/${seg(name)}/holidays`, { day, note: note || null }),
  saveUnavailable: (p: string, queue: string, text: string) => call("PUT", `${t(p)}/queues/${seg(queue)}/unavailable-text`, { text }),
  setFlow: (p: string, address: string, flow: string) => call("PUT", `${t(p)}/entry-points/${seg(address)}`, { flow }),
  addExtension: (p: string, number: string, name: string) => call<{ number: string; sip: Sip }>("POST", `${t(p)}/extensions`, { number, name }),
  agent: () => call<Agent>("GET", "/api/agent"),
  saveRecording: (p: string, body: { enabled: boolean; retentionDays: number; noticeText: string }) => call("PUT", `${t(p)}/recording`, body),
  summary: (p: string, from: string, to: string) => call<Summary>("GET", `${t(p)}/reports/summary?from=${from}&to=${to}`),
  calls: (p: string, from: string, to: string) => call<CallRow[]>("GET", `${t(p)}/calls?from=${from}&to=${to}`),
  recordingUrl: (p: string, callid: string) => `${t(p)}/recordings/${seg(callid)}`,
  users: (p: string) => call<StaffRow[]>("GET", `${t(p)}/users`),
  addUser: (p: string, body: { email: string; name: string; role: string; extension: string | null }) =>
    call<{ email: string; temporaryPassword: string }>("POST", `${t(p)}/users`, body),
  setUserDisabled: (p: string, email: string, disabled: boolean) => call("PUT", `${t(p)}/users/${seg(email)}`, { disabled }),
  resetPassword: (p: string, email: string) => call<{ temporaryPassword: string }>("POST", `${t(p)}/users/${seg(email)}/reset-password`),
  setQueueMembers: (p: string, q: string, members: string[]) => call("PUT", `${t(p)}/queues/${seg(q)}/members`, { members }),
  setQueueNumber: (p: string, q: string, number: string | null) => call("PUT", `${t(p)}/queues/${seg(q)}/number`, { number }),
  audit: (p: string | null, from: string, to: string, action = "") =>
    call<AuditRow[]>("GET", `${p ? `${t(p)}/audit` : "/api/audit"}?from=${from}&to=${to}${action ? `&action=${encodeURIComponent(action)}` : ""}`),
  system: () => call<SystemStatus>("GET", "/api/system"),
  directory: () => call<{ queues: { name: string; number: string | null }[]; extensions: { number: string; name: string }[] }>("GET", "/api/agent/directory"),
  setPause: (paused: boolean, reason?: string) => call<{ paused: boolean }>("PUT", "/api/agent/pause", { paused, reason: reason ?? null }),
};
