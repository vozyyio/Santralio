// Santralio yönetim API'si. Web paneli ve mobil uygulama bu API'yi kullanır.
// Yalnızca localhost'u dinler; dışarıya HTTPS ters vekil (reverse proxy) üzerinden açılır.
// Kimlik: "Authorization: Bearer <belirteç>" (POST /api/login ile alınır).
// Kullanıcının erişemediği kiracı için 404 döner: başka kiracıların varlığı dışarıdan anlaşılmaz.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";
import { reloadTenants } from "./ami.ts";
import { renderAll } from "./apply.ts";
import { burnTime, canAccessTenant, createSession, revokeSession, tenantScope, userBySession, verifyPassword, type User } from "./auth.ts";
import { PG_DATABASE, PG_HOST } from "./config.ts";
import { tx, type Db } from "./db.ts";
import * as ops from "./ops.ts";
import { UserError, type Tenant } from "./ops.ts";

const PORT = Number(process.env.SANTRALIO_API_PORT ?? 8090);
const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024;

const pool = new pg.Pool({ host: PG_HOST, database: PG_DATABASE, max: 5 });

type Ctx = { req: IncomingMessage; db: Db; user: User | null; token: string | null; params: string[]; body: any; ip: string };
type Handler = (ctx: Ctx) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; auth: boolean; handler: Handler };

// Değişiklik yapan istekler tek bir veritabanı işleminde çalışır: bir adım reddedilirse hiçbiri kalmaz.
// Asterisk'e uygulama, işlem tamamlandıktan sonra yapılır.
const pendingApply = new WeakSet<Db>();

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler, auth = true) => {
  const pattern = new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "$");
  routes.push({ method, pattern, auth, handler });
};

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

// Kiracıya erişimin tek kapısı.
async function tenantFor(ctx: Ctx, prefix: string, level: "read" | "admin"): Promise<Tenant> {
  const user = need(ctx.user);
  const t = await ops.tenantByPrefix(ctx.db, prefix).catch(() => null);
  if (!t || !canAccessTenant(user, t, level)) throw new UserError("bulunamadı", 404);
  if (level === "admin" && user.role === "agent") throw new UserError("bulunamadı", 404);
  return t;
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
    await ctx.db.query("INSERT INTO audit_log (actor, tenant_id, action, details) VALUES ($1, $2, 'user.login', $3)", [
      `api:${u.email}`,
      u.tenant_id,
      JSON.stringify({ ip: ctx.ip }),
    ]);
    return { token, user: { email: u.email, name: u.name, role: u.role } };
  },
  false,
);

route("POST", "/api/logout", async (ctx) => {
  await revokeSession(ctx.db, ctx.token!);
  return { ok: true };
});

route("GET", "/api/me", async (ctx) => {
  const u = need(ctx.user);
  const tenant = u.tenant_id ? (await ctx.db.query("SELECT prefix, name FROM tenants WHERE id = $1", [u.tenant_id])).rows[0] : null;
  const ext = u.extension_id ? (await ctx.db.query("SELECT number FROM extensions WHERE id = $1", [u.extension_id])).rows[0] : null;
  return { email: u.email, name: u.name, role: u.role, tenant, extension: ext?.number ?? null };
});

route("GET", "/api/tenants", async (ctx) => {
  const u = need(ctx.user);
  if (u.role === "agent") return [];
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
  const t = await tenantFor(ctx, ctx.params[0], "admin");
  const q = (sql: string) => ctx.db.query(sql, [t.id]).then((r) => r.rows);
  // Gizli alanlar (trunk ve dahili şifreleri) hiçbir zaman döndürülmez.
  const [license] = await q("SELECT source, active, valid_until, max_extensions, max_channels, modules FROM licenses WHERE tenant_id = $1");
  const [trunk] = await q("SELECT operator, server, port, transport, username, enabled FROM trunks WHERE tenant_id = $1");
  return {
    prefix: t.prefix,
    name: t.name,
    status: t.status,
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

route("POST", "/api/tenants/:prefix/extensions", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "admin");
  const number = str(ctx.body?.number, "number");
  const secret = await ops.addExtension(ctx.db, t, number, optStr(ctx.body?.name, "name") ?? "", actor(ctx));
  applyChanges(ctx.db);
  // SIP şifresi yalnızca bu yanıtta bir kez gösterilir.
  return { number, sip: { server: "sip.santralio.site", port: 5061, transport: "tls", username: `${t.prefix}_${number}`, password: secret } };
});

route("PUT", "/api/tenants/:prefix/menus/:name", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "admin");
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
  const t = await tenantFor(ctx, ctx.params[0], "admin");
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
  const t = await tenantFor(ctx, ctx.params[0], "admin");
  await ops.addScheduleHoliday(ctx.db, t, ctx.params[1], str(ctx.body?.day, "day"), optStr(ctx.body?.note, "note"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/queues/:name/unavailable-text", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "admin");
  await ops.setQueueUnavailableText(ctx.db, t, ctx.params[1], str(ctx.body?.text, "text"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

route("PUT", "/api/tenants/:prefix/entry-points/:address", async (ctx) => {
  const t = await tenantFor(ctx, ctx.params[0], "admin");
  await ops.setEntryFlow(ctx.db, t, ctx.params[1], str(ctx.body?.flow, "flow"), actor(ctx));
  applyChanges(ctx.db);
  return { ok: true };
});

// --- Sunucu ---

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new UserError("istek çok büyük", 413);
    chunks.push(c as Buffer);
  }
  if (!size) return null;
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new UserError("içerik application/json olmalı", 415);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UserError("geçersiz JSON");
  }
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
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const user = token ? await userBySession(db, token) : null;
    if (r.auth && !user) return send(res, 401, { error: "oturum gerekli" });
    const params = (r.pattern.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);
    const body = await readBody(req);
    const ctx = { req, db, user, token, params, body, ip: clientIp(req) };
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
