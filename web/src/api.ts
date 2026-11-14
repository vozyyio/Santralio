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

// --- Ödeme modülü ---
export type PayField = { key: string; label: string; secret: boolean; hint?: string };
export type PayCatalogEntry = {
  id: string;
  name: string;
  kind: "psp" | "bank" | "international" | "test";
  status: "available" | "planned";
  banks?: string[];
  fields: PayField[];
  features: { link: boolean; providerSms: boolean; secureDtmf: boolean; installments: boolean };
  docs?: string;
};
export type PayProvider = {
  id: number;
  provider: string;
  name: string;
  label: string;
  mode: "test" | "live";
  enabled: boolean;
  isDefault: boolean;
  fields: Record<string, string | boolean>;
  motoConfirmed: boolean;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
};
export type PayProfile = {
  id?: number;
  name: string;
  title: string;
  providerId: number | null;
  amountSource: "fixed" | "agent" | "lookup";
  fixedAmount: string | null;
  maxAmount: string;
  currency: string;
  lookupUrl: string | null;
  methods: "link" | "dtmf" | "both";
  maxInstallment: number;
  expiresMinutes: number;
  askText: string;
  smsText: string;
  successText: string;
  enabled: boolean;
};
export type PaySms = { sender: "netgsm" | "provider" | "none"; fields: Record<string, string | boolean> };
export type PayRequest = {
  id: string;
  status: "created" | "sent" | "paid" | "failed" | "expired" | "cancelled";
  method: "link" | "dtmf";
  amount: string;
  currency: string;
  description: string;
  phone: string | null;
  callId: string | null;
  linkUrl: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  cardLast4: string | null;
  paidAmount: string | null;
  error: string | null;
  createdBy: string;
  createdByUser: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  provider: string;
  providerLabel: string;
  mode: "test" | "live";
  profile: string | null;
};
export type PayProfileLite = Pick<PayProfile, "name" | "title" | "amountSource" | "fixedAmount" | "maxAmount" | "currency" | "methods">;


// --- Kaçan çağrıya otomatik geri arama ---
export type CallbackSettings = {
  enabled: boolean;
  aiFlow: string;
  delayS: number;
  maxAttempts: number;
  retryMinutes: number;
  cooldownHours: number;
  maxAgeMinutes: number;
  maxConcurrent: number;
  windowStart: string;
  windowEnd: string;
  weekdays: number[];
  timezone: string;
  international: boolean;
  greetingTr: string;
  greetingEn: string;
};
export type CallbackJob = {
  id: number;
  phone: string;
  reason: "abandoned" | "timeout" | "no_agent";
  status: "pending" | "dialing" | "answered" | "no_answer" | "resolved" | "skipped" | "cancelled" | "failed";
  attempts: number;
  note: string | null;
  missedAt: string;
  nextAt: string;
  lastAttemptAt: string | null;
  aiSummary: string | null;
  aiRoute: string | null;
};
export type CallbackOptout = { phone: string; reason: string; createdBy: string; createdAt: string };

