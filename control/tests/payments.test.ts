// Ödeme modülü testleri.
// Birim: tutar, telefon, PayTR/iyzico imzaları (bağımsız Python hesabıyla karşılaştırılır), bildirim doğrulama, SSRF koruması.
// Uçtan uca (test veritabanı): sağlayıcı bağlama, profil, talep, SMS, bildirim (tekrar / sahte / eksik tutar), iptal, süre dolması,
// yapay zekâ/IVR tutar kuralı, durum sorgusu (iyzico), test sayfası.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/payments.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PG_DATABASE } from "../src/config.ts";
import { authorization } from "../src/payments/providers/iyzico.ts";
import { callbackHash, istanbulTime, linkForm, paytr, trMobile } from "../src/payments/providers/paytr.ts";
import { _test, assertPublicHttps, normalizePhone } from "../src/payments/service.ts";
import { netgsmNumber, smsText } from "../src/payments/sms.ts";
import { minor, parseAmount } from "../src/payments/types.ts";

const PAYTR = { merchant_id: "123456", merchant_key: "KEYKEYKEYKEY1234", merchant_salt: "SALTSALTSALT5678" };

describe("Ödeme: birim", () => {
  it("tutar yalnızca '1500.00' biçiminde kabul edilir", () => {
    assert.equal(parseAmount("1500"), "1500.00");
    assert.equal(parseAmount("1500.5"), "1500.50");
    assert.equal(parseAmount(1500.5), "1500.50");
    for (const v of ["1.500,50", "-1", "0", "0.00", "abc", "1e3", "12.345", "", null]) assert.equal(parseAmount(v), null, String(v));
    assert.equal(minor("1500.50"), 150050n);
  });

  it("telefon numaraları E.164'e çevrilir", () => {
    assert.equal(normalizePhone("0532 123 45 67"), "+905321234567");
    assert.equal(normalizePhone("5321234567"), "+905321234567");
    assert.equal(normalizePhone("905321234567"), "+905321234567");
    assert.equal(normalizePhone("0044 20 7946 0958"), "+442079460958");
    assert.equal(normalizePhone("123"), null);
    assert.equal(trMobile("+905321234567"), "05321234567");
    assert.equal(trMobile("+442079460958"), null);
    assert.equal(netgsmNumber("+905321234567"), "5321234567");
  });

  it("PayTR bağlantı imzası bağımsız hesapla aynı", () => {
    const f = linkForm(PAYTR, {
      reference: "pay_" + "a".repeat(20),
      description: "Rezervasyon kaporası",
      money: { amount: "1500.00", currency: "TRY" },
      maxInstallment: 3,
      expiresAt: new Date("2026-11-12T10:00:00Z"),
      callbackUrl: "https://api.santralio.site/api/payments/callback/x",
      phone: null,
      locale: "tr",
    });
    assert.equal(f.paytr_token, "p2xVBps437tqS1ynlYfsh7V/IYS3fYn7lypkD/tymXQ=");
    assert.equal(f.price, "150000");
    assert.equal(f.currency, "TL");
    assert.equal(f.callback_id, "a".repeat(20));
    assert.equal(f.max_count, "1");
    assert.equal(f.expiry_date, "2026-11-12 13:00:00"); // Türkiye saati
    assert.equal(istanbulTime(new Date("2026-01-01T21:30:05Z")), "2026-01-02 00:30:05");
  });

  it("PayTR bildirimi: doğru imza kabul, değiştirilmiş/sahte ret", () => {
    const p = { callback_id: "a".repeat(20), merchant_oid: "PTR123", status: "success", total_amount: "150000", payment_amount: "150000", merchant_id: "123456" };
    assert.equal(callbackHash(PAYTR, p), "CnndWv+prE44RruJ+xCRNZHFx5RFE+zEdkC5CIrcDto=");
    const body = (o: Record<string, string>) => ({ headers: {}, rawBody: Buffer.from(new URLSearchParams(o).toString()), contentType: "application/x-www-form-urlencoded" });
    const ok = paytr.verifyCallback!(PAYTR, "live", body({ ...p, hash: callbackHash(PAYTR, p) }));
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.reference, "pay_" + "a".repeat(20));
      assert.deepEqual(ok.status, { state: "paid", paidAmount: "1500.00" });
      assert.equal(ok.reply.body, "OK");
    }
    assert.equal(paytr.verifyCallback!(PAYTR, "live", body({ ...p, total_amount: "100", hash: callbackHash(PAYTR, p) })).ok, false);
    assert.equal(paytr.verifyCallback!(PAYTR, "live", body({ ...p, hash: "AAAA" })).ok, false);
    assert.equal(paytr.verifyCallback!(PAYTR, "live", body({ ...p, merchant_id: "999", hash: callbackHash(PAYTR, p) })).ok, false);
  });

  it("iyzico IYZWSv2 başlığı bağımsız hesapla aynı", () => {
    assert.equal(
      authorization("apikeyapikey", "secretsecretsecret", "1722246017090123456789", "/v2/iyzilink/products", '{"a":1}'),
      "IYZWSv2 YXBpS2V5OmFwaWtleWFwaWtleSZyYW5kb21LZXk6MTcyMjI0NjAxNzA5MDEyMzQ1Njc4OSZzaWduYXR1cmU6YmM4Yjg4MTJlMWE2YjEwZjA0ZTViM2UwNWY0NDdkM2E2ZDFjMGQ0M2UxYTVhMDYzNWYwNTkwMDk2NjlmNmExYQ==",
    );
  });

  it("işletme sistemi adresi: yalnızca genel https", async () => {
    const pub = async () => [{ address: "93.184.216.34", family: 4 }];
    const priv = async () => [{ address: "10.0.0.5", family: 4 }];
    await assertPublicHttps("https://ornek.com/borc", pub as any);
    for (const u of ["http://ornek.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://u:p@ornek.com/x", "https://ornek.com:8443/x", "nope"])
      await assert.rejects(assertPublicHttps(u, pub as any), Error, u);
    await assert.rejects(assertPublicHttps("https://ic.ornek.com/x", priv as any));
    for (const ip of ["10.1.1.1", "192.168.1.1", "172.20.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(_test.privateAddress(ip), ip);
    assert.ok(!_test.privateAddress("93.184.216.34"));
  });

  it("SMS metni bağlantıyı sona koyar", () => {
    const t = smsText("", { company: "Deniz Otel", amount: "1500.00", currency: "TRY", description: "Rezervasyon kaporası", link: "https://x.y/z" });
    assert.match(t, /^Deniz Otel: Rezervasyon kaporası için 1\.500,00 TL ödemeniz: https:\/\/x\.y\/z$/);
  });
});

