// Santralio yönetim API'si. Web paneli ve mobil uygulama bu API'yi kullanır.
// Yalnızca localhost'u dinler; dışarıya HTTPS ters vekil (reverse proxy) üzerinden açılır.
// Kimlik: mobil/uygulama "Authorization: Bearer <belirteç>", web paneli HttpOnly çerez.
//   POST /api/login, "x-santralio-client: web" başlığıyla çağrılırsa belirteci çereze yazar ve gövdede döndürmez.
//   Çerezle gelen değişiklik istekleri yalnızca panelin kaynağından (Origin) kabul edilir (CSRF).
// Kullanıcının erişemediği kiracı için 404 döner: başka kiracıların varlığı dışarıdan anlaşılmaz.

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import pg from "pg";
import { Ami, reloadTenants } from "./ami.ts";
import { installUploadedPrompt, renderAll, tenantPrompts } from "./apply.ts";
import { listVoices, synthesize } from "./voices.ts";
import {
  appsFor,
  burnTime,
  can,
  createSession,
  revokeSession,
  SESSION_DAYS,
  tenantScope,
  userBySession,
  verifyPassword,
  type User,
} from "./auth.ts";
import { BASE_DOMAIN, masterKey, PG_DATABASE, PG_HOST, SIP_HOST, SOUNDS_DIR } from "./config.ts";
import { aad, open } from "./crypto.ts";
import { recordingDir } from "./render.ts";
import { listCalls, parseRange, summary, type CallRow } from "./reports.ts";
import * as crm from "./crm.ts";
import { AI_MODELS, aiVoices, saveFlow } from "./aiops.ts";
import { tx, type Db } from "./db.ts";
import * as ops from "./ops.ts";
import { dialPatterns, TEMPLATES, type Policy } from "./outbound.ts";
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from "./permissions.ts";
import { UserError, type Tenant } from "./ops.ts";

const PORT = Number(process.env.SANTRALIO_API_PORT ?? 8090);
const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024;
const VOICE_SAMPLES_DIR = "/var/lib/santralio/voice-samples";
// Üç adres: panel (ayarlar), crm (görüşmeler, raporlar, müşteriler), agent (temsilci masası).
// Oturum çerezi ortak üst alan adına yazılır; tek girişle üç adres arasında geçilir.
const ORIGINS = {
  panel: `https://panel.${BASE_DOMAIN}`,
  crm: `https://crm.${BASE_DOMAIN}`,
  agent: `https://agent.${BASE_DOMAIN}`,
} as const;
const ALLOWED_ORIGINS = new Set<string>(Object.values(ORIGINS));
const COOKIE = "santralio_session";
const COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.${BASE_DOMAIN}`;

const pool = new pg.Pool({ host: PG_HOST, database: PG_DATABASE, max: 5 });

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  db: Db;
  user: User | null;
  token: string | null;
  params: string[];
  body: any;
  ip: string;
};

// Uç nokta JSON yerine ham yanıt döndürmek isterse (ör. ses dosyası) bunu döndürür.
class Raw {
  type: string;
  data: Buffer;
  constructor(type: string, data: Buffer) {
    this.type = type;
    this.data = data;
  }
}
type Handler = (ctx: Ctx) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; auth: boolean; raw: boolean; handler: Handler };

// Değişiklik yapan istekler tek bir veritabanı işleminde çalışır: bir adım reddedilirse hiçbiri kalmaz.
// Asterisk'e uygulama, işlem tamamlandıktan sonra yapılır.
const pendingApply = new WeakSet<Db>();

const routes: Route[] = [];
// raw: gövde JSON değil ham baytlardır (ör. ses dosyası yükleme), en fazla MAX_RAW_BODY.
const route = (method: string, path: string, handler: Handler, auth = true, raw = false) => {
  const pattern = new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "$");
  routes.push({ method, pattern, auth, raw, handler });
};
const MAX_RAW_BODY = 12 * 1024 * 1024;

// --- Giriş denemesi sınırı: IP başına 15 dakikada 10 başarısız deneme ---
const failures = new Map<string, { count: number; since: number }>();
function loginAllowed(ip: string): boolean {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60_000) return true;
  return f.count < 10;
}
function loginFailed(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60_000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

// --- Yardımcılar ---
function need(user: User | null): User {
  if (!user) throw new UserError("oturum gerekli", 401);
  return user;
}

// Kiracıya erişimin tek kapısı: kapsam ve (verilirse) yetkilerden en az biri.
// Erişilemeyen kiracı ile olmayan kiracı aynı yanıtı alır (404).
async function tenantFor(ctx: Ctx, prefix: string, ...perms: Permission[]): Promise<Tenant> {
  const user = need(ctx.user);
  const t = await ops.tenantByPrefix(ctx.db, prefix).catch(() => null);
  if (!t || !can(user, t, ...perms)) throw new UserError("bulunamadı", 404);
  return t;
}

const has = (ctx: Ctx, p: Permission) => need(ctx.user).permissions.includes(p);

async function myExtension(ctx: Ctx): Promise<string | null> {
  const id = need(ctx.user).extension_id;
  if (!id) return null;
  return (await ctx.db.query("SELECT number FROM extensions WHERE id = $1", [id])).rows[0]?.number ?? null;
}

const actor = (ctx: Ctx) => `api:${ctx.user!.email}`;

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new UserError(`${name} metin olmalı`);
  return v;
}
function optStr(v: unknown, name: string): string | null {
  return v == null ? null : str(v, name);
}
function optInt(v: unknown, name: string): number | undefined {
  if (v == null) return undefined;
  if (!Number.isInteger(v)) throw new UserError(`${name} tam sayı olmalı`);
  return v as number;
}

// Değişiklikler Asterisk'e sırayla uygulanır (aynı anda iki üretim olmaz).
let applying: Promise<void> = Promise.resolve();
function applyChanges(db: Db) {
  pendingApply.add(db);
}

async function runApply(db: Db) {
  const run = applying.then(async () => {
    await renderAll(db);
    await reloadTenants();
  });
  applying = run.catch(() => {});
  await run;
}

// --- Uç noktalar ---

route(
  "POST",
  "/api/login",
  async (ctx) => {
    if (!loginAllowed(ctx.ip)) throw new UserError("çok fazla deneme; 15 dakika sonra tekrar deneyin", 429);
    const email = str(ctx.body?.email, "email").trim().toLowerCase();
    const password = str(ctx.body?.password, "password");
    const u = (await ctx.db.query("SELECT * FROM users WHERE email = $1 AND NOT disabled", [email])).rows[0];
    if (!u) {
      await burnTime(password);
      loginFailed(ctx.ip);
      throw new UserError("e-posta ya da şifre hatalı", 401);
    }
    if (!(await verifyPassword(password, u.password_hash))) {
      loginFailed(ctx.ip);
      throw new UserError("e-posta ya da şifre hatalı", 401);
    }
    const token = await createSession(ctx.db, u.id, ctx.ip);
    const web = ctx.req.headers["x-santralio-client"] === "web";
    await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'user.login', $3)", [
      `api:${u.email}`,
      u.tenant_id,
      JSON.stringify({ ip: ctx.ip }),
    ]);
    const user = { email: u.email, name: u.name };
    if (web) {
      // Çerez üç adreste de geçerlidir (Domain=.<alan>) ve temsilci masasının WebSocket bağlantısında (/ws) da gönderilir.
      // SameSite=Lax: adresler arasında bağlantıyla geçişte oturum korunur; değişiklik istekleri ayrıca Origin ile denetlenir.
      ctx.res.setHeader("set-cookie", `${COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_DAYS * 86400}`);
      return { user };
    }
    return { token, user };
  },
  false,
);

route("POST", "/api/logout", async (ctx) => {
  await revokeSession(ctx.db, ctx.token!);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'user.logout', $3)", [
    actor(ctx),
    ctx.user!.tenant_id,
    JSON.stringify({ ip: ctx.ip }),
  ]);
  // Eski sürümlerin adrese özel çerezleri de silinir.
  ctx.res.setHeader("set-cookie", [
    `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`,
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`,
  ]);
  return { ok: true };
});