export type Hours = { weekdays: string; opens: string; closes: string };
export type VozyyLicense = {
  licenseId: string;
  plan: string;
  status: string;
  installMode: string;
  installStatus: string;
  panelDomain: string | null;
  slug: string | null;
  validUntil: string | null;
  maxExtensions: number;
  maxChannels: number;
  modules: string[];
  company: string;
  email: string;
  lastCheckedAt: string | null;
  checkError: string | null;
  prefix: string | null;
  invite: { link: string | null; expiresAt: string; sent: boolean } | null;
};
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
  recognizeCallers: boolean;
};
export type CallerHistory = { previousCalls: number; lastCallAt: string | null; lastSummary: string | null };
export type LookupResult = { phone: string | null; contact: Contact | null; notes: Note[]; history?: CallerHistory };
export type WebhookEvent = { type: string; label: string; group: string };
export type Webhook = {
  id: number;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  failStreak: number;
  disabledReason: string | null;
  createdAt: string;
  pending: number;
  failed7d: number;
  lastDeliveredAt: string | null;
};
export type WebhookDelivery = {
  id: number;
  eventId: string;
  type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastCode: number | null;
  lastError: string | null;
  payload: unknown;
  createdAt: string;
  nextAt: string;
  deliveredAt: string | null;
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
  lookup: (p: string, phone: string, callid?: string | null) =>
    call<LookupResult>("GET", `${t(p)}/lookup?phone=${encodeURIComponent(phone)}${callid ? `&callid=${encodeURIComponent(callid)}` : ""}`),
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
  vozyyLicenses: () => call<{ configured: boolean; licenses: VozyyLicense[] }>("GET", "/api/vozyy/licenses"),
  inviteCheck: (token: string) => call<{ email: string; name: string; company: string }>("POST", "/api/invite/check", { token }),
  inviteAccept: (token: string, password: string) => call<{ ok: true; email: string }>("POST", "/api/invite/accept", { token, password }),
  directory: () => call<{ queues: { name: string; number: string | null }[]; extensions: { number: string; name: string }[] }>("GET", "/api/agent/directory"),
  payCatalog: () => call<PayCatalogEntry[]>("GET", "/api/payments/catalog"),
  paySettings: (p: string) => call<{ providers: PayProvider[]; profiles: PayProfile[]; sms: PaySms }>("GET", `${t(p)}/payments/settings`),
  payAddProvider: (p: string, b: { provider: string; label: string; mode: string; credentials: Record<string, string>; isDefault?: boolean }) =>
    call<{ id: number }>("POST", `${t(p)}/payments/providers`, b),
  payUpdateProvider: (p: string, id: number, b: Partial<{ label: string; mode: string; credentials: Record<string, string>; enabled: boolean; isDefault: boolean }>) =>
    call<{ id: number }>("PUT", `${t(p)}/payments/providers/${id}`, b),
  payTestProvider: (p: string, id: number) => call<{ ok: boolean; error: string | null }>("POST", `${t(p)}/payments/providers/${id}/test`, {}),
  payDeleteProvider: (p: string, id: number) => call<{ ok: true }>("DELETE", `${t(p)}/payments/providers/${id}`),
  paySaveSms: (p: string, b: { sender: string; credentials?: Record<string, string> }) => call<{ ok: true }>("PUT", `${t(p)}/payments/sms`, b),
  paySaveProfile: (p: string, name: string, b: Partial<PayProfile>) => call<{ ok: true }>("PUT", `${t(p)}/payments/profiles/${seg(name)}`, b),
  payDisableProfile: (p: string, name: string) => call<{ ok: true }>("DELETE", `${t(p)}/payments/profiles/${seg(name)}`),
  payProfiles: (p: string) => call<PayProfileLite[]>("GET", `${t(p)}/payments/profiles`),
  payRequests: (p: string, q: { status?: string; call?: string; limit?: number } = {}) =>
    call<PayRequest[]>("GET", `${t(p)}/payments/requests?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  payCreate: (p: string, b: { profile?: string; amount?: string; description?: string; phone?: string; callId?: string | null; sendSms?: boolean }) =>
    call<PayRequest>("POST", `${t(p)}/payments/requests`, b),
  payRequest: (p: string, id: string) => call<PayRequest>("GET", `${t(p)}/payments/requests/${seg(id)}`),
  payCancel: (p: string, id: string) => call<{ ok: true }>("POST", `${t(p)}/payments/requests/${seg(id)}/cancel`, {}),
  whList: (p: string) => call<{ webhooks: Webhook[]; events: WebhookEvent[] }>("GET", `${t(p)}/webhooks`),
  whAdd: (p: string, b: { url: string; events: string[]; description: string }) => call<{ id: number; secret: string }>("POST", `${t(p)}/webhooks`, b),
  whUpdate: (p: string, id: number, b: Partial<{ url: string; events: string[]; description: string; enabled: boolean }>) => call<{ ok: true }>("PUT", `${t(p)}/webhooks/${id}`, b),
  whDelete: (p: string, id: number) => call<{ ok: true }>("DELETE", `${t(p)}/webhooks/${id}`),
  whRotate: (p: string, id: number) => call<{ secret: string }>("POST", `${t(p)}/webhooks/${id}/rotate`, {}),
  whTest: (p: string, id: number) => call<{ eventId: string }>("POST", `${t(p)}/webhooks/${id}/test`, {}),
  whDeliveries: (p: string, id: number) => call<WebhookDelivery[]>("GET", `${t(p)}/webhooks/${id}/deliveries`),
  whRetry: (p: string, id: number) => call<{ ok: true }>("POST", `${t(p)}/webhooks/deliveries/${id}/retry`, {}),
  cbSettings: (p: string) =>
    call<{ settings: CallbackSettings; flows: { name: string; enabled: boolean }[]; defaults: { greetingTr: string; greetingEn: string } }>("GET", `${t(p)}/callbacks/settings`),
  cbSave: (p: string, b: CallbackSettings) => call<CallbackSettings>("PUT", `${t(p)}/callbacks/settings`, b),
  cbJobs: (p: string, limit = 50) => call<CallbackJob[]>("GET", `${t(p)}/callbacks?limit=${limit}`),
  cbCancel: (p: string, id: number) => call<{ ok: true }>("POST", `${t(p)}/callbacks/${id}/cancel`, {}),
  cbOptout: (p: string) => call<CallbackOptout[]>("GET", `${t(p)}/callbacks/optout`),
  cbOptoutAdd: (p: string, phone: string, reason: string) => call<{ ok: true }>("POST", `${t(p)}/callbacks/optout`, { phone, reason }),
  cbOptoutRemove: (p: string, phone: string) => call<{ ok: true }>("DELETE", `${t(p)}/callbacks/optout/${seg(phone)}`),
  setPause: (paused: boolean, reason?: string) => call<{ paused: boolean }>("PUT", "/api/agent/pause", { paused, reason: reason ?? null }),
};
