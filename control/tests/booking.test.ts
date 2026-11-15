// Rezervasyon testleri.
// Birim: hizmet tanımı, alan denetimi, istek biçimi, asistan kuralları (fiyat sorulmadan rezervasyon yok, bilgiler değişirse yok,
// sınırlar), araç döngüsü.
// Uçtan uca (test veritabanı): yerleşik mod (oluştur, arayanın rezervasyonları, onay/iptal, webhook), işletme sistemi modu
// (imzalı istek, yanıt doğrulama, iptal bildirimi), rezervasyon sonrası ödeme bağlantısı (tutar sunucudan, SMS).
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/booking.test.ts

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { checkFields, toRequest, validateServices } from "../src/booking.ts";
import { newState, respond, runTool, type ToolExec } from "../src/ai/assistant.ts";
import type { Decision, FlowContext, LanguageModel, Turn } from "../src/ai/providers.ts";
import { PG_DATABASE } from "../src/config.ts";

const TRANSFER = {
  key: "transfer",
  label: "Havalimanı transferi",
  description: "Dalaman havalimanından otele",
  fields: [
    { key: "tarih", label: "Tarih", type: "date" },
    { key: "saat", label: "Saat", type: "time" },
    { key: "kisi", label: "Kişi sayısı", type: "number" },
    { key: "arac", label: "Araç", type: "choice", choices: ["Vito", "Sprinter"] },
    { key: "not", label: "Not", type: "text", required: false },
  ],
  price: "85.00",
  currency: "EUR",
  payment: "optional",
};

const dec = (action: Decision["action"], booking: Decision["booking"] = null, say = ""): Decision => ({
  action,
  say,
  target: null,
  summary: null,
  language: "tr-TR",
  inputTokens: 1,
  outputTokens: 1,
  booking,
});
const REQ = { service: "transfer", fields: { tarih: "2026-12-01", saat: "14:30", kisi: "3", arac: "vito" }, payNow: false, customerName: "Ayşe" };

