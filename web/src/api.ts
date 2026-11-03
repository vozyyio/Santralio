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

export type Role = "platform_admin" | "reseller_admin" | "tenant_user";
export type AppName = "panel" | "crm" | "agent";
export type Me = {
  email: string;
  name: string;
  role: Role;
  roleName: string | null;
  permissions: string[];
  apps: AppName[];
  origins: Record<AppName, string>;
  tenant: { prefix: string; name: string } | null;
  extension: string | null;
};
export type RoleRow = { id: number; name: string; permissions: string[]; users: number };
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
export type AiFlow = {
  name: string;
  enabled: boolean;
  greetingText: string;
  instructions: string;
  routes: { target: string; description: string }[];
  defaultTarget: string | null;
  maxTurns: number;
  voice: string;
  model: string;
  languages: string[];
  greetings: Record<string, string>;
};
export type AiLanguage = { code: string; label: string; flag: string; defaultGreeting: string };
export type AiInfo = {
  enabled: boolean;
  editable: boolean;
  flows: AiFlow[];
  usage: { sessions: number; sttSeconds: number; ttsChars: number; inputTokens: number; outputTokens: number; transferred: number; errors: number };
  service: { fake: boolean; azure: boolean; anthropic: boolean; region: string } | null;
  voices: { id: string; label: string }[];
  models: { id: string; label: string }[];
  languages: AiLanguage[];
};
export type PromptRow = {
  name: string;
  label: string;
  text: string;
  upload: { originalName: string; durationS: number; uploadedBy: string; uploadedAt: string } | null;
};
export type Tenant = {
  prefix: string;
  name: string;
  status: string;
  voice: string;
  pbxOpen: boolean;
  pbxClosedText: string;
  aiFlows: string[];
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
export type StaffRow = {
  email: string;
  name: string;
  roleId: number;
  roleName: string;
  extension: string | null;
  disabled: boolean;
  last_seen: string | null;
};
export type AuditRow = { id: number; at: string; actor: string; action: string; tenant: string | null; details: Record<string, unknown> };
export type SystemStatus = {
  asterisk: { uptimeS: number; activeCalls: number; registrations: { name: string; status: string }[] };
  disk: { freeBytes: number; totalBytes: number };
  tenants: number;
  users: number;
  recentProblems: string[];
};
export type Outcome = "answered" | "abandoned" | "timeout" | "no_agent" | "open";
export type Contact = { id: number; name: string; company: string; email: string; tags: string[]; phones: string[] };
export type Note = { id: number; callid: string | null; direction: "in" | "out" | null; phone: string | null; note: string; user: string; disposition: string | null; at: string; followUpAt: string | null };
export type ContactDetail = Contact & { notes: Note[]; calls: CallRow[] };
export type Disposition = { id: number; name: string; sort: number; enabled: boolean };
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
  note?: string | null;
  disposition?: string | null;
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
  outbound: { calls: number; answered: number; totalTalkS: number; avgTalkS: number; byAgent: { agent: string; calls: number; answered: number; totalTalkS: number }[] };
};
export type Sip = { server: string; port: number; transport: string; username: string; password: string };
export type Agent = {
  tenant: string;
  extension: string;
  displayName: string;
  paused: boolean;
  pausedReason: string | null;
  queues: string[];
  outbound: string[] | null;
  crm: boolean;
  sip: { wsServer: string; uri: string; domain: string; username: string; password: string };
};
export type Policy = {
  template: string;
  enabled: boolean;
  trMobile: boolean;
  trLandline: boolean;
  trNational: boolean;
  trTollfree: boolean;
  countries: string[];
  maxConcurrent: number;
  dailyLimit: number;
  maxMinutes: number;
};
export type PolicyView = { policy: Policy; patterns: string[]; editable: boolean; templates: { id: string; label: string; policy: Policy }[] };

const t = (prefix: string) => `/api/tenants/${encodeURIComponent(prefix)}`;
const seg = encodeURIComponent;

