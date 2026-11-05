// Santralio: Vozyy lisans entegrasyonu testleri.
// İmza ve doğrulama birim testleri her zaman çalışır. Uçtan uca testler ayrı bir test veritabanı ister
// API o veritabanıyla ayrı bir portta başlatılır; canlı veritabanına dokunulmaz. Çalıştırma:
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/vozyy.test.ts
// (config.ts veritabanı adını içe aktarılırken okur; bu yüzden ikisi de komut satırında verilir.)

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PG_DATABASE } from "../src/config.ts";
import { effectivePermissions } from "../src/permissions.ts";
import { parseRemoteLicense, reportInstallStatus, signature, validDomain, verifySignature, vozyyUrl } from "../src/vozyy.ts";

const SECRET = "test-signing-secret-" + randomBytes(8).toString("hex");

test("imza: doğru imza, bozuk imza, eski ve ileri zaman damgası", () => {
  const raw = Buffer.from('{"a":1}');
  const now = 1_793_800_000;
  const ts = String(now);
  const sig = signature(SECRET, ts, raw);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifySignature(SECRET, ts, sig, raw, now), null);
  assert.equal(verifySignature(SECRET, ts, sig, Buffer.from('{"a":2}'), now), "imza geçersiz", "gövde değişirse");
  assert.equal(verifySignature(SECRET, ts, sig.slice(0, -1) + "0", raw, now) ?? "", "imza geçersiz");
  assert.equal(verifySignature("baska", ts, sig, raw, now), "imza geçersiz");
  assert.ok(verifySignature(SECRET, ts, sig, raw, now + 360), "6 dakika eski");
  assert.ok(verifySignature(SECRET, ts, sig, raw, now - 360), "6 dakika ileri");
  assert.equal(verifySignature(SECRET, ts, sig, raw, now + 299), null, "5 dakika içinde");
  assert.ok(verifySignature(SECRET, undefined, sig, raw, now));
  assert.ok(verifySignature(SECRET, ts, undefined, raw, now));
});

test("alan adı: gerçek alan adı geçer; IP, localhost, tek etiket geçmez", () => {
  assert.ok(validDomain("santral.ornekotel.com"));
  assert.ok(validDomain("panel.otel.com.tr"));
  for (const d of ["localhost", "10.0.0.1", "192.168.1.1", "::1", "intranet", "x.local", "santral.localhost", "a_b.com"]) assert.ok(!validDomain(d), d);
});

test("modüller: lisansta olmayan modülün yetkisi düşer; manuel lisansta hepsi açık", () => {
  const all = ["agent.desk", "agent.outbound", "crm.use", "recordings.listen", "reports.view", "settings.manage"] as const;
  const santral = effectivePermissions([...all], ["pbx", "agent_desk", "recording", "reports"]);
  assert.deepEqual(santral, ["agent.desk", "recordings.listen", "reports.view", "settings.manage"]);
  assert.deepEqual(effectivePermissions([...all], ["pbx", "agent_desk", "recording", "reports", "ai", "crm", "outbound"]), [...all]);
  assert.deepEqual(effectivePermissions([...all], null), [...all]);
});

test("Vozyy adresi: yalnızca https ve gerçek alan adı (iç ağa/IP'ye istek yok)", () => {
  assert.equal(vozyyUrl("https://api.vozyy.com/license", "/licenses/lic_1"), "https://api.vozyy.com/license/api/santralio/licenses/lic_1");
  for (const b of ["http://api.vozyy.com", "https://127.0.0.1", "https://10.0.0.5/x", "https://localhost", "https://user:pw@api.vozyy.com", "https://api.vozyy.com:8443"]) {
    assert.throws(() => vozyyUrl(b, "/x"), b);
  }
});

test("uzak lisans: kimlik eşleşmeli, alanlar olay sözleşmesiyle doğrulanır", () => {
  const l = { id: "lic_a", plan: "santral", status: "active", valid_from: null, valid_until: "2027-01-01T00:00:00Z", limits: { max_extensions: 5, max_channels: 2 }, modules: ["pbx", "x"] };
  assert.equal(parseRemoteLicense({ ok: true, data: l }, "lic_a").max_extensions, 5);
  assert.deepEqual(parseRemoteLicense({ license: l }, "lic_a").modules, ["pbx"], "bilinmeyen modül yok sayılır");
  assert.throws(() => parseRemoteLicense({ license: l }, "lic_b"), /eşleşmiyor/);
  assert.throws(() => parseRemoteLicense({ license: { ...l, status: "x" } }, "lic_a"), /geçersiz/);
});