describe("Rezervasyon: birim", () => {
  it("hizmet tanımı doğrulanır", () => {
    const [s] = validateServices([TRANSFER]);
    assert.equal(s.fields[0].required, true);
    assert.equal(s.fields[4].required, false);
    assert.deepEqual(s.fields[3].choices, ["Vito", "Sprinter"]);
    assert.throws(() => validateServices([{ ...TRANSFER, key: "Transfer!" }]), /kısa ad/);
    assert.throws(() => validateServices([TRANSFER, TRANSFER]), /iki kez/);
    assert.throws(() => validateServices([{ ...TRANSFER, price: "abc" }]), /fiyat/);
    assert.throws(() => validateServices([{ ...TRANSFER, currency: "BTC" }]), /para birimi/);
    assert.throws(() => validateServices([{ ...TRANSFER, fields: [{ key: "a", label: "A", type: "choice", choices: ["tek"] }] }]), /seçenek/);
  });

  it("alanlar: eksik, geçersiz, seçenek büyük/küçük harf, bilinmeyen alan atılır", () => {
    const [s] = validateServices([TRANSFER]);
    const ok = checkFields(s, { ...REQ.fields, fazla: "x" });
    assert.ok("ok" in ok);
    assert.equal(ok.ok.arac, "Vito");
    assert.equal(ok.ok.fazla, undefined);
    const bad = checkFields(s, { tarih: "1 Aralık", saat: "14:30", arac: "Minibüs" });
    assert.ok(!("ok" in bad));
    assert.deepEqual(bad.missing, ["Kişi sayısı"]);
    assert.deepEqual(bad.invalid, ["Tarih", "Araç"]);
  });

  it("istek biçimi: hizmet adı, alan anahtarları, uzunluk", () => {
    const r = toRequest({ service: "transfer", fields: { tarih: "2026-12-01", "BAD KEY": "x", n: 5 }, payNow: true, customerName: "  Ali  " });
    assert.deepEqual(r, { service: "transfer", fields: { tarih: "2026-12-01" }, payNow: true, customerName: "Ali" });
    assert.throws(() => toRequest({ service: "../x" }), /hizmet/);
    assert.throws(() => toRequest(null), /hizmet/);
  });

  function fakeExec(log: string[]): ToolExec {
    return {
      quote: async (r) => (log.push(`quote ${r.fields.tarih}`), { available: r.fields.tarih !== "2026-12-24", price: { amount: "85.00", currency: "EUR" }, message: null }),
      create: async () => (log.push("create"), { reference: "RZAB12CD34", status: "pending", price: { amount: "85.00", currency: "EUR" }, payment: { sent: true, reason: null } }),
      lookup: async () => (log.push("lookup"), []),
    };
  }

  it("fiyat sorulmadan, bilgiler değişince ya da müsait değilken rezervasyon yok; tek rezervasyon", async () => {
    const log: string[] = [];
    const ex = fakeExec(log);
    const st = newState();
    assert.match(await runTool(ex, st, dec("book", REQ)), /henüz müsaitlik sorulmadı/);
    assert.match(await runTool(ex, st, dec("quote", REQ)), /Müsait\. Fiyat: 85\.00 EUR/);
    // Saat değişti: yeniden fiyat sorulmalı.
    assert.match(await runTool(ex, st, dec("book", { ...REQ, fields: { ...REQ.fields, saat: "16:00" } })), /bilgiler değişti/);
    // Büyük/küçük harf ve boşluk farkı aynı sayılır.
    const r = await runTool(ex, st, dec("book", { ...REQ, fields: { ...REQ.fields, arac: " VITO " } }));
    assert.match(r, /Numara: R Z A B 1 2 C D 3 4\./);
    assert.match(r, /kısa mesajla gönderildi/);
    assert.match(await runTool(ex, st, dec("book", REQ)), /zaten bir rezervasyon/);
    assert.deepEqual(log, ["quote 2026-12-01", "create"]);

    const st2 = newState();
    const xmas = { ...REQ, fields: { ...REQ.fields, tarih: "2026-12-24" } };
    assert.match(await runTool(ex, st2, dec("quote", xmas)), /Müsait değil/);
    assert.match(await runTool(ex, st2, dec("book", xmas)), /müsait değil/);
  });

  it("fiyat sorgusu sınırı ve işlem hatası güvenli yanıt verir", async () => {
    const st = newState();
    const ex = fakeExec([]);
    for (let i = 0; i < 4; i++) await runTool(ex, st, dec("quote", REQ));
    assert.match(await runTool(ex, st, dec("quote", REQ)), /sınırına/);
    const broken: ToolExec = { ...ex, quote: async () => Promise.reject(new Error("bağlantı koptu")) };
    assert.match(await runTool(broken, newState(), dec("quote", REQ)), /yanıt veremedi \(bağlantı koptu\).*aktar/);
    assert.match(await runTool(ex, newState(), dec("quote", null)), /eksik/);
  });

  it("döngü: ara cümle söylenir, sonuç modele verilir, araç yoksa işlem konuşmaya döner, takılırsa aktarılır", async () => {
    const script: Decision[] = [dec("quote", REQ, "Hemen bakıyorum."), dec("say", null, "85 euro, onaylıyor musunuz?")];
    const seen: Turn[][] = [];
    const llm: LanguageModel = { decide: async (_f, h) => (seen.push([...h]), script.shift()!) };
    const flow = { languages: ["tr-TR"] } as FlowContext;
    const said: string[] = [];
    const history: Turn[] = [{ role: "caller", text: "1 Aralık 3 kişi transfer" }];
    const d = await respond(llm, flow, history, { exec: fakeExec([]), state: newState() }, async (t) => void said.push(t));
    assert.equal(d.action, "say");
    assert.equal(d.inputTokens, 2);
    assert.deepEqual(said, ["Hemen bakıyorum."]);
    assert.equal(history.at(-1)!.role, "tool");
    assert.equal(seen[1].at(-1)!.role, "tool");

    const noTools = await respond({ decide: async () => dec("quote", REQ, "Bakayım") }, flow, [], null, async () => {});
    assert.equal(noTools.action, "say");

    const stuck = await respond({ decide: async () => dec("lookup") }, flow, [], { exec: fakeExec([]), state: newState() }, async () => {});
    assert.equal(stuck.action, "transfer");
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;
describe("Rezervasyon: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB yok" }, () => {
  let db: any;
  let booking: typeof import("../src/booking.ts");
  let exec: typeof import("../src/bookingexec.ts");
  let tenant: { id: number; prefix: string; name: string };
  const key = randomBytes(32);
  const keys = { key: () => key, currentId: "k1" };
  const pub = (async () => [{ address: "93.184.216.34", family: 4 }]) as any;
  const posted: { url: string; body: any; headers: Record<string, string> }[] = [];
  let reply: (body: any) => { status: number; body: string } = () => ({ status: 200, body: "{}" });
  const post = async (url: string, body: string, headers: Record<string, string>) => {
    posted.push({ url, body: JSON.parse(body), headers });
    return reply(JSON.parse(body));
  };
  const deps = () => ({ db, keys, post, resolve: pub, actor: "test" });
  const calls: string[] = [];
  const fakeFetch = (async (input: any) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ code: "00", jobid: "1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const payDeps = () => ({ db, keys, fetch: fakeFetch, apiBase: "https://api.santralio.site", actor: "test" });

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    booking = await import("../src/booking.ts");
    exec = await import("../src/bookingexec.ts");
    const ops = await import("../src/ops.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0]?.id ?? (await db.query("INSERT INTO resellers (name) VALUES ('test') RETURNING id")).rows[0].id;
    const t = await ops.createTenant(db, "Deniz Transfer " + randomBytes(2).toString("hex"), reseller);
    tenant = { id: t.id, prefix: t.prefix, name: "Deniz Transfer" };
    // Olayları görmek için bir webhook ucu.
    await db.query("UPDATE webhooks SET enabled = false");
    await db.query(
      `INSERT INTO webhooks (tenant_id, url, events, secret_enc, key_id, secret_ref) VALUES ($1, 'https://hook.ornek.com/x', $2, '\\x00', 'k1', $3)`,
      [tenant.id, ["booking.created", "booking.confirmed", "booking.cancelled"], randomBytes(12).toString("hex")],
    );
  });
  after(async () => void (await db?.end()));

  const events = async () => (await db.query("SELECT type FROM webhook_deliveries WHERE tenant_id = $1 ORDER BY id", [tenant.id])).rows.map((r: any) => r.type);

  it("kapalıyken işlem yok; açarken hizmet şart", async () => {
    await assert.rejects(booking.quote(deps(), tenant.id, { service: "transfer", fields: {} }, { phone: null }), /kapalı/);
    await assert.rejects(booking.saveSettings(deps(), tenant.id, { mode: "builtin", services: [] }), /en az bir hizmet/);
    const s = await booking.saveSettings(deps(), tenant.id, { mode: "builtin", services: [TRANSFER] });
    assert.equal(s.mode, "builtin");
    assert.equal(s.secret, null);
  });

  it("yerleşik: fiyat hizmetten, rezervasyon kaydı, arayanın rezervasyonları, onay ve iptal, olaylar", async () => {
    const q = await booking.quote(deps(), tenant.id, { service: "transfer", fields: REQ.fields }, { phone: null });
    assert.deepEqual(q, { available: true, price: { amount: "85.00", currency: "EUR" }, message: null });
    const miss = await booking.quote(deps(), tenant.id, { service: "transfer", fields: { tarih: "2026-12-01" } }, { phone: null });
    assert.equal(miss.available, false);
    assert.match(miss.message!, /Saat/);
    const ex = exec.directExec({ booking: deps(), pay: payDeps() }, tenant, { source: "phone", phone: "+905321234567", callId: "1700.1", aiSessionId: null });
    const c = await ex.create(REQ);
    assert.match(c.reference, /^RZ[A-Z0-9]{8}$/);
    assert.equal(c.status, "pending");
    assert.equal(c.payment, null); // isteğe bağlı ödeme, arayan istemedi
    const found = await ex.lookup();
    assert.equal(found.length, 1);
    assert.equal(found[0].date, "2026-12-01");
    const other = exec.directExec({ booking: deps(), pay: payDeps() }, tenant, { source: "phone", phone: "+905559999999", callId: null, aiSessionId: null });
    assert.deepEqual(await other.lookup(), []);
    const [row] = await booking.list(db, tenant.id);
    assert.equal(row.customerName, "Ayşe");
    assert.equal(row.fields.arac, "Vito");
    await booking.setStatus(deps(), tenant.id, row.id, "confirmed");
    await assert.rejects(booking.setStatus(deps(), tenant.id, row.id, "confirmed"), /zaten/);
    await booking.setStatus(deps(), tenant.id, row.id, "cancelled", "müşteri vazgeçti");
    await assert.rejects(booking.setStatus(deps(), tenant.id, row.id, "confirmed"), /zaten/);
    assert.deepEqual(await other.lookup(), []);
    assert.deepEqual(await events(), ["booking.created", "booking.confirmed", "booking.cancelled"]);
  });

  it("ödeme: tutar sunucudan, cep telefonuna SMS; sabit hatta alan numarası; numara yoksa gönderilmez", async () => {
    const ps = await import("../src/payments/service.ts");
    await ps.saveProvider(payDeps(), tenant.id, { provider: "test", label: "Test", mode: "test", credentials: {}, isDefault: true });
    await ps.saveSms(payDeps(), tenant.id, { sender: "netgsm", credentials: { usercode: "8508401234", password: "gizli", msgheader: "DENIZ" } });
    calls.length = 0;
    const ex = exec.directExec({ booking: deps(), pay: payDeps() }, tenant, { source: "phone", phone: "+905321234567", callId: "1700.2", aiSessionId: null });
    const c = await ex.create({ ...REQ, payNow: true });
    assert.deepEqual(c.payment, { sent: true, reason: null });
    assert.ok(calls.some((u) => u.includes("netgsm")));
    const b = (await db.query("SELECT payment_ref FROM bookings WHERE public_ref = $1", [c.reference])).rows[0];
    const pr = (await db.query("SELECT amount::text, currency, created_by, phone FROM payment_requests WHERE public_id = $1", [b.payment_ref])).rows[0];
    assert.deepEqual(pr, { amount: "85.00", currency: "EUR", created_by: "booking", phone: "+905321234567" });

    const landline = exec.directExec({ booking: deps(), pay: payDeps() }, tenant, { source: "phone", phone: "+902125550000", callId: null, aiSessionId: null });
    await booking.saveSettings(deps(), tenant.id, { services: [{ ...TRANSFER, payment: "required", fields: [...TRANSFER.fields, { key: "cep", label: "Cep", type: "phone", required: false }] }] });
    const c2 = await landline.create({ ...REQ, fields: { ...REQ.fields, cep: "0532 111 22 33" } });
    assert.equal(c2.payment?.sent, true);
    const c3 = await landline.create(REQ);
    assert.deepEqual(c3.payment, { sent: false, reason: "cep telefonu numarası yok" });
  });

  it("işletme sistemi: imzalı istek, yanıt doğrulama, iptal bildirimi, gizli anahtar bir kez", async () => {
    await assert.rejects(booking.saveSettings(deps(), tenant.id, { mode: "api", apiUrl: "http://isletme.ornek.com/rz" }), Error);
    const s = await booking.saveSettings(deps(), tenant.id, { mode: "api", apiUrl: "https://isletme.ornek.com/rz", services: [TRANSFER] });
    assert.match(s.secret!, /^bksec_/);
    const s2 = await booking.saveSettings(deps(), tenant.id, { mode: "api" });
    assert.equal(s2.secret, null);
    assert.equal(s2.hasSecret, true);

    reply = (b) =>
      b.action === "quote"
        ? { status: 200, body: JSON.stringify({ available: true, price: { amount: "120", currency: "EUR" }, message: "Son 2 araç" }) }
        : b.action === "create"
          ? { status: 200, body: JSON.stringify({ reference: "TRF-9981", status: "confirmed", price: { amount: "120.00", currency: "EUR" }, payment: "none" }) }
          : b.action === "lookup"
            ? { status: 200, body: JSON.stringify({ bookings: [{ reference: "TRF-9981", service: "Transfer", summary: "3 kişi Vito", date: "2026-12-01", status: "confirmed" }] }) }
            : { status: 200, body: JSON.stringify({ ok: true }) };
    posted.length = 0;
    const q = await booking.quote(deps(), tenant.id, { service: "transfer", fields: REQ.fields }, { phone: "+905321234567" });
    assert.deepEqual(q, { available: true, price: { amount: "120.00", currency: "EUR" }, message: "Son 2 araç" });
    const p = posted[0];
    const raw = JSON.stringify(p.body);
    const expect = "sha256=" + createHmac("sha256", s.secret!).update(`${p.headers["x-santralio-timestamp"]}.${raw}`).digest("hex");
    assert.equal(p.headers["x-santralio-signature"], expect);
    assert.equal(p.headers["x-santralio-action"], "quote");
    assert.equal(p.body.fields.arac, "Vito");

    const ex = exec.directExec({ booking: deps(), pay: payDeps() }, tenant, { source: "phone", phone: "+905321234567", callId: "1700.3", aiSessionId: null });
    const c = await ex.create(REQ);
    assert.deepEqual({ ...c }, { reference: "TRF-9981", status: "confirmed", price: { amount: "120.00", currency: "EUR" }, payment: null });
    assert.match(posted.at(-1)!.body.santralio_reference, /^RZ/);
    assert.equal((await ex.lookup())[0].reference, "TRF-9981");

    const row = (await booking.list(db, tenant.id))[0];
    assert.equal(row.externalRef, "TRF-9981");
    await booking.setStatus(deps(), tenant.id, row.id, "cancelled");
    assert.deepEqual(posted.at(-1)!.body, { action: "cancel", reference: "TRF-9981", phone: "+905321234567" });

    // Bozuk yanıtlar
    reply = () => ({ status: 200, body: JSON.stringify({ status: "confirmed" }) });
    await assert.rejects(ex.create(REQ), /numarası dönmedi/);
    reply = () => ({ status: 500, body: "x" });
    await assert.rejects(ex.lookup(), /HTTP 500/);
    reply = () => ({ status: 200, body: "<html>" });
    await assert.rejects(booking.quote(deps(), tenant.id, { service: "transfer", fields: REQ.fields }, { phone: null }), /JSON/);
    reply = () => ({ status: 200, body: JSON.stringify({ available: true, price: { amount: "-5", currency: "EUR" } }) });
    assert.equal((await booking.quote(deps(), tenant.id, { service: "transfer", fields: REQ.fields }, { phone: null })).price, null);
  });
});