// --- Uçtan uca (test veritabanı) ---

const TEST_DB = process.env.SANTRALIO_TEST_DB;

describe("Ödeme: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB tanımlı değil" }, () => {
  let db: any;
  let svc: typeof import("../src/payments/service.ts");
  let tenant: { id: number; name: string; prefix: string };
  const key = randomBytes(32);
  const calls: { url: string; form: Record<string, string>; json?: any }[] = [];
  let paytrFail = false;
  let iyzSold = 0;
  const fakeFetch = (async (input: any, init: any) => {
    const url = String(input);
    const raw = init?.body ? String(init.body) : "";
    const form = init?.headers?.["content-type"]?.includes("urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : {};
    calls.push({ url, form, json: raw.startsWith("{") ? JSON.parse(raw) : undefined });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/link/create")) return paytrFail ? json({ status: "failed", reason: "test hatası" }) : json({ status: "success", id: "L" + calls.length, link: "https://www.paytr.com/link/L" + calls.length });
    if (url.endsWith("/link/send-sms") || url.endsWith("/link/delete")) return json({ status: "success" });
    if (url.includes("netgsm")) return json({ code: "00", jobid: "1" });
    if (url.includes("sandbox-api.iyzipay.com/v2/iyzilink/products")) {
      if (init.method === "POST") return json({ status: "success", data: { token: "IYZ" + calls.length, url: "https://sandbox.iyzi.link/IYZ" + calls.length } });
      if (init.method === "GET" && /products\/IYZ/.test(url)) return json({ status: "success", data: { soldCount: iyzSold, price: "250.00" } });
      return json({ status: "success" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const deps = () => ({ db, keys: { key: () => key, currentId: "k1" }, fetch: fakeFetch, apiBase: "https://api.santralio.site", actor: "test" });

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    svc = await import("../src/payments/service.ts");
    const ops = await import("../src/ops.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0]?.id ?? (await db.query("INSERT INTO resellers (name) VALUES ('test') RETURNING id")).rows[0].id;
    const t = await ops.createTenant(db, "Deniz Otel " + randomBytes(2).toString("hex"), reseller);
    tenant = { id: t.id, prefix: t.prefix, name: "Deniz Otel" };
  });
  after(async () => void (await db?.end()));

  let providerId = 0;
  it("sağlayıcı bağlanır; gizli alanlar yanıtta dönmez; boş gizli alan eski değeri korur", async () => {
    providerId = await svc.saveProvider(deps(), tenant.id, { provider: "paytr", label: "PayTR", mode: "test", credentials: PAYTR });
    const [p] = await svc.listProviders(deps(), tenant.id);
    assert.equal(p.isDefault, true);
    assert.equal(p.fields.merchant_id, "123456");
    assert.equal(p.fields.merchant_key, true); // yalnızca "girildi"
    assert.ok(!JSON.stringify(p).includes(PAYTR.merchant_key));
    await svc.saveProvider(deps(), tenant.id, { id: providerId, label: "PayTR ana", credentials: { merchant_key: "", merchant_salt: "" } });
    const raw = (await db.query("SELECT credentials_enc FROM payment_providers WHERE id = $1", [providerId])).rows[0].credentials_enc;
    assert.ok(!raw.toString("latin1").includes(PAYTR.merchant_key), "şifreli saklanmalı");
    await assert.rejects(svc.saveProvider(deps(), tenant.id, { provider: "garanti", mode: "test", credentials: {} }), /henüz/);
    await assert.rejects(svc.saveProvider(deps(), tenant.id, { provider: "test", mode: "live", credentials: {} }), /canlıya/);
  });

  it("bağlantı testi gerçek bir bağlantı oluşturup siler", async () => {
    calls.length = 0;
    const r = await svc.testProvider(deps(), tenant.id, providerId);
    assert.deepEqual(r, { ok: true, error: null });
    assert.ok(calls.some((c) => c.url.endsWith("/link/create")) && calls.some((c) => c.url.endsWith("/link/delete")));
  });

  it("profil kuralları", async () => {
    await svc.saveProfile(deps(), tenant.id, { name: "kapora", title: "Rezervasyon kaporası", amountSource: "fixed", fixedAmount: "1500", maxAmount: "2000", maxInstallment: 3 });
    await svc.saveProfile(deps(), tenant.id, { name: "serbest", title: "Ödeme talebi", amountSource: "agent", maxAmount: "5000" });
    await assert.rejects(svc.saveProfile(deps(), tenant.id, { name: "x", title: "Sabit tutar", amountSource: "fixed", fixedAmount: "3000", maxAmount: "2000" }), /üst sınır/);
    await assert.rejects(svc.saveProfile(deps(), tenant.id, { name: "y", title: "Sorgulu", amountSource: "lookup", lookupUrl: "http://ornek.com", maxAmount: "100" }), /https/);
    await assert.rejects(
      svc.saveProfile(deps(), tenant.id, { name: "z", title: "Sorgulu", amountSource: "lookup", lookupUrl: "https://isletme.ornek.invalid/borc", maxAmount: "100" }),
      /çözül/,
    );
  });

  let ref = "";
  it("talep: sabit tutar, PayTR bağlantısı ve PayTR SMS'i", async () => {
    calls.length = 0;
    const r = await svc.createRequest(deps(), tenant, { profile: "kapora", phone: "0532 123 45 67", createdBy: "agent", user: "ayse@x" });
    ref = r.id;
    assert.match(ref, /^pay_[a-z0-9]{20}$/);
    assert.equal(r.amount, "1500.00");
    assert.equal(r.status, "sent");
    assert.equal(r.smsStatus, "sent");
    const create = calls.find((c) => c.url.endsWith("/link/create"))!;
    assert.equal(create.form.price, "150000");
    assert.equal(create.form.max_installment, "3");
    assert.match(create.form.callback_link, /^https:\/\/api\.santralio\.site\/api\/payments\/callback\/[a-z0-9]{32}$/);
    assert.equal(calls.find((c) => c.url.endsWith("/link/send-sms"))!.form.cell_phone, "05321234567");
  });

  it("tutar kuralları: üst sınır, yapay zekâ tutar belirleyemez, tuşlama henüz kapalı", async () => {
    await assert.rejects(svc.createRequest(deps(), tenant, { profile: "serbest", amount: "6000", createdBy: "agent", description: "Fazla tutar" }), /üst sınır/);
    await assert.rejects(svc.createRequest(deps(), tenant, { profile: "serbest", amount: "100", createdBy: "ai", description: "AI tutarı" }), /yapay zekâ/);
    await assert.rejects(svc.createRequest(deps(), tenant, { profile: "kapora", method: "dtmf", createdBy: "agent" }), /yalnızca bağlantı/);
    const ai = await svc.createRequest(deps(), tenant, { profile: "kapora", createdBy: "ai", sendSms: false });
    assert.equal(ai.amount, "1500.00");
    assert.equal(ai.status, "created");
  });

  const callbackKey = async () => (await db.query("SELECT callback_key FROM payment_providers WHERE id = $1", [providerId])).rows[0].callback_key;
  const paytrBody = (o: Record<string, string>) => {
    const p = { merchant_id: PAYTR.merchant_id, status: "success", ...o };
    return { headers: {}, rawBody: Buffer.from(new URLSearchParams({ ...p, hash: callbackHash(PAYTR, p) }).toString()), contentType: "application/x-www-form-urlencoded" };
  };

  it("bildirim: sahte imza reddedilir, durum değişmez", async () => {
    const reply = await svc.handleCallback(deps(), await callbackKey(), {
      headers: {},
      rawBody: Buffer.from(new URLSearchParams({ callback_id: ref.slice(4), merchant_oid: "X1", status: "success", total_amount: "150000", hash: "sahte" }).toString()),
      contentType: "application/x-www-form-urlencoded",
    });
    assert.equal(reply.status, 400);
    assert.equal((await svc.getRequest(deps(), tenant.id, ref)).status, "sent");
    assert.equal((await svc.handleCallback(deps(), "a".repeat(32), paytrBody({ callback_id: ref.slice(4), merchant_oid: "X1", total_amount: "150000" }))).status, 404);
  });

  it("bildirim: eksik tutar 'ödendi' yazılmaz", async () => {
    const r = await svc.createRequest(deps(), tenant, { profile: "kapora", createdBy: "agent", sendSms: false });
    const reply = await svc.handleCallback(deps(), await callbackKey(), paytrBody({ callback_id: r.id.slice(4), merchant_oid: "LOW1", total_amount: "100", payment_amount: "100" }));
    assert.equal(reply.body, "OK");
    const after = await svc.getRequest(deps(), tenant.id, r.id);
    assert.equal(after.status, "failed");
    assert.match(after.error, /az/);
  });

  it("bildirim: geçerli ödeme bir kez işlenir", async () => {
    const k = await callbackKey();
    const body = paytrBody({ callback_id: ref.slice(4), merchant_oid: "OK1", total_amount: "153000", payment_amount: "150000" });
    assert.equal((await svc.handleCallback(deps(), k, body)).body, "OK");
    const r = await svc.getRequest(deps(), tenant.id, ref);
    assert.equal(r.status, "paid");
    assert.equal(r.paidAmount, "1500.00");
    assert.equal((await svc.handleCallback(deps(), k, body)).body, "OK"); // tekrar: yeniden işlenmez
    assert.equal(Number((await db.query("SELECT count(*) FROM payment_events WHERE dedupe_key = 'OK1'")).rows[0].count), 1);
    await assert.rejects(svc.cancelRequest(deps(), tenant.id, ref), /bekleyen/);
  });

  it("iptal ve süre dolması", async () => {
    const r = await svc.createRequest(deps(), tenant, { profile: "kapora", createdBy: "agent", sendSms: false });
    calls.length = 0;
    await svc.cancelRequest(deps(), tenant.id, r.id);
    assert.equal((await svc.getRequest(deps(), tenant.id, r.id)).status, "cancelled");
    assert.ok(calls.some((c) => c.url.endsWith("/link/delete")));
    const e = await svc.createRequest(deps(), tenant, { profile: "kapora", createdBy: "agent", sendSms: false });
    await db.query("UPDATE payment_requests SET expires_at = now() - interval '10 minutes' WHERE public_id = $1", [e.id]);
    const res = await svc.poll(deps());
    assert.ok(res.expired >= 1);
    assert.equal((await svc.getRequest(deps(), tenant.id, e.id)).status, "expired");
  });

  it("sağlayıcı hatası talebi 'başarısız' bırakır ve kayıt kalır", async () => {
    paytrFail = true;
    const r = await svc.createRequest(deps(), tenant, { profile: "kapora", createdBy: "agent" });
    paytrFail = false;
    assert.equal(r.status, "failed");
    assert.match(r.error, /PayTR/);
  });

  it("iyzico: durum sorgusuyla ödeme anlaşılır", async () => {
    const iyz = await svc.saveProvider(deps(), tenant.id, { provider: "iyzico", label: "iyzico", mode: "test", credentials: { api_key: "sandbox-apikey", secret_key: "sandbox-secret" } });
    await svc.saveProfile(deps(), tenant.id, { name: "iyz", title: "iyzico ödemesi", amountSource: "fixed", fixedAmount: "250", maxAmount: "500", providerId: iyz });
    const r = await svc.createRequest(deps(), tenant, { profile: "iyz", createdBy: "agent", sendSms: false });
    assert.match(r.linkUrl, /iyzi\.link/);
    const created = calls.filter((c) => c.url.includes("iyzilink/products") && c.json).pop()!;
    assert.equal(created.json.price, "250.00");
    assert.equal(created.json.stockCount, 1);
    iyzSold = 0;
    await svc.poll(deps());
    assert.equal((await svc.getRequest(deps(), tenant.id, r.id)).status, "created");
    iyzSold = 1;
    const res = await svc.poll(deps());
    assert.ok(res.paid >= 1);
    assert.equal((await svc.getRequest(deps(), tenant.id, r.id)).status, "paid");
  });

  it("Netgsm SMS hesabı ve test sağlayıcısı sayfası", async () => {
    await svc.saveSms(deps(), tenant.id, { sender: "netgsm", credentials: { usercode: "8508401234", password: "gizli", msgheader: "DENIZOTEL" } });
    const sms = await svc.getSms(deps(), tenant.id);
    assert.equal(sms.fields.password, true);
    await svc.saveProvider(deps(), tenant.id, { provider: "test", label: "Test", mode: "test", credentials: {}, isDefault: true });
    calls.length = 0;
    const r = await svc.createRequest(deps(), tenant, { amount: "99.90", description: "Test ödemesi", phone: "+905321234567", createdBy: "agent" });
    assert.match(r.linkUrl, /\/api\/payments\/test-page\/pay_/);
    const sent = calls.find((c) => c.url.includes("netgsm"))!;
    assert.equal(sent.json.messages[0].no, "5321234567");
    assert.ok(sent.json.messages[0].msg.endsWith(r.linkUrl));
    assert.equal(await svc.testPageResult(deps(), r.id, "paid"), "ödendi");
    assert.equal((await svc.getRequest(deps(), tenant.id, r.id)).status, "paid");
    // Canlı/başka sağlayıcının talebi test sayfasından ödenemez.
    assert.equal(await svc.testPageInfo(deps(), ref), null);
  });
});
