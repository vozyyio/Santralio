// Kaçan çağrıya otomatik geri arama testleri.
// Birim: numara kuralları, saat aralığı, yerel saat dönüşümü, karşılama, ayar doğrulama, dialplan.
// Uçtan uca (test veritabanı): queue_log'dan iş oluşturma, gecikme, arama, cevap, tekrar deneme, cevapsız,
// bekleme süresi, aranmak istemeyen, gizli/yurt dışı numara, başka görüşmede ulaşılma, saat dışı, eş zamanlı ve kanal sınırı.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/callbacks.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_GREETING_TR, greetingFor, inWindow, localToDate, normalizeCaller, validateSettings, type Dialer, type Settings } from "../src/callbacks.ts";
import { PG_DATABASE } from "../src/config.ts";
import { renderTenant, type TenantModel } from "../src/render.ts";

const BASE: Settings = {
  enabled: true,
  aiFlow: "karsilama",
  delayS: 20,
  maxAttempts: 2,
  retryMinutes: 10,
  cooldownHours: 6,
  maxAgeMinutes: 120,
  maxConcurrent: 1,
  windowStart: "00:00",
  windowEnd: "23:59",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  timezone: "Europe/Istanbul",
  international: false,
  greetingTr: "",
  greetingEn: "",
};