export const api = {
  login: (email: string, password: string) => call<{ user: { email: string } }>("POST", "/api/login", { email, password }),
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
  addUser: (p: string, body: { email: string; name: string; roleId: number; extension: string | null }) =>
    call<{ email: string; temporaryPassword: string }>("POST", `${t(p)}/users`, body),
  updateUser: (p: string, email: string, body: { disabled?: boolean; roleId?: number; extension?: string | null }) =>
    call("PUT", `${t(p)}/users/${seg(email)}`, body),
  roles: (p: string) => call<RoleRow[]>("GET", `${t(p)}/roles`),
  addRole: (p: string, name: string, permissions: string[]) => call<{ id: number }>("POST", `${t(p)}/roles`, { name, permissions }),
  saveRole: (p: string, id: number, name: string, permissions: string[]) => call("PUT", `${t(p)}/roles/${id}`, { name, permissions }),
  deleteRole: (p: string, id: number) => call("DELETE", `${t(p)}/roles/${id}`),
  permissions: () => call<{ id: string; label: string }[]>("GET", "/api/permissions"),
  ai: (p: string) => call<AiInfo>("GET", `${t(p)}/ai`),
  setAiEnabled: (p: string, enabled: boolean) => call("PUT", `${t(p)}/ai/enabled`, { enabled }),
  saveAiFlow: (p: string, name: string, flow: AiFlow) => call("PUT", `${t(p)}/ai/flows/${seg(name)}`, flow),
  aiSessions: (p: string, from: string, to: string) => call<any[]>("GET", `${t(p)}/ai/sessions?from=${from}&to=${to}`),
  aiSummary: (p: string, callid: string) =>
    call<{ summary: string | null; transcript: { role: string; text: string }[]; language: string | null } | null>("GET", `${t(p)}/ai/summary?callid=${encodeURIComponent(callid)}`),
  voices: () => call<{ id: string; label: string }[]>("GET", "/api/voices"),
  voiceSampleUrl: (id: string) => `/api/voices/${encodeURIComponent(id)}/sample`,
  setVoice: (p: string, voice: string) => call("PUT", `${t(p)}/voice`, { voice }),
  prompts: (p: string) => call<PromptRow[]>("GET", `${t(p)}/prompts`),
  uploadPrompt: async (p: string, name: string, blob: Blob, filename: string) => {
    const res = await fetch(`${t(p)}/prompts/${seg(name)}/upload`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-santralio-client": "web", "content-type": blob.type || "application/octet-stream", "x-filename": encodeURIComponent(filename) },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as { ok: true; durationS: number };
  },
  removePromptUpload: (p: string, name: string) => call("DELETE", `${t(p)}/prompts/${seg(name)}/upload`),
  setPbx: (p: string, open: boolean, closedText: string) => call("PUT", `${t(p)}/pbx`, { open, closedText }),
  outboundPolicy: (p: string) => call<PolicyView>("GET", `${t(p)}/outbound-policy`),
  contacts: (p: string, q: string) => call<Contact[]>("GET", `${t(p)}/contacts?q=${encodeURIComponent(q)}`),
  contact: (p: string, id: number) => call<ContactDetail>("GET", `${t(p)}/contacts/${id}`),
  addContact: (p: string, body: object) => call<{ id: number }>("POST", `${t(p)}/contacts`, body),
  saveContact: (p: string, id: number, body: object) => call("PUT", `${t(p)}/contacts/${id}`, body),
  lookup: (p: string, phone: string) => call<{ phone: string | null; contact: Contact | null; notes: Note[] }>("GET", `${t(p)}/lookup?phone=${encodeURIComponent(phone)}`),
  addNote: (p: string, body: object) => call<{ id: number }>("POST", `${t(p)}/notes`, body),
  followUps: (p: string) => call<any[]>("GET", `${t(p)}/follow-ups`),
  dispositions: (p: string, all = false) => call<Disposition[]>("GET", `${t(p)}/dispositions${all ? "?all=1" : ""}`),
  addDisposition: (p: string, name: string) => call("POST", `${t(p)}/dispositions`, { name }),
  saveDisposition: (p: string, id: number, name: string, enabled: boolean) => call("PUT", `${t(p)}/dispositions/${id}`, { name, enabled }),
  saveOutboundPolicy: (p: string, policy: Policy) => call<{ policy: Policy; patterns: string[] }>("PUT", `${t(p)}/outbound-policy`, policy),
  resetPassword: (p: string, email: string) => call<{ temporaryPassword: string }>("POST", `${t(p)}/users/${seg(email)}/reset-password`),
  setQueueMembers: (p: string, q: string, members: string[]) => call("PUT", `${t(p)}/queues/${seg(q)}/members`, { members }),
  setQueueNumber: (p: string, q: string, number: string | null) => call("PUT", `${t(p)}/queues/${seg(q)}/number`, { number }),
  audit: (p: string | null, from: string, to: string, action = "") =>
    call<AuditRow[]>("GET", `${p ? `${t(p)}/audit` : "/api/audit"}?from=${from}&to=${to}${action ? `&action=${encodeURIComponent(action)}` : ""}`),
  system: () => call<SystemStatus>("GET", "/api/system"),
  directory: () => call<{ queues: { name: string; number: string | null }[]; extensions: { number: string; name: string }[] }>("GET", "/api/agent/directory"),
  setPause: (paused: boolean, reason?: string) => call<{ paused: boolean }>("PUT", "/api/agent/pause", { paused, reason: reason ?? null }),
};