route("GET", "/api/me", async (ctx) => {
  const u = need(ctx.user);
  const tenant = u.tenant_id ? (await ctx.db.query("SELECT prefix, name FROM tenants WHERE id = $1", [u.tenant_id])).rows[0] : null;
  const ext = u.extension_id ? (await ctx.db.query("SELECT number FROM extensions WHERE id = $1", [u.extension_id])).rows[0] : null;
  return {
    email: u.email,
    name: u.name,
    role: u.role,
    roleName: u.role_name,
    permissions: u.permissions,
    apps: appsFor(u),
    origins: ORIGINS,
    tenant,
    extension: ext?.number ?? null,
  };
});

// Yetki kataloğu (rol ekranı için).
route("GET", "/api/permissions", async () => Object.entries(PERMISSIONS).map(([id, label]) => ({ id, label })));

// --- Roller ---

route("GET", "/api/tenants/:prefix/roles", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  return (
    await ctx.db.query(
      `SELECT r.id, r.name, r.permissions, (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND NOT u.disabled) AS users
         FROM roles r WHERE r.tenant_id = $1 ORDER BY r.id`,
      [t.id],
    )
  ).rows;
});

function rolePermissions(v: unknown): Permission[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || !(ALL_PERMISSIONS as string[]).includes(p))) {
    throw new UserError("permissions geçerli yetki adlarından oluşan bir liste olmalı");
  }
  return [...new Set(v as Permission[])];
}

route("POST", "/api/tenants/:prefix/roles", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  const id = await ops.saveRole(ctx.db, t, null, str(ctx.body?.name, "name"), rolePermissions(ctx.body?.permissions), actor(ctx));
  return { id };
});

route("PUT", "/api/tenants/:prefix/roles/:id", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  const id = Number(ctx.params[1]);
  const perms = rolePermissions(ctx.body?.permissions);
  // Kendini kilitlememek için: kendi rolünden personel yönetimi yetkisi kaldırılamaz.
  if (ctx.user!.role_id === id && !perms.includes("staff.manage")) throw new UserError("kendi rolünüzden personel yönetimi yetkisini kaldıramazsınız");
  await ops.saveRole(ctx.db, t, id, str(ctx.body?.name, "name"), perms, actor(ctx));
  // Rolün dış arama yetkisi değişmiş olabilir: o roldeki dahililerin santral context'i güncellenir.
  applyChanges(ctx.db);
  return { ok: true };
});

route("DELETE", "/api/tenants/:prefix/roles/:id", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  await ops.deleteRole(ctx.db, t, Number(ctx.params[1]), actor(ctx));
  return { ok: true };
});

route("GET", "/api/tenants", async (ctx) => {
  const u = need(ctx.user);
  const scope = tenantScope(u);
  return (
    await ctx.db.query(
      `SELECT t.prefix, t.name, t.status, l.active AS licensed, l.valid_until, l.max_extensions, l.max_channels
         FROM tenants t LEFT JOIN licenses l ON l.tenant_id = t.id WHERE ${scope.where} ORDER BY t.id`,
      scope.params,
    )
  ).rows;
});

route("GET", "/api/tenants/:prefix", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage", "staff.manage");
  const q = (sql: string) => ctx.db.query(sql, [t.id]).then((r) => r.rows);
  // Gizli alanlar (trunk ve dahili şifreleri) hiçbir zaman döndürülmez.
  const [license] = await q("SELECT source, active, valid_until, max_extensions, max_channels, modules FROM licenses WHERE tenant_id = $1");
  const [trunk] = await q("SELECT operator, server, port, transport, username, enabled FROM trunks WHERE tenant_id = $1");
  const [rec] = await q("SELECT recording_enabled AS enabled, recording_retention_days AS \"retentionDays\", recording_notice_text AS \"noticeText\" FROM tenants WHERE id = $1");
  return {
    prefix: t.prefix,
    name: t.name,
    status: t.status,
    recording: rec,
    ...(await q(`SELECT tts_voice AS voice, pbx_open AS "pbxOpen", pbx_closed_text AS "pbxClosedText" FROM tenants WHERE id = $1`))[0],
    aiFlows: (await q("SELECT name FROM ai_flows WHERE tenant_id = $1 ORDER BY name")).map((r) => r.name),
    license: license ?? null,
    trunk: trunk ?? null,
    entryPoints: await q("SELECT channel, address, flow, enabled FROM entry_points WHERE tenant_id = $1 ORDER BY address"),
    extensions: await q("SELECT number, display_name, enabled FROM extensions WHERE tenant_id = $1 ORDER BY number"),
    queues: await q(
      `SELECT q.name, q.number, q.strategy, q.ring_s, q.max_wait_s, q.unavailable_text,
              COALESCE(array_agg(e.number ORDER BY e.number) FILTER (WHERE e.number IS NOT NULL), '{}') AS members
         FROM queues q LEFT JOIN queue_members m ON m.queue_id = q.id LEFT JOIN extensions e ON e.id = m.extension_id
        WHERE q.tenant_id = $1 GROUP BY q.id ORDER BY q.name`,
    ),
    menus: await q(
      `SELECT m.name, m.prompt_text, m.invalid_text, m.timeout_s, m.max_tries, m.default_target,
              COALESCE(jsonb_object_agg(o.digit, o.target) FILTER (WHERE o.digit IS NOT NULL), '{}') AS options
         FROM menus m LEFT JOIN menu_options o ON o.menu_id = m.id WHERE m.tenant_id = $1 GROUP BY m.id ORDER BY m.name`,
    ),
    schedules: await q(
      `SELECT s.name, s.timezone, s.open_target, s.closed_text, s.closed_target,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('weekdays', h.weekdays, 'opens', to_char(h.opens, 'HH24:MI'),
                         'closes', to_char(h.closes, 'HH24:MI')) ORDER BY h.opens) FROM schedule_hours h WHERE h.schedule_id = s.id), '[]') AS hours,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('day', to_char(d.day, 'YYYY-MM-DD'), 'note', d.note) ORDER BY d.day)
                         FROM schedule_holidays d WHERE d.schedule_id = s.id AND d.day >= current_date), '[]') AS holidays
         FROM schedules s WHERE s.tenant_id = $1 ORDER BY s.name`,
    ),
  };
});