describe("Geri arama: birim", () => {
  it("numara kuralları", () => {
    assert.deepEqual(normalizeCaller("05321234567", false), { e164: "+905321234567", dial: "05321234567" });
    assert.deepEqual(normalizeCaller("+902425551122", false), { e164: "+902425551122", dial: "02425551122" });
    assert.deepEqual(normalizeCaller("905321234567", false), { e164: "+905321234567", dial: "05321234567" });
    assert.deepEqual(normalizeCaller("5321234567", false), { e164: "+905321234567", dial: "05321234567" });
    for (const v of ["", "anonymous", "0", null]) assert.ok("skip" in normalizeCaller(v, false), String(v));
    for (const v of ["08501234567", "09001234567", "4441234"]) assert.ok("skip" in normalizeCaller(v, true), v);
    assert.deepEqual(normalizeCaller("+447911123456", false), { skip: "yurt dışı numara (ayarlarda kapalı)", e164: "+447911123456" });
    assert.deepEqual(normalizeCaller("+447911123456", true), { e164: "+447911123456", dial: "00447911123456" });
  });

  it("saat aralığı (İstanbul) ve günler", () => {
    const s = { windowStart: "09:00", windowEnd: "21:00", weekdays: [1, 2, 3, 4, 5], timezone: "Europe/Istanbul" };
    assert.equal(inWindow(s, new Date("2026-11-12T07:00:00Z")), true); // Perşembe 10:00
    assert.equal(inWindow(s, new Date("2026-11-12T05:30:00Z")), false); // 08:30
    assert.equal(inWindow(s, new Date("2026-11-12T18:30:00Z")), false); // 21:30
    assert.equal(inWindow(s, new Date("2026-11-14T09:00:00Z")), false); // Cumartesi
  });

  it("yerel saat metni UTC'ye çevrilir", () => {
    assert.equal(localToDate("2026-11-12 10:00:00", "Europe/Istanbul").toISOString(), "2026-11-12T07:00:00.000Z");
    assert.equal(localToDate("2026-07-01 12:00:00", "Europe/Berlin").toISOString(), "2026-07-01T10:00:00.000Z");
  });

  it("karşılama yapay zekâ olduğunu söyler ve firma adını içerir", () => {
    const g = greetingFor({ greetingTr: "", greetingEn: "" }, "tr", "Deniz Otel");
    assert.equal(g, DEFAULT_GREETING_TR.replace("{firma}", "Deniz Otel"));
    assert.match(g, /yapay zekâ/);
    assert.match(greetingFor({ greetingTr: "", greetingEn: "" }, "de", "Deniz Otel"), /AI assistant of Deniz Otel/);
  });

  it("ayar doğrulama", () => {
    assert.throws(() => validateSettings({ windowStart: "21:00", windowEnd: "09:00" }, BASE), /saat/);
    assert.throws(() => validateSettings({ delayS: 1 }, BASE), /gecikme/);
    assert.throws(() => validateSettings({ weekdays: [8] }, BASE), /günler/);
    assert.deepEqual(validateSettings({ weekdays: [3, 1, 3] }, BASE).weekdays, [1, 3]);
  });

  it("dialplan: geri arama context'i ve yapay zekâya geri arama bilgisi", () => {
    const t = {
      id: 1,
      prefix: "t7",
      name: "Deniz",
      licensed: true,
      maxChannels: 4,
      trunk: { operator: "netgsm", server: "sip.netgsm.com.tr", port: 5060, transport: "udp", username: "8508401234", secret: "x", contactToken: "abcdefabcdefabcd", enabled: true },
      extensions: [],
      queues: [],
      menus: [],
      schedules: [],
      entryPoints: [],
      recording: { enabled: false },
      outbound: null,
      pbxOpen: true,
      ai: { enabled: true, flows: [{ name: "karsilama", enabled: true, routes: [], defaultTarget: null }] },
      callback: { flow: "karsilama" },
    } as unknown as TenantModel;
    const files = renderTenant(t) as unknown as Record<string, string>;
    const all = Object.values(files).join("\n");
    assert.match(all, /\[t7-callback\]/);
    assert.match(all, /Goto\(t7-ai-karsilama,s,1\)/);
    assert.match(all, /SANTRALIO_AI_KIND=callback:\$\{CBJOB\}/);
    assert.match(all, /FILTER\(a-z0-9:,\$\{SANTRALIO_AI_KIND\}\)/);
    const off = Object.values(renderTenant({ ...t, callback: null }) as unknown as Record<string, string>).join("\n");
    assert.doesNotMatch(off, /t7-callback/);
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;

describe("Geri arama: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB tanımlı değil" }, () => {
  let db: any;
  let cb: typeof import("../src/callbacks.ts");
  let tenant: { id: number; prefix: string };
  const dialed: { dial: string; jobId: number }[] = [];
  let channels = 0;
  const dialer: Dialer = {
    async originate(o) {
      dialed.push({ dial: o.dial, jobId: o.jobId });
    },
    async activeChannels() {
      return channels;
    },
  };
  const ago = (s: number) => new Date(Date.now() - s * 1000);
  let seq = 0;
  // queue_log zamanı UTC (timestamp without time zone).
  async function missed(caller: string, secondsAgo: number, ev = "ABANDON") {
    const callid = `cb-${randomBytes(4).toString("hex")}-${seq++}`;
    const at = ago(secondsAgo).toISOString().replace("T", " ").replace("Z", "");
    await db.query("INSERT INTO queue_log (time, callid, queuename, event, data1, data2) VALUES ($1, $2, $3, 'SANTRALIO_ENTER', '8508401234', $4)", [at, callid, `${tenant.prefix}_destek`, caller]);
    await db.query("INSERT INTO queue_log (time, callid, queuename, event, data1, data2, data3) VALUES ($1, $2, $3, $4, '1', '1', '40')", [at, callid, `${tenant.prefix}_destek`, ev]);
    return callid;
  }
  async function answeredCall(caller: string, secondsAgo: number) {
    const callid = `ok-${seq++}`;
    const at = ago(secondsAgo).toISOString().replace("T", " ").replace("Z", "");
    await db.query("INSERT INTO queue_log (time, callid, queuename, event, data1, data2) VALUES ($1, $2, $3, 'SANTRALIO_ENTER', '8508401234', $4)", [at, callid, `${tenant.prefix}_destek`, caller]);
    await db.query("INSERT INTO queue_log (time, callid, queuename, agent, event, data1) VALUES ($1, $2, $3, '1001', 'CONNECT', '5')", [at, callid, `${tenant.prefix}_destek`]);
  }
  const jobs = async () => (await db.query("SELECT * FROM callback_jobs WHERE tenant_id = $1 ORDER BY id", [tenant.id])).rows;
  const job = async (callid: string) => (await db.query("SELECT * FROM callback_jobs WHERE tenant_id = $1 AND source_callid = $2", [tenant.id, callid])).rows[0];

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    cb = await import("../src/callbacks.ts");
    const ops = await import("../src/ops.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0].id;
    tenant = await ops.createTenant(db, "Geri Arama " + randomBytes(2).toString("hex"), reseller);
    await db.query("UPDATE tenants SET ai_enabled = true WHERE id = $1", [tenant.id]);
    await db.query("INSERT INTO licenses (tenant_id, source, active, max_extensions, max_channels) VALUES ($1, 'manual', true, 10, 4)", [tenant.id]);
    await db.query(
      "INSERT INTO trunks (tenant_id, operator, server, username, secret_enc, key_id, contact_token) VALUES ($1, 'netgsm', 'sip.netgsm.com.tr', '8508401234', '\\x00', 'k1', $2)",
      [tenant.id, randomBytes(8).toString("hex")],
    );
    await db.query("INSERT INTO ai_flows (tenant_id, name, greeting_text) VALUES ($1, 'karsilama', 'Merhaba')", [tenant.id]);
    await cb.saveSettings(db, tenant.id, BASE, "test");
  });
  after(async () => void (await db?.end()));
  beforeEach(() => {
    dialed.length = 0;
    channels = 0;
  });

  let first = "";
  it("kaçan çağrı iş oluşturur; gecikme dolmadan aranmaz, dolunca aranır", async () => {
    first = await missed("05321234567", 5);
    await cb.tick(db, dialer);
    const j = await job(first);
    assert.equal(j.status, "pending");
    assert.equal(j.phone, "+905321234567");
    assert.equal(dialed.length, 0);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(dialed.length, 1);
    assert.equal(dialed[0].dial, "05321234567");
    assert.equal((await job(first)).status, "dialing");
  });

  it("yapay zekâ oturumu başlayınca 'answered'", async () => {
    const j = await job(first);
    await cb.markAnswered(db, tenant.id, Number(j.id), null);
    assert.equal((await job(first)).status, "answered");
  });

  it("aynı numara bekleme süresi içinde tekrar aranmaz", async () => {
    const again = await missed("05321234567", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    const j = await job(again);
    assert.equal(j.status, "skipped");
    assert.match(j.note, /yakın zamanda/);
    assert.equal(dialed.length, 0);
  });

  it("gizli ve yurt dışı numara aranmaz; aranmak istemeyen listesi", async () => {
    const hidden = await missed("anonymous", 3);
    const intl = await missed("+447911123456", 3);
    await cb.addOptout(db, tenant.id, "0533 111 22 33", "istemiyor", "test");
    const opted = await missed("05331112233", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(await job(hidden), undefined);
    assert.equal((await job(intl)).status, "skipped");
    assert.equal((await job(opted)).status, "skipped");
    assert.equal(dialed.length, 0);
  });

  it("cevapsız: yeniden dener, sonra 'no_answer'", async () => {
    const c = await missed("05441112233", 3, "EXITWITHTIMEOUT");
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal((await job(c)).status, "dialing");
    // Çaldırma + pay geçti, oturum yok: tekrar sıraya.
    await cb.tick(db, dialer, new Date(Date.now() + 30_000 + 100_000));
    let j = await job(c);
    assert.equal(j.status, "pending");
    assert.equal(j.attempts, 1);
    // Yeniden deneme zamanı geldi: ikinci arama.
    await cb.tick(db, dialer, new Date(Date.now() + 30_000 + 100_000 + 11 * 60_000));
    assert.equal((await job(c)).status, "dialing");
    await cb.tick(db, dialer, new Date(Date.now() + 30_000 + 100_000 + 11 * 60_000 + 100_000));
    j = await job(c);
    assert.equal(j.status, "no_answer");
    assert.equal(j.attempts, 2);
    assert.equal(dialed.filter((d) => d.dial === "05441112233").length, 2);
  });

  it("arayan bu arada görüşüldüyse aranmaz", async () => {
    const c = await missed("05551112233", 60);
    await cb.tick(db, dialer); // gecikme dolmamış gibi değil: 60 sn önce kaçtı, hemen aranabilir; önce görüşmeyi ekleyelim
    await db.query("UPDATE callback_jobs SET status = 'pending', next_at = now() + interval '1 minute' WHERE source_callid = $1", [c]);
    await answeredCall("05551112233", 10);
    dialed.length = 0;
    await cb.tick(db, dialer, new Date(Date.now() + 120_000));
    const j = await job(c);
    assert.equal(j.status, "resolved");
    assert.equal(dialed.filter((d) => d.dial === "05551112233").length, 0);
  });

  it("saat aralığı dışında aranmaz", async () => {
    await cb.saveSettings(db, tenant.id, { ...BASE, weekdays: [((new Date().getUTCDay() + 6) % 7) + 1 === 7 ? 1 : 7] }, "test");
    const c = await missed("05661112233", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal((await job(c)).status, "pending");
    assert.equal(dialed.length, 0);
    await cb.saveSettings(db, tenant.id, BASE, "test");
    await db.query("UPDATE callback_jobs SET status = 'cancelled' WHERE tenant_id = $1 AND status IN ('pending','dialing')", [tenant.id]);
  });

  it("eş zamanlı sınır ve lisans kanal sınırı", async () => {
    const a = await missed("05771112233", 3);
    const b = await missed("05781112233", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(dialed.length, 1, "eş zamanlı 1");
    assert.deepEqual([(await job(a)).status, (await job(b)).status].sort(), ["dialing", "pending"]);
    await db.query("UPDATE callback_jobs SET status = 'answered' WHERE tenant_id = $1 AND status = 'dialing'", [tenant.id]);
    dialed.length = 0;
    channels = 4; // lisans: 4 kanal dolu
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(dialed.length, 0, "kanal dolu");
    channels = 0;
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(dialed.length, 1);
  });

  it("çok eski kaçan çağrı düşer; kapalı ayarda hiçbir şey olmaz", async () => {
    const old = await missed("05881112233", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000 - 3_000));
    await db.query("UPDATE callback_jobs SET status = 'pending', missed_at = now() - interval '3 hours', next_at = now() WHERE source_callid = $1", [old]);
    await db.query("UPDATE callback_jobs SET status = 'cancelled' WHERE tenant_id = $1 AND status = 'dialing'", [tenant.id]);
    await cb.tick(db, dialer);
    assert.equal((await job(old)).status, "skipped");
    await cb.saveSettings(db, tenant.id, { ...BASE, enabled: false }, "test");
    const c = await missed("05991112233", 3);
    await cb.tick(db, dialer, new Date(Date.now() + 30_000));
    assert.equal(await job(c), undefined);
    assert.ok((await jobs()).length > 0);
  });
});