test("kurulum bildirimi: doğru gövde ve Bearer; geçersiz alan adı gönderilmez", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{"ok":true}', { status: 200 }))) as unknown as typeof fetch;
  const body = await reportInstallStatus("https://api.vozyy.com/license", "kurulum-anahtari", { licenseId: "lic_1", tenantPrefix: "t12", panelDomain: "Santral.OrnekOtel.com" }, fake);
  assert.deepEqual(body, { license_id: "lic_1", status: "provisioned", tenant_prefix: "t12", panel_url: "https://santral.ornekotel.com", panel_domain: "santral.ornekotel.com" });
  assert.equal(calls[0].url, "https://api.vozyy.com/license/api/santralio/install-status");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer kurulum-anahtari");
  await assert.rejects(reportInstallStatus("https://api.vozyy.com", "k", { licenseId: "lic_1", tenantPrefix: "t12", panelDomain: "192.168.1.10" }, fake));
  assert.equal(calls.length, 1);
});

// --- Uçtan uca (test veritabanı) ---

const TEST_DB = process.env.SANTRALIO_TEST_DB;
const PORT = 18091;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = randomBytes(3).toString("hex");
let api: ChildProcess | null = null;
let n = 0;

function licenseBody(event: string, licId: string, opts: Record<string, any> = {}) {
  return {
    event,
    event_id: opts.eventId ?? `evt_${RUN}_${++n}`,
    occurred_at: opts.occurredAt ?? new Date().toISOString(),
    license: {
      id: licId,
      product: "santralio",
      plan: opts.plan ?? "santral_ai",
      status: opts.status ?? "active",
      valid_from: "2026-11-04T00:00:00Z",
      valid_until: opts.validUntil ?? "2026-12-04T00:00:00Z",
      limits: { max_extensions: opts.maxExt ?? 10, max_channels: 4 },
      modules: opts.modules ?? ["pbx", "agent_desk", "recording", "reports", "ai", "crm", "outbound"],
    },
    install: opts.install ?? { mode: "hosted", panel_domain: null, requested_prefix: opts.slug ?? null },
    customer: {
      id: `cus_${RUN}`,
      company_name: "Örnek Otel",
      tax_office: "Kadıköy",
      tax_number: "1234567890",
      contact_name: "Ayşe Yılmaz",
      email: opts.email ?? `admin-${RUN}-${n}@example.com`,
      phone: "+905321234567",
      sector: "hotel",
      locale: "tr",
    },
  };
}