// --- Temsilci masası ---

// Caddy, /ws (SIP-over-WebSocket) bağlantısını açmadan önce buraya sorar: yalnızca dahilisi olan
// oturumlu kullanıcı geçer. SIP kimlik doğrulaması ayrıca Asterisk'te yapılır.
route("GET", "/api/auth/ws", async (ctx) => {
  if (!need(ctx.user).extension_id || !has(ctx, "agent.desk")) throw new UserError("temsilci masası yetkisi yok", 403);
  return { ok: true };
});

async function agentExtension(ctx: Ctx) {
  const u = need(ctx.user);
  if (!has(ctx, "agent.desk")) throw new UserError("temsilci masası yetkisi yok", 403);
  if (!u.extension_id) throw new UserError("bu hesaba bağlı dahili yok", 404);
  const e = (
    await ctx.db.query(
      `SELECT e.*, t.prefix FROM extensions e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1 AND e.tenant_id = $2`,
      [u.extension_id, u.tenant_id],
    )
  ).rows[0];
  if (!e) throw new UserError("bu hesaba bağlı dahili yok", 404);
  return e as { id: number; tenant_id: number; prefix: string; number: string; display_name: string; secret_enc: Buffer; key_id: string; paused: boolean; paused_reason: string | null };
}

// Temsilcinin kendi tarayıcı uç noktasının SIP bilgileri. Yalnızca kendi dahilisi için, HTTPS üzerinden.
route("GET", "/api/agent", async (ctx) => {
  const e = await agentExtension(ctx);
  const queues = (
    await ctx.db.query(
      "SELECT q.name FROM queue_members m JOIN queues q ON q.id = m.queue_id WHERE m.extension_id = $1 ORDER BY q.name",
      [e.id],
    )
  ).rows.map((r) => r.name);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'agent.sip_credentials', $3)", [
    actor(ctx),
    e.tenant_id,
    JSON.stringify({ number: e.number, ip: ctx.ip }),
  ]);
  const pol = await ops.getPolicy(ctx.db, e.tenant_id);
  const trunk = (await ctx.db.query("SELECT enabled FROM trunks WHERE tenant_id = $1", [e.tenant_id])).rows[0];
  return {
    tenant: e.prefix,
    extension: e.number,
    // Dış arama: rolde yetki, politikada açık en az bir numara türü ve operatör hattı.
    outbound: has(ctx, "agent.outbound") && pol.enabled && !!trunk?.enabled ? dialPatterns(pol).map((d) => d.label) : null,
    crm: has(ctx, "crm.use"),
    displayName: e.display_name,
    paused: e.paused,
    pausedReason: e.paused_reason,
    queues,
    sip: {
      wsServer: ORIGINS.agent.replace(/^http/, "ws") + "/ws",
      uri: `sip:${e.prefix}_${e.number}_web@${SIP_HOST}`,
      domain: SIP_HOST,
      username: `${e.prefix}_${e.number}_web`,
      password: open(e.secret_enc, aad.extension(e.tenant_id, e.number), masterKey(e.key_id)),
    },
  };
});

// Aktarma rehberi: temsilcinin aramayı aktarabileceği kuyruklar ve dahililer (yalnızca kendi kiracısı).
route("GET", "/api/agent/directory", async (ctx) => {
  const e = await agentExtension(ctx);
  const queues = (await ctx.db.query("SELECT name, number FROM queues WHERE tenant_id = $1 ORDER BY name", [e.tenant_id])).rows;
  const extensions = (
    await ctx.db.query("SELECT number, display_name AS name FROM extensions WHERE tenant_id = $1 AND enabled AND id <> $2 ORDER BY number", [
      e.tenant_id,
      e.id,
    ])
  ).rows;
  return { queues, extensions };
});

// Müsait / molada. Durum veritabanına yazılır (yeniden yüklemede korunur) ve hemen Asterisk'e iletilir.
route("PUT", "/api/agent/pause", async (ctx) => {
  const e = await agentExtension(ctx);
  const paused = ctx.body?.paused;
  if (typeof paused !== "boolean") throw new UserError("paused true/false olmalı");
  const reason = optStr(ctx.body?.reason, "reason");
  if (reason && reason.length > 100) throw new UserError("açıklama en fazla 100 karakter");
  await ctx.db.query("UPDATE extensions SET paused = $1, paused_reason = $2 WHERE id = $3", [paused, paused ? reason : null, e.id]);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, $3, $4)", [
    actor(ctx),
    e.tenant_id,
    paused ? "agent.pause" : "agent.unpause",
    JSON.stringify({ number: e.number, reason }),
  ]);
  const ami = await Ami.open();
  try {
    // Kuyruk adı verilmezse üyesi olduğu bütün kuyruklarda uygulanır.
    const r = await ami.action({
      Action: "QueuePause",
      Interface: `Local/${e.number}@${e.prefix}-agent/n`,
      Paused: paused ? "true" : "false",
      Reason: reason ?? "",
    });
    // Hiçbir kuyruğun üyesi değilse Asterisk hata döner; durum yine de kaydedilmiştir.
    if (r.Response !== "Success" && !/not found/i.test(r.Message ?? "")) throw new Error(`QueuePause: ${r.Message ?? ""}`);
  } finally {
    await ami.close();
  }
  return { paused };
});

// --- Anons sesleri, kendi kaydını yükleme, santrali açıp kapatma ---

route("GET", "/api/voices", async (ctx) => {
  need(ctx.user);
  return listVoices().map(({ id, label }) => ({ id, label }));
});

// Sesin örneği (seçmeden önce dinlemek için); ilk istekte üretilir, sonra saklanır.
const SAMPLE_TEXT = "Merhaba, aradığınız için teşekkür ederiz. Bu, anonslarınız için seçebileceğiniz seslerden biridir.";
route("GET", "/api/voices/:id/sample", async (ctx) => {
  need(ctx.user);
  const voice = listVoices().find((v) => v.id === ctx.params[0]);
  if (!voice) throw new UserError("bulunamadı", 404);
  const file = join(VOICE_SAMPLES_DIR, `${voice.id.replace(":", "_")}.wav`);
  let data = await readFile(file).catch(() => null);
  if (!data) {
    const { audio, soxInput } = synthesize(voice, SAMPLE_TEXT);
    await mkdir(VOICE_SAMPLES_DIR, { recursive: true });
    const r = spawnSync("sox", [...soxInput, "-r", "8000", "-c", "1", "-b", "16", file, "norm", "-1"], { input: audio });
    if (r.status !== 0) throw new Error(`örnek üretilemedi: ${r.stderr.toString()}`);
    data = await readFile(file);
  }
  return new Raw("audio/wav", data);
});

route("PUT", "/api/tenants/:prefix/voice", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const voice = str(ctx.body?.voice, "voice");
  if (!listVoices().some((v) => v.id === voice)) throw new UserError("ses bulunamadı");
  await ctx.db.query("UPDATE tenants SET tts_voice = $1 WHERE id = $2", [voice, t.id]);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'voice.set', $3)", [actor(ctx), t.id, JSON.stringify({ voice })]);
  // Bütün anonslar (yüklenenler hariç) yeni sesle yeniden üretilir.
  applyChanges(ctx.db);
  return { ok: true };
});

route("GET", "/api/tenants/:prefix/prompts", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const uploads = (
    await ctx.db.query(
      `SELECT name, original_name AS "originalName", duration_s::float AS "durationS", uploaded_by AS "uploadedBy",
              to_char(uploaded_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "uploadedAt"
         FROM prompt_uploads WHERE tenant_id = $1`,
      [t.id],
    )
  ).rows;
  const byName = new Map(uploads.map((u) => [u.name, u]));
  return (await tenantPrompts(ctx.db, t.id)).map((p) => ({ ...p, upload: byName.get(p.name) ?? null }));
});

// Kendi kaydını yükleme: gövde ham ses dosyasıdır (mp3, wav, m4a, ogg, webm…). Dosya adı x-filename başlığında.
route(
  "POST",
  "/api/tenants/:prefix/prompts/:name/upload",
  async (ctx) => {
    const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
    const name = ctx.params[1];
    if (!(await tenantPrompts(ctx.db, t.id)).some((p) => p.name === name)) throw new UserError("anons bulunamadı", 404);
    if (!Buffer.isBuffer(ctx.body) || ctx.body.length < 100) throw new UserError("ses dosyası gerekli");
    const original = decodeURIComponent(String(ctx.req.headers["x-filename"] ?? "")).replace(/[\r\n]/g, "").slice(0, 200);
    const seconds = installUploadedPrompt(t.prefix, name, ctx.body);
    await ctx.db.query(
      `INSERT INTO prompt_uploads (tenant_id, name, original_name, duration_s, uploaded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, name) DO UPDATE SET original_name = $3, duration_s = $4, uploaded_by = $5, uploaded_at = now()`,
      [t.id, name, original, seconds, ctx.user!.email],
    );
    await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'prompt.upload', $3)", [
      actor(ctx),
      t.id,
      JSON.stringify({ name, original, seconds }),
    ]);
    return { ok: true, durationS: seconds };
  },
  true,
  true,
);

// Yüklenen kaydı kaldırır: anons yeniden metinden, seçili sesle üretilir.
route("DELETE", "/api/tenants/:prefix/prompts/:name/upload", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const r = await ctx.db.query("DELETE FROM prompt_uploads WHERE tenant_id = $1 AND name = $2", [t.id, ctx.params[1]]);
  if (!r.rowCount) throw new UserError("yüklenmiş kayıt yok", 404);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'prompt.upload_remove', $3)", [
    actor(ctx),
    t.id,
    JSON.stringify({ name: ctx.params[1] }),
  ]);
  applyChanges(ctx.db);
  return { ok: true };
});

// Santrali açıp kapatma. Kapalıyken gelen aramalar kapalı anonsunu duyup kapanır; iç ve dış aramalar sürer.
route("PUT", "/api/tenants/:prefix/pbx", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const b = ctx.body ?? {};
  if (typeof b.open !== "boolean") throw new UserError("open true/false olmalı");
  const text = optStr(b.closedText, "closedText");
  if (text !== null && (!text.trim() || text.length > 500)) throw new UserError("kapalı anonsu 1–500 karakter olmalı");
  await ctx.db.query("UPDATE tenants SET pbx_open = $1, pbx_closed_text = COALESCE($2, pbx_closed_text) WHERE id = $3", [b.open, text, t.id]);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, $3, $4)", [
    actor(ctx),
    t.id,
    b.open ? "pbx.open" : "pbx.close",
    JSON.stringify({ closedText: text }),
  ]);
  applyChanges(ctx.db);
  return { ok: true };
});

// --- Yapay zekâ karşılaması ---
// Kiracıda açmak yalnızca platform yöneticisinin yetkisindedir (ücret ve KVKK); akışları kiracı yönetir.

const AI_STATUS_FILE = "/var/lib/santralio/ai/status.json";

route("GET", "/api/tenants/:prefix/ai", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const row = (await ctx.db.query("SELECT ai_enabled FROM tenants WHERE id = $1", [t.id])).rows[0];
  const flows = (
    await ctx.db.query(
      `SELECT name, enabled, greeting_text AS "greetingText", instructions, routes, default_target AS "defaultTarget",
              max_turns AS "maxTurns", voice, model FROM ai_flows WHERE tenant_id = $1 ORDER BY name`,
      [t.id],
    )
  ).rows;
  const usage = (
    await ctx.db.query(
      `SELECT count(*)::int AS sessions, COALESCE(sum(stt_seconds), 0)::float AS "sttSeconds", COALESCE(sum(tts_chars), 0)::int AS "ttsChars",
              COALESCE(sum(llm_input_tokens), 0)::int AS "inputTokens", COALESCE(sum(llm_output_tokens), 0)::int AS "outputTokens",
              count(*) FILTER (WHERE end_reason = 'transfer')::int AS transferred, count(*) FILTER (WHERE end_reason = 'error')::int AS errors
         FROM ai_sessions WHERE tenant_id = $1 AND started_at > now() - interval '30 days'`,
      [t.id],
    )
  ).rows[0];
  // Servisin anahtar durumu (anahtarların kendisi değil): santralio-ai açılışta yazar.
  const status = await readFile(AI_STATUS_FILE, "utf8").then((x) => JSON.parse(x), () => null);
  return { enabled: row.ai_enabled, editable: ctx.user!.role === "platform_admin", flows, usage, service: status, voices: aiVoices(), models: AI_MODELS };
});