async function post(body: unknown, opts: { secret?: string; ts?: number; eventId?: string; raw?: string } = {}) {
  const raw = Buffer.from(opts.raw ?? JSON.stringify(body));
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const res = await fetch(`${BASE}/api/vozyy/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vozyy-event-id": opts.eventId ?? (body as any).event_id,
      "x-vozyy-timestamp": ts,
      "x-vozyy-signature": signature(opts.secret ?? SECRET, ts, raw),
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function q(sql: string, params: unknown[] = []) {
  const { connect } = await import("../src/db.ts");
  const db = await connect();
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.end();
  }
}

const json = (path: string, body: unknown, token?: string) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("Vozyy olayları (uçtan uca)", { skip: !TEST_DB && "SANTRALIO_TEST_DB tanımlı değil" }, () => {
  before(async () => {
    // Güvenlik: bu süreç test veritabanından başka bir veritabanına bağlanacaksa hiçbir şey yapılmaz.
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const creds = mkdtempSync(join(tmpdir(), "santralio-vozyy-test-"));
    writeFileSync(join(creds, "santralio-master-key-k1"), randomBytes(32).toString("base64"));
    writeFileSync(join(creds, "santralio-vozyy-signing-secret"), SECRET);
    // Testin kendisi de davet bağlantısını çözebilsin (platform paneliyle aynı yol).
    process.env.CREDENTIALS_DIRECTORY = creds;
    const env = {
      ...process.env,
      SANTRALIO_PG_DATABASE: TEST_DB!,
      SANTRALIO_API_PORT: String(PORT),
      CREDENTIALS_DIRECTORY: creds,
      SANTRALIO_TENANTS_DIR: mkdtempSync(join(tmpdir(), "santralio-tenants-")),
    };
    const { connect, migrate } = await import("../src/db.ts");
    const db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    await db.end();
    api = spawn(process.execPath, ["src/api.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      api!.stdout!.on("data", (d) => String(d).includes("Santralio API") && resolve());
      api!.on("exit", (c) => reject(new Error(`API çıktı: ${c}`)));
    });
  });
  after(() => void api?.kill());

  test("imza yok/bozuk/eski: 401; doğru: 200", async () => {
    const b = licenseBody("license.activated", `lic_${RUN}_sig`, { slug: `sig-${RUN}` });
    assert.equal((await post(b, { secret: "yanlis" })).status, 401);
    assert.equal((await post(b, { ts: Math.floor(Date.now() / 1000) - 360 })).status, 401);
    const noSig = await fetch(`${BASE}/api/vozyy/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal(noSig.status, 401);
    assert.equal((await post(b)).status, 200);
  });

  test("gövdedeki event_id başlıktakiyle aynı olmalı; bozuk JSON 400", async () => {
    const b = licenseBody("license.activated", `lic_${RUN}_mm`);
    assert.equal((await post(b, { eventId: "evt_baska" })).body.error, "event_id_mismatch");
    assert.equal((await post(null, { raw: "{bozuk", eventId: "evt_x" })).status, 400);
  });

  test("hosted etkinleştirme: kiracı + slug + davet + panel_url; vergi bilgisi saklanmaz", async () => {
    const slug = `otel-${RUN}`;
    const b = licenseBody("license.activated", `lic_${RUN}_h`, { slug });
    const r = await post(b);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "provisioned");
    assert.match(r.body.tenant_prefix, /^t[0-9]{1,6}$/);
    assert.equal(r.body.panel_url, "https://panel.santralio.site");
    assert.equal(r.body.admin_email, b.customer.email);
    assert.equal(r.body.invite_sent, false);
    const [t] = await q("SELECT t.slug, t.status, l.source, l.max_extensions, l.modules FROM tenants t JOIN licenses l ON l.tenant_id = t.id WHERE t.prefix = $1", [
      r.body.tenant_prefix,
    ]);
    assert.equal(t.slug, slug);
    assert.equal(t.source, "vozyy");
    assert.equal(t.max_extensions, 10);
    const dump = JSON.stringify(await q("SELECT * FROM vozyy_licenses WHERE license_id = $1", [b.license.id]));
    assert.ok(!dump.includes("1234567890") && !dump.includes("Kadıköy"), "vergi bilgisi yok");
    const events = JSON.stringify(await q("SELECT * FROM vozyy_events WHERE license_id = $1", [b.license.id]));
    assert.ok(!events.includes("1234567890"), "olay kaydında da yok");

    // Aynı event_id ikinci kez: 200, kiracı yeniden açılmaz.
    const again = await post(b);
    assert.equal(again.status, 200);
    assert.equal(again.body.tenant_prefix, r.body.tenant_prefix);
    assert.equal((await q("SELECT count(*)::int AS c FROM tenants WHERE slug = $1", [slug]))[0].c, 1);

    // Davet: bağlantı panelde; şifre belirlenince giriş yapılır, davet ikinci kez kullanılamaz.
    const [inv] = await q("SELECT count(*)::int AS c FROM user_invites i JOIN users u ON u.id = i.user_id WHERE u.email = $1 AND i.used_at IS NULL", [
      b.customer.email,
    ]);
    assert.equal(inv.c, 1);
    const login0 = await json("/api/login", { email: b.customer.email, password: "henuz-yok-123" });
    assert.equal(login0.status, 401, "davet kabul edilmeden giriş yok");
  });

  test("davet kabulü: şifre belirlenir, giriş yapılır, bağlantı tek kullanımlık; CRM'siz pakette crm.use yok", async () => {
    const b = licenseBody("license.activated", `lic_${RUN}_inv`, { slug: `davet-${RUN}`, plan: "santral", modules: ["pbx", "agent_desk", "recording", "reports"] });
    assert.equal((await post(b)).status, 200);
    // Bağlantı platform panelindeki listeden (şifreli saklanan token çözülür).
    const { connect } = await import("../src/db.ts");
    const { listLicenses } = await import("../src/vozyy.ts");
    const db = await connect();
    const lic = (await listLicenses(db).finally(() => db.end())).find((l) => l.licenseId === b.license.id)!;
    assert.ok(lic.invite && !lic.invite.sent);
    const token = /#\/davet\/([A-Za-z0-9_-]{32})$/.exec(lic.invite.link!)![1];
    assert.ok(lic.invite.link.startsWith("https://panel.santralio.site/#/davet/"));
    assert.equal((await json("/api/invite/check", { token })).body.email, b.customer.email);
    assert.equal((await json("/api/invite/accept", { token, password: "kisa" })).status, 400);
    assert.equal((await json("/api/invite/accept", { token, password: "Guclu-Sifre-2026" })).status, 200);
    assert.equal((await json("/api/invite/accept", { token, password: "Baska-Sifre-2026" })).status, 404, "tek kullanımlık");
    const login = await json("/api/login", { email: b.customer.email, password: "Guclu-Sifre-2026" });
    assert.equal(login.status, 200);
    const me = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${login.body.token}` } }).then((r) => r.json() as any);
    assert.ok(me.permissions.includes("settings.manage"));
    assert.ok(!me.permissions.includes("crm.use"), "santral paketinde CRM yok");
    INVITED = { email: b.customer.email, token: login.body.token, licId: b.license.id };
  });

  test("askıya alma: panel pasif (oturum kapanır, giriş 403), veri durur; iptal: kapanır, sonra etkinleştirme yok sayılır", async () => {
    const { email, token, licId } = INVITED!;
    const s = await post(licenseBody("license.suspended", licId, { status: "suspended" }));
    assert.equal(s.status, 200);
    assert.equal((await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401, "oturum geçersiz");
    assert.equal((await json("/api/login", { email, password: "Guclu-Sifre-2026" })).status, 403);
    const [t] = await q("SELECT t.status, l.active, (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users FROM tenants t JOIN licenses l ON l.tenant_id = t.id WHERE t.slug = $1", [`davet-${RUN}`]);
    assert.deepEqual(t, { status: "suspended", active: false, users: 1 });

    // Yeniden etkinleştirme: aynı kiracı, giriş tekrar açık.
    const re = await post(licenseBody("license.activated", licId, { slug: `davet-${RUN}`, plan: "santral", modules: ["pbx"], email }));
    assert.equal(re.body.status, "provisioned");
    assert.equal((await json("/api/login", { email, password: "Guclu-Sifre-2026" })).status, 200);

    assert.equal((await post(licenseBody("license.cancelled", licId, { status: "cancelled" }))).status, 200);
    assert.equal((await q("SELECT status FROM tenants WHERE slug = $1", [`davet-${RUN}`]))[0].status, "cancelled");
    const late = await post(licenseBody("license.activated", licId, { slug: `davet-${RUN}`, email }));
    assert.equal(late.body.status, "cancelled", "iptalden sonra etkinleştirme uygulanmaz");
    assert.equal((await q("SELECT status FROM tenants WHERE slug = $1", [`davet-${RUN}`]))[0].status, "cancelled");
  });

  test("sırasız olaylar: eski occurred_at uygulanmaz, 200 döner", async () => {
    const id = `lic_${RUN}_ord`;
    const t0 = Date.now();
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    assert.equal((await post(licenseBody("license.activated", id, { slug: `sira-${RUN}`, occurredAt: at(0) }))).status, 200);
    assert.equal((await post(licenseBody("license.updated", id, { occurredAt: at(20), maxExt: 25 }))).status, 200);
    const old = await post(licenseBody("license.updated", id, { occurredAt: at(10), maxExt: 5 }));
    assert.equal(old.status, 200);
    assert.equal(old.body.status, "ignored_stale");
    const [l] = await q("SELECT v.max_extensions AS v, l.max_extensions AS t FROM vozyy_licenses v JOIN licenses l ON l.tenant_id = v.tenant_id WHERE v.license_id = $1", [id]);
    assert.deepEqual(l, { v: 25, t: 25 });
  });

  test("güncelleme etkinleştirmeden önce gelirse 503 (Vozyy yeniden dener), olay kaydedilmez", async () => {
    const b = licenseBody("license.updated", `lic_${RUN}_early`);
    assert.equal((await post(b)).status, 503);
    assert.equal((await q("SELECT count(*)::int AS c FROM vozyy_events WHERE event_id = $1", [b.event_id]))[0].c, 0);
  });

  test("self_hosted: kiracı açılmaz, awaiting_install; panel_domain gerçek alan adı olmalı", async () => {
    const install = { mode: "self_hosted", panel_domain: "santral.ornekotel.com", requested_prefix: `kendi-${RUN}` };
    const b = licenseBody("license.activated", `lic_${RUN}_sh`, { install });
    const r = await post(b);
    assert.deepEqual(r.body, { ok: true, status: "awaiting_install" });
    const [l] = await q("SELECT tenant_id, install_status, panel_domain FROM vozyy_licenses WHERE license_id = $1", [b.license.id]);
    assert.deepEqual(l, { tenant_id: null, install_status: "awaiting_install", panel_domain: "santral.ornekotel.com" });
    assert.equal((await q("SELECT count(*)::int AS c FROM users WHERE email = $1", [b.customer.email]))[0].c, 0);
    for (const d of ["127.0.0.1", "localhost", null]) {
      const x = await post(licenseBody("license.activated", `lic_${RUN}_shbad`, { install: { ...install, panel_domain: d } }));
      assert.equal(x.body.error, "invalid_panel_domain", String(d));
    }
  });

  test("günlük doğrulama: fark varsa Vozyy esas; hatalı yanıt kaydedilir, uygulanmaz", async () => {
    const id = `lic_${RUN}_sync`;
    assert.equal((await post(licenseBody("license.activated", id, { slug: `sync-${RUN}` }))).status, 200);
    const remote = { id, plan: "kurumsal", status: "active", valid_from: null, valid_until: "2027-06-01T00:00:00Z", limits: { max_extensions: 40, max_channels: 8 }, modules: ["pbx", "agent_desk"] };
    let answer: unknown = { ok: true, data: remote };
    const fake = (async (url: string) => {
      const m = /licenses\/([^/?]+)$/.exec(url)!;
      return new Response(JSON.stringify(m[1] === id ? answer : { license: { ...remote, id: m[1] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { connect } = await import("../src/db.ts");
    const { syncLicenses } = await import("../src/vozyy.ts");
    const db = await connect();
    try {
      const r = await syncLicenses(db, "https://api.vozyy.com/license", "anahtar", fake);
      assert.ok(r.changed.includes(id));
      const [l] = await q("SELECT v.plan, v.max_extensions AS v, l.max_extensions AS t, l.modules, v.check_error FROM vozyy_licenses v JOIN licenses l ON l.tenant_id = v.tenant_id WHERE v.license_id = $1", [id]);
      assert.deepEqual(l, { plan: "kurumsal", v: 40, t: 40, modules: ["pbx", "agent_desk"], check_error: null });
      answer = { license: { ...remote, id: "lic_baska", max_extensions: 1 } };
      const r2 = await syncLicenses(db, "https://api.vozyy.com/license", "anahtar", fake);
      assert.ok(r2.errors.some((e) => e.startsWith(id)));
      const [l2] = await q("SELECT max_extensions, check_error FROM vozyy_licenses WHERE license_id = $1", [id]);
      assert.equal(l2.max_extensions, 40, "hatalı yanıt uygulanmaz");
      assert.match(l2.check_error, /eşleşmiyor/);
    } finally {
      await db.end();
    }
  });

  test("slug: geçersiz, ayrılmış ve çakışan değerler reddedilir (400, kiracı açılmaz)", async () => {
    const cases: [string, string][] = [
      ["ab", "invalid_slug"],
      ["Buyuk_Harf", "invalid_slug"],
      ["x".repeat(31), "invalid_slug"],
      ["panel", "reserved_slug"],
      ["www", "reserved_slug"],
      [`otel-${RUN}`, "slug_taken"],
    ];
    for (const [slug, code] of cases) {
      const b = licenseBody("license.activated", `lic_${RUN}_s${++n}`, { slug });
      const r = await post(b);
      assert.equal(r.status, 400, slug);
      assert.equal(r.body.error, code, slug);
      assert.equal((await q("SELECT count(*)::int AS c FROM vozyy_licenses WHERE license_id = $1", [b.license.id]))[0].c, 0);
    }
  });
});

let INVITED: { email: string; token: string; licId: string } | null = null;