route("PUT", "/api/tenants/:prefix/ai/enabled", async (ctx) => {
  platformOnly(ctx);
  const t = await tenantFor(ctx, ctx.params[0]);
  if (typeof ctx.body?.enabled !== "boolean") throw new UserError("enabled true/false olmalı");
  await ctx.db.query("UPDATE tenants SET ai_enabled = $1 WHERE id = $2", [ctx.body.enabled, t.id]);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, $3, '{}')", [
    actor(ctx),
    t.id,
    ctx.body.enabled ? "ai.enable" : "ai.disable",
  ]);
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/ai/flows/:name", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const b = ctx.body ?? {};
  await saveFlow(
    ctx.db,
    t,
    ctx.params[1],
    {
      enabled: b.enabled,
      greetingText: str(b.greetingText, "greetingText"),
      instructions: optStr(b.instructions, "instructions") ?? "",
      routes: b.routes,
      defaultTarget: optStr(b.defaultTarget, "defaultTarget"),
      maxTurns: b.maxTurns,
      voice: str(b.voice, "voice"),
      model: str(b.model, "model"),
    },
    actor(ctx),
  );
  applyChanges(ctx.db);
  return { ok: true };
});

// Yapay zekâ görüşmeleri: döküm, özet, sonuç (kayıt dinleme gibi kişisel veri: bütün görüşmeleri görme yetkisi gerekir).
route("GET", "/api/tenants/:prefix/ai/sessions", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "calls.all");
  const q = query(ctx);
  const r = parseRange(q.get("from"), q.get("to"));
  return (
    await ctx.db.query(
      `SELECT id, flow, callid, caller, did, to_char(started_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') AS started,
              EXTRACT(EPOCH FROM (ended_at - started_at))::int AS "durationS", route_target AS target, summary, transcript,
              end_reason AS reason, error
         FROM ai_sessions WHERE tenant_id = $1
          AND started_at >= ($2::date::timestamp AT TIME ZONE 'Europe/Istanbul') AND started_at < (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')
        ORDER BY started_at DESC LIMIT 500`,
      [t.id, r.from, r.to],
    )
  ).rows;
});

// Temsilci ekranı: aktarılan görüşmenin yapay zekâ özeti (callid ile).
route("GET", "/api/tenants/:prefix/ai/summary", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "agent.desk", "crm.use", "calls.all");
  const callid = query(ctx).get("callid") ?? "";
  if (!/^\d{6,12}\.\d{1,8}$/.test(callid)) throw new UserError("bulunamadı", 404);
  const s = (
    await ctx.db.query(
      "SELECT summary, transcript, route_target AS target FROM ai_sessions WHERE tenant_id = $1 AND callid = $2 ORDER BY id DESC LIMIT 1",
      [t.id, callid],
    )
  ).rows[0];
  return s ?? null;
});

// --- Dış arama politikası ---
// Kiracının yöneticileri görür; yalnızca platform yöneticisi değiştirir (ücret ve kötüye kullanım riski).

function policyView(p: Policy) {
  return { policy: p, patterns: dialPatterns(p).map((d) => d.label) };
}

route("GET", "/api/tenants/:prefix/outbound-policy", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage", "staff.manage");
  return {
    ...policyView(await ops.getPolicy(ctx.db, t.id)),
    editable: ctx.user!.role === "platform_admin",
    templates: Object.entries(TEMPLATES).map(([id, x]) => ({ id, label: x.label, policy: { template: id, ...x.policy } })),
  };
});

route("PUT", "/api/tenants/:prefix/outbound-policy", async (ctx) => {
  platformOnly(ctx);
  const t = await tenantFor(ctx, ctx.params[0]);
  const b = ctx.body ?? {};
  await ops.setPolicy(
    ctx.db,
    t,
    {
      template: optStr(b.template, "template") ?? "custom",
      enabled: b.enabled,
      trMobile: b.trMobile,
      trLandline: b.trLandline,
      trNational: b.trNational,
      trTollfree: b.trTollfree,
      countries: b.countries,
      maxConcurrent: b.maxConcurrent,
      dailyLimit: b.dailyLimit,
      maxMinutes: b.maxMinutes,
    },
    actor(ctx),
  );
  applyChanges(ctx.db);
  return policyView(await ops.getPolicy(ctx.db, t.id));
});

// --- Personel ---

route("GET", "/api/tenants/:prefix/users", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  return (
    await ctx.db.query(
      `SELECT u.email, u.name, u.role_id AS "roleId", r.name AS "roleName", e.number AS extension, u.disabled, u.created_at,
              (SELECT max(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u LEFT JOIN extensions e ON e.id = u.extension_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 ORDER BY r.id, u.email`,
      [t.id],
    )
  ).rows;
});

route("POST", "/api/tenants/:prefix/users", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  const b = ctx.body ?? {};
  const r = await ops.createStaff(
    ctx.db,
    t,
    { email: str(b.email, "email"), name: optStr(b.name, "name") ?? "", roleId: Number(b.roleId), extension: optStr(b.extension, "extension") },
    actor(ctx),
  );
  applyChanges(ctx.db);
  // Geçici şifre yalnızca bu yanıtta bir kez gösterilir.
  return { email: String(b.email).trim().toLowerCase(), temporaryPassword: r.password };
});

// Personeli günceller: rol, dahili (null: dahilisiz), kapalı/açık. Verilmeyen alan değişmez.
route("PUT", "/api/tenants/:prefix/users/:email", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  const b = ctx.body ?? {};
  const self = ctx.params[1].toLowerCase() === ctx.user!.email;
  if (b.roleId !== undefined) {
    if (self) throw new UserError("kendi rolünüzü değiştiremezsiniz");
    await ops.setStaffRole(ctx.db, t, ctx.params[1], Number(b.roleId), actor(ctx));
  }
  if (b.extension !== undefined) await ops.setStaffExtension(ctx.db, t, ctx.params[1], optStr(b.extension, "extension") || null, actor(ctx));
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== "boolean") throw new UserError("disabled true/false olmalı");
    if (self) throw new UserError("kendi hesabınızı kapatamazsınız");
    await ops.setStaffDisabled(ctx.db, t, ctx.params[1], b.disabled, actor(ctx));
  }
  applyChanges(ctx.db);
  return { ok: true };
});

route("POST", "/api/tenants/:prefix/users/:email/reset-password", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "staff.manage");
  return { temporaryPassword: await ops.resetStaffPassword(ctx.db, t, ctx.params[1], actor(ctx)) };
});

route("PUT", "/api/tenants/:prefix/queues/:name/members", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage", "staff.manage");
  const m = ctx.body?.members;
  if (!Array.isArray(m) || m.some((x) => typeof x !== "string")) throw new UserError("members dahili numaraları listesi olmalı");
  await ops.setQueueMembers(ctx.db, t, ctx.params[1], m, actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/queues/:name/number", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  await ops.setQueueNumber(ctx.db, t, ctx.params[1], optStr(ctx.body?.number, "number") || null, actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

// --- İşlem günlüğü ve sistem durumu ---

const AUDIT_SQL = `SELECT a.id, to_char(a.at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') AS at, a.actor, a.action,
                          t.prefix AS tenant, a.details
                     FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id`;

function auditFilter(ctx: Ctx, where: string[], params: unknown[]) {
  const q = query(ctx);
  const r = parseRange(q.get("from"), q.get("to"));
  params.push(r.from, r.to);
  where.push(`a.at >= ($${params.length - 1}::date::timestamp AT TIME ZONE 'Europe/Istanbul')`);
  where.push(`a.at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')`);
  const action = q.get("action");
  if (action) {
    params.push(`${action.replace(/[\\%_]/g, "")}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  return Math.min(Math.max(Number(q.get("limit") ?? 500), 1), 2000);
}

route("GET", "/api/tenants/:prefix/audit", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "audit.view");
  const where = ["a.tenant_id = $1"];
  const params: unknown[] = [t.id];
  const limit = auditFilter(ctx, where, params);
  return (await ctx.db.query(`${AUDIT_SQL} WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ${limit}`, params)).rows;
});

// Platform yöneticisi: bütün işlem günlüğü (kiracısız kayıtlar dahil) ve sistem durumu.
function platformOnly(ctx: Ctx) {
  if (need(ctx.user).role !== "platform_admin") throw new UserError("bulunamadı", 404);
}

route("GET", "/api/audit", async (ctx) => {
  platformOnly(ctx);
  const where: string[] = [];
  const params: unknown[] = [];
  const limit = auditFilter(ctx, where, params);
  return (await ctx.db.query(`${AUDIT_SQL} WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ${limit}`, params)).rows;
});

route("GET", "/api/system", async (ctx) => {
  platformOnly(ctx);
  const ami = await Ami.open();
  let asterisk: Record<string, unknown>;
  try {
    const uptime = await ami.command("core show uptime seconds");
    const channels = await ami.command("core show channels count");
    const regs = await ami.command("pjsip show registrations");
    asterisk = {
      uptimeS: Number(/System uptime: (\d+)/.exec(uptime.join(" "))?.[1] ?? 0),
      activeCalls: Number(/(\d+) active call/.exec(channels.join(" "))?.[1] ?? 0),
      registrations: regs
        .filter((l) => /_trunk_reg\//.test(l))
        .map((l) => ({ name: l.trim().split(/\s+/)[0].split("/")[0], status: /(Registered|Unregistered|Rejected|Stopped|Retrying)/.exec(l)?.[1] ?? "?" })),
    };
  } finally {
    await ami.close();
  }
  const { statfs } = await import("node:fs/promises");
  const fs = await statfs("/var/lib/santralio");
  const log = (await readFile("/var/log/asterisk/messages.log", "utf8").catch(() => "")).split("\n");
  const problems = log.filter((l) => /\] (ERROR|WARNING)\[/.test(l)).slice(-50).reverse();
  return {
    asterisk,
    disk: { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize },
    tenants: Number((await ctx.db.query("SELECT count(*) FROM tenants")).rows[0].count),
    users: Number((await ctx.db.query("SELECT count(*) FROM users WHERE NOT disabled")).rows[0].count),
    recentProblems: problems,
  };
});

// --- Kayıt ve raporlar ---

route("PUT", "/api/tenants/:prefix/recording", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const b = ctx.body ?? {};
  await ops.setRecording(
    ctx.db,
    t,
    { enabled: b.enabled, retentionDays: optInt(b.retentionDays, "retentionDays"), noticeText: optStr(b.noticeText, "noticeText") ?? undefined },
    actor(ctx),
  );
  applyChanges(ctx.db);
  return { ok: true };
});

const query = (ctx: Ctx) => new URL(ctx.req.url ?? "/", "http://localhost").searchParams;

route("GET", "/api/tenants/:prefix/reports/summary", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "reports.view");
  const q = query(ctx);
  return summary(ctx.db, t.prefix, parseRange(q.get("from"), q.get("to")));
});

route("GET", "/api/tenants/:prefix/calls", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "calls.all", "calls.own");
  const q = query(ctx);
  return visibleCalls(ctx, t, await listCalls(ctx.db, t.prefix, parseRange(q.get("from"), q.get("to")), Number(q.get("limit") ?? 500)));
});

// Kullanıcının görebileceği görüşmeler: "kendi görüşmeleri" yetkisi olan yalnızca kendi dahilisinin görüşmelerini görür;
// kayıt dinleme yetkisi yoksa kayıt bağlantısı gösterilmez. Görüşme notları ve sonuç kodları eklenir.
async function visibleCalls(ctx: Ctx, t: Tenant, all: CallRow[]) {
  let rows = all;
  if (!has(ctx, "calls.all")) {
    const mine = await myExtension(ctx);
    rows = has(ctx, "calls.own") && mine !== null ? rows.filter((r) => r.agent === mine) : [];
  }
  if (!has(ctx, "recordings.listen")) for (const r of rows) r.recording = null;
  // Saklama süresi dolup silinmiş kayıtlar listede "yok" görünür.
  for (const r of rows) {
    if (r.recording && !(await access(join(recordingDir(t.prefix), r.recording)).then(() => true, () => false))) r.recording = null;
  }
  const ids = rows.map((r) => r.callid);
  const notes = ids.length
    ? (
        await ctx.db.query(
          `SELECT i.external_id, string_agg(NULLIF(i.note, ''), ' · ' ORDER BY i.id) AS note, string_agg(d.name, ', ' ORDER BY i.id) AS disposition
             FROM interactions i LEFT JOIN dispositions d ON d.id = i.disposition_id
            WHERE i.tenant_id = $1 AND i.external_id = ANY ($2) GROUP BY i.external_id`,
          [t.id, ids],
        )
      ).rows
    : [];
  const byId = new Map(notes.map((n) => [n.external_id, n]));
  return rows.map((r) => ({ ...r, note: byId.get(r.callid)?.note ?? null, disposition: byId.get(r.callid)?.disposition ?? null }));
}

// --- CRM ---

route("GET", "/api/tenants/:prefix/contacts", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  return crm.searchContacts(ctx.db, t, query(ctx).get("q") ?? "");
});

function contactBody(b: any): crm.ContactInput {
  return { name: str(b?.name, "name"), company: optStr(b?.company, "company") ?? "", email: optStr(b?.email, "email") ?? "", phones: b?.phones ?? [], tags: b?.tags ?? [] };
}

route("POST", "/api/tenants/:prefix/contacts", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  return { id: await crm.saveContact(ctx.db, t, null, contactBody(ctx.body), actor(ctx)) };
});

route("PUT", "/api/tenants/:prefix/contacts/:id", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  await crm.saveContact(ctx.db, t, Number(ctx.params[1]), contactBody(ctx.body), actor(ctx));
  return { ok: true };
});

// Kart sayfası: bilgiler, notlar ve arama geçmişi (son bir yıl; görüşme görme yetkisine göre).
route("GET", "/api/tenants/:prefix/contacts/:id", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  const c = await crm.getContact(ctx.db, t, Number(ctx.params[1]));
  const today = new Date();
  const from = new Date(today.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const calls = (await listCalls(ctx.db, t.prefix, parseRange(from, today.toISOString().slice(0, 10)), 2000)).filter((r) => c.phones.includes(r.caller));
  return { ...c, notes: await crm.interactionsOf(ctx.db, t, { contactId: c.id }), calls: await visibleCalls(ctx, t, calls) };
});

// Temsilci ekranı: gelen/giden aramada numaradan kart ve son notlar.
route("GET", "/api/tenants/:prefix/lookup", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  const r = await crm.lookupByPhone(ctx.db, t, query(ctx).get("phone") ?? "");
  const notes = r.contact
    ? await crm.interactionsOf(ctx.db, t, { contactId: r.contact.id }, 5)
    : r.phone
      ? await crm.interactionsOf(ctx.db, t, { phone: r.phone }, 5)
      : [];
  return { ...r, notes };
});

route("POST", "/api/tenants/:prefix/notes", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  const b = ctx.body ?? {};
  const id = await crm.saveNote(ctx.db, t, ctx.user!, {
    callid: optStr(b.callid, "callid"),
    phone: optStr(b.phone, "phone"),
    contactId: b.contactId == null ? null : Number(b.contactId),
    direction: b.direction === "in" || b.direction === "out" ? b.direction : null,
    dispositionId: b.dispositionId == null ? null : Number(b.dispositionId),
    note: optStr(b.note, "note") ?? "",
    followUpAt: optStr(b.followUpAt, "followUpAt"),
  });
  return { id };
});

// Geri aranacaklar: tarihi verilmiş notlar. "Bütün görüşmeler" yetkisi olan herkesinkini, diğerleri kendininkini görür.
route("GET", "/api/tenants/:prefix/follow-ups", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use");
  const all = has(ctx, "calls.all");
  return (
    await ctx.db.query(
      `SELECT i.id, i.phone, i.note, i.user_email AS "user", d.name AS disposition, c.id AS "contactId", c.name AS "contactName",
              to_char(i.follow_up_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "followUpAt", i.follow_up_at < now() AS due
         FROM interactions i LEFT JOIN dispositions d ON d.id = i.disposition_id LEFT JOIN contacts c ON c.id = i.contact_id
        WHERE i.tenant_id = $1 AND i.follow_up_at IS NOT NULL AND i.follow_up_at > now() - interval '7 days'
          ${all ? "" : "AND i.user_email = $2"}
        ORDER BY i.follow_up_at LIMIT 200`,
      all ? [t.id] : [t.id, ctx.user!.email],
    )
  ).rows;
});

route("GET", "/api/tenants/:prefix/dispositions", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "crm.use", "settings.manage");
  return crm.listDispositions(ctx.db, t, query(ctx).get("all") === "1" && has(ctx, "settings.manage"));
});

route("POST", "/api/tenants/:prefix/dispositions", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  return { id: await crm.saveDisposition(ctx.db, t, null, str(ctx.body?.name, "name"), true, actor(ctx)) };
});

route("PUT", "/api/tenants/:prefix/dispositions/:id", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  await crm.saveDisposition(ctx.db, t, Number(ctx.params[1]), str(ctx.body?.name, "name"), ctx.body?.enabled !== false, actor(ctx));
  return { ok: true };
});

// Kaydı dinlemek. Her dinleme denetim kaydına yazılır (KVKK: kişisel veriye erişim izi).
route("GET", "/api/tenants/:prefix/recordings/:callid", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "recordings.listen");
  const callid = ctx.params[1];
  if (!/^\d{6,12}\.\d{1,8}$/.test(callid)) throw new UserError("bulunamadı", 404);
  const ok = (
    await ctx.db.query("SELECT 1 FROM queue_log WHERE callid = $1 AND event = 'SANTRALIO_RECORDING' AND queuename LIKE $2 LIMIT 1", [
      callid,
      `${t.prefix}\\_%`,
    ])
  ).rowCount;
  if (!ok) throw new UserError("bulunamadı", 404);
  // Görüşme görme kapsamı kayıt için de geçerli: "kendi görüşmeleri" yetkisi olan yalnızca kendi cevapladığını dinler.
  if (!has(ctx, "calls.all")) {
    const mine = await myExtension(ctx);
    const own = mine
      ? (await ctx.db.query("SELECT 1 FROM queue_log WHERE callid = $1 AND agent = $2 AND event IN ('CONNECT', 'SANTRALIO_EXT_DONE') LIMIT 1", [callid, mine]))
          .rowCount
      : 0;
    if (!has(ctx, "calls.own") || !own) throw new UserError("bulunamadı", 404);
  }
  const data = await readFile(join(recordingDir(t.prefix), `${callid}.wav`)).catch(() => null);
  if (!data) throw new UserError("kayıt yok (saklama süresi dolmuş olabilir)", 404);
  await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'recording.listen', $3)", [
    actor(ctx),
    t.id,
    JSON.stringify({ callid, ip: ctx.ip }),
  ]);
  return new Raw("audio/wav", data);
});

// Anonsun üretilmiş sesi (8 kHz WAV), panelde dinlemek için.
route("GET", "/api/tenants/:prefix/prompts/:name", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const name = ctx.params[1];
  if (!/^((menu|queue|schedule)-[a-z0-9_]{1,32}(-invalid|-unavailable|-closed)?|recording-notice|ext-unavailable|pbx-closed)$/.test(name)) {
    throw new UserError("bulunamadı", 404);
  }
  const data = await readFile(join(SOUNDS_DIR, t.prefix, `${name}.wav`)).catch(() => null);
  if (!data) throw new UserError("bulunamadı", 404);
  return new Raw("audio/wav", data);
});

// Canlı durum: operatör kaydı ve hangi dahililerin bağlı olduğu (Asterisk'ten).
route("GET", "/api/tenants/:prefix/status", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const ami = await Ami.open();
  try {
    const regs = await ami.command("pjsip show registrations");
    const contacts = await ami.command("pjsip show contacts");
    const reg = regs.find((l) => l.includes(`${t.prefix}_trunk_reg/`));
    const registration = reg ? (/(Registered|Unregistered|Rejected|Stopped|Retrying)/.exec(reg)?.[1] ?? "unknown") : "none";
    const online = new Set<string>();
    for (const l of contacts) {
      const m = new RegExp(`Contact:\\s+${t.prefix}_(\\d{2,6})/\\S+\\s+\\S+\\s+(Avail|NonQual)`).exec(l);
      if (m) online.add(m[1]);
    }
    return { registration, onlineExtensions: [...online].sort() };
  } finally {
    await ami.close();
  }
});

route("POST", "/api/tenants/:prefix/extensions", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const number = str(ctx.body?.number, "number");
  const secret = await ops.addExtension(ctx.db, t, number, optStr(ctx.body?.name, "name") ?? "", actor(ctx));
  applyChanges(ctx.db);
  // SIP şifresi yalnızca bu yanıtta bir kez gösterilir.
  return { number, sip: { server: SIP_HOST, port: 5061, transport: "tls", username: `${t.prefix}_${number}`, password: secret } };
});

route("PUT", "/api/tenants/:prefix/menus/:name", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const name = ctx.params[1];
  const b = ctx.body ?? {};
  await ops.setMenu(
    ctx.db,
    t,
    name,
    {
      text: str(b.text, "text"),
      invalidText: optStr(b.invalidText, "invalidText"),
      defaultTarget: optStr(b.defaultTarget, "defaultTarget"),
      timeoutS: optInt(b.timeoutS, "timeoutS"),
      maxTries: optInt(b.maxTries, "maxTries"),
    },
    actor(ctx),
  );
  if (b.options != null) {
    if (typeof b.options !== "object" || Array.isArray(b.options)) throw new UserError("options { tuş: hedef } olmalı");
    for (const v of Object.values(b.options)) str(v, "options değeri");
    await ops.replaceMenuOptions(ctx.db, t, name, b.options, actor(ctx));
  }
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/schedules/:name", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  const name = ctx.params[1];
  const b = ctx.body ?? {};
  await ops.setSchedule(
    ctx.db,
    t,
    name,
    {
      openTarget: str(b.openTarget, "openTarget"),
      closedText: str(b.closedText, "closedText"),
      closedTarget: optStr(b.closedTarget, "closedTarget"),
      timezone: optStr(b.timezone, "timezone") ?? undefined,
    },
    actor(ctx),
  );
  if (b.hours != null) {
    if (!Array.isArray(b.hours)) throw new UserError("hours bir liste olmalı");
    const hours = b.hours.map((h: any) => ({ weekdays: str(h?.weekdays, "weekdays"), opens: str(h?.opens, "opens"), closes: str(h?.closes, "closes") }));
    await ops.replaceScheduleHours(ctx.db, t, name, hours, actor(ctx));
  }
  applyChanges(ctx.db);
  return { ok: true };
});

route("POST", "/api/tenants/:prefix/schedules/:name/holidays", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  await ops.addScheduleHoliday(ctx.db, t, ctx.params[1], str(ctx.body?.day, "day"), optStr(ctx.body?.note, "note"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/queues/:name/unavailable-text", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  await ops.setQueueUnavailableText(ctx.db, t, ctx.params[1], str(ctx.body?.text, "text"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/entry-points/:address", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "settings.manage");
  await ops.setEntryFlow(ctx.db, t, ctx.params[1], str(ctx.body?.flow, "flow"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

// --- Sunucu ---

function send(res: ServerResponse, status: number, body: unknown) {
  if (body instanceof Raw) {
    res.writeHead(status, { "content-type": body.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return res.end(body.data);
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage, raw: boolean): Promise<any> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > (raw ? MAX_RAW_BODY : MAX_BODY)) throw new UserError(raw ? "dosya en fazla 12 MB olabilir" : "istek çok büyük", 413);
    chunks.push(c as Buffer);
  }
  if (raw) return Buffer.concat(chunks);
  if (!size) return null;
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new UserError("içerik application/json olmalı", 415);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UserError("geçersiz JSON");
  }
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name && v.length) return v.join("=");
  }
  return null;
}

// Ters vekil arkasında gerçek istemci adresi X-Forwarded-For'un son değeridir; vekil yalnızca localhost'tan gelir.
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "";
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (remote === "127.0.0.1" || remote === "::1") && fwd.length ? fwd[fwd.length - 1] : remote;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
  if (!r) return send(res, 404, { error: "bulunamadı" });

  const db = await pool.connect();
  try {
    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const cookie = cookieValue(req, COOKIE);
    const token = bearer ?? cookie;
    // CSRF: çerezle gelen değişiklik istekleri (ve web girişi) yalnızca panelin kaynağından kabul edilir.
    const fromWeb = !bearer && (cookie !== null || req.headers["x-santralio-client"] === "web");
    if (fromWeb && req.method !== "GET" && !ALLOWED_ORIGINS.has(String(req.headers.origin ?? ""))) return send(res, 403, { error: "geçersiz kaynak" });
    const user = token ? await userBySession(db, token) : null;
    if (r.auth && !user) return send(res, 401, { error: "oturum gerekli" });
    const params = (r.pattern.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);
    const body = await readBody(req, r.raw);
    const ctx = { req, res, db, user, token, params, body, ip: clientIp(req) };
    const result = req.method === "GET" ? await r.handler(ctx) : await tx(db, () => r.handler(ctx));
    if (pendingApply.has(db)) {
      pendingApply.delete(db);
      await runApply(db);
    }
    send(res, 200, result);
  } catch (err) {
    pendingApply.delete(db);
    if (err instanceof UserError) return send(res, err.status, { error: err.message });
    console.error(new Date().toISOString(), req.method, url.pathname, err);
    send(res, 500, { error: "sunucu hatası" });
  } finally {
    db.release();
  }
});

server.listen(PORT, HOST, () => console.log(`Santralio API http://${HOST}:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
