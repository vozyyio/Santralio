// Web sohbeti testleri (test veritabanı): ayarlar ve site adresleri, kapalı pencere, oturum ve sınırlar, sahte modelle
// rezervasyon (ödeme bağlantısı ekranda), ekibe devretme ve webhook, belirteç ve kiracı ayrımı.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/chat.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { normalizeOrigin, frameHeaders } from "../src/chat.ts";
import type { Decision, LanguageModel } from "../src/ai/providers.ts";
import { PG_DATABASE } from "../src/config.ts";

describe("Web sohbeti: birim", () => {
  it("site adresi: https köken, yol atılır; http yalnızca localhost", () => {
    assert.equal(normalizeOrigin("www.Ornek.com/iletisim"), "https://www.ornek.com");
    assert.equal(normalizeOrigin("https://ornek.com.tr:8443/x"), "https://ornek.com.tr:8443");
    assert.equal(normalizeOrigin("http://localhost:3000"), "http://localhost:3000");
    for (const bad of ["http://ornek.com", "javascript:alert(1)", "https://a b.com", "intranet", "https://u:p@ornek.com"]) assert.throws(() => normalizeOrigin(bad), Error, bad);
  });
  it("pencere CSP: yalnızca izinli siteler gömebilir", () => {
    assert.match(frameHeaders(["https://ornek.com"])["content-security-policy"], /frame-ancestors https:\/\/ornek\.com$/);
    assert.match(frameHeaders([])["content-security-policy"], /frame-ancestors 'none'/);
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;
describe("Web sohbeti: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB yok" }, () => {
  let db: any;
  let chat: typeof import("../src/chat.ts");
  let tenant: any;
  let other: any;
  const key = randomBytes(32);
  const keys = { key: () => key, currentId: "k1" };
  const fetchFn = (async () => new Response(JSON.stringify({ code: "00", jobid: "1" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  // Sahte model: sıradaki kararları döndürür, gördüğü sistem sonuçlarını kaydeder.
  let script: Decision[] = [];
  const seen: string[] = [];
  const llm: LanguageModel = {
    decide: async (flow, history) => {
      const last = history.at(-1)!;
      if (last.role === "tool") seen.push(last.text);
      assert.equal(flow.channel, "chat");
      return script.shift() ?? { action: "say", say: "Başka bir konuda yardımcı olabilir miyim?", target: null, summary: null, language: "tr-TR", inputTokens: 5, outputTokens: 3 };
    },
  };
  const D = (action: Decision["action"], say: string, booking: Decision["booking"] = null, summary: string | null = null): Decision => ({
    action, say, target: null, summary, language: "tr-TR", inputTokens: 10, outputTokens: 4, booking,
  });
  let deps: () => import("../src/chat.ts").ChatDeps;

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    chat = await import("../src/chat.ts");
    const ops = await import("../src/ops.ts");
    const booking = await import("../src/booking.ts");
    const { directExec } = await import("../src/bookingexec.ts");
    const ps = await import("../src/payments/service.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0]?.id ?? (await db.query("INSERT INTO resellers (name) VALUES ('test') RETURNING id")).rows[0].id;
    const mk = async (n: string) => {
      const t = await ops.createTenant(db, n + " " + randomBytes(2).toString("hex"), reseller);
      await db.query("UPDATE tenants SET ai_enabled = true WHERE id = $1", [t.id]);
      await db.query(
        `INSERT INTO ai_flows (tenant_id, name, enabled, greeting_text, instructions, routes, max_turns, voice, model, languages, booking)
         VALUES ($1, 'karsilama', true, 'Merhaba', 'Transfer firmasıyız.', '[]', 20, 'azure:tr-TR-EmelNeural', 'claude-haiku-4-5', '{tr-TR,en-US}', true)`,
        [t.id],
      );
      return (await ops.tenantByPrefix(db, t.prefix));
    };
    tenant = await mk("Deniz Transfer");
    other = await mk("Başka Firma");
    const bd = { db, keys, actor: "test" };
    await booking.saveSettings(bd, tenant.id, {
      mode: "builtin",
      services: [{ key: "transfer", label: "Transfer", description: "", fields: [{ key: "tarih", label: "Tarih", type: "date" }], price: "85.00", currency: "EUR", payment: "required" }],
    });
    const pd = { db, keys, fetch: fetchFn, apiBase: "https://api.santralio.site", actor: "test" };
    await ps.saveProvider(pd, tenant.id, { provider: "test", label: "Test", mode: "test", credentials: {}, isDefault: true });
    await ps.saveSms(pd, tenant.id, { sender: "none" });
    await db.query("UPDATE webhooks SET enabled = false");
    await db.query(`INSERT INTO webhooks (tenant_id, url, events, secret_enc, key_id, secret_ref) VALUES ($1, 'https://hook.ornek.com/x', '{chat.handoff}', '\\x00', 'k1', $2)`, [tenant.id, randomBytes(12).toString("hex")]);
    deps = () => ({
      db,
      llm,
      exec: (t) => directExec({ booking: bd, pay: pd }, t, { source: "chat", phone: null, callId: null, aiSessionId: null }),
      services: async (id) => (await booking.getSettings(db, id)).services,
    });
  });
  after(async () => void (await db?.end()));

  it("ayarlar: akış şart, açıkken site adresi şart, anahtar sabit", async () => {
    await assert.rejects(chat.saveWidget(db, tenant, { flow: "yok" }), /akışı/);
    await assert.rejects(chat.saveWidget(db, tenant, { flow: "karsilama", enabled: true }), /site adresi/);
    const w = await chat.saveWidget(db, tenant, { flow: "karsilama", enabled: true, origins: ["denizturizm.com", "https://denizturizm.com/"], contactPhone: "0252 612 00 00", color: "#0E7C66" });
    assert.deepEqual(w.origins, ["https://denizturizm.com"]);
    assert.equal(w.contactPhone, "+902526120000");
    assert.equal(w.color, "#0e7c66");
    assert.match(w.publicKey, /^wk_[a-z0-9]{24}$/);
    const w2 = await chat.saveWidget(db, tenant, { title: "Rezervasyon" });
    assert.equal(w2.publicKey, w.publicKey);
    assert.equal(w2.enabled, true);
  });

  it("kapalı pencere ya da kapalı akış yüklenmez", async () => {
    const w = await chat.saveWidget(db, other, { flow: "karsilama" });
    assert.equal(await chat.loadByKey(db, w.publicKey), null);
    assert.equal(await chat.loadByKey(db, "wk_" + "a".repeat(24)), null);
    assert.equal(await chat.loadByKey(db, "../x"), null);
    const mine = (await chat.getWidget(db, tenant.id))!;
    await db.query("UPDATE ai_flows SET enabled = false WHERE tenant_id = $1", [tenant.id]);
    assert.equal(await chat.loadByKey(db, mine.publicKey), null);
    await db.query("UPDATE ai_flows SET enabled = true WHERE tenant_id = $1", [tenant.id]);
    assert.ok(await chat.loadByKey(db, mine.publicKey));
  });

  it("rezervasyon: telefon alanı eklenir, ödeme bağlantısı ekranda, numara modele verilmez", async () => {
    const l = (await chat.loadByKey(db, (await chat.getWidget(db, tenant.id))!.publicKey))!;
    const { token, greeting } = await chat.start(db, l, "203.0.113.5", "https://denizturizm.com/transfer");
    assert.equal(greeting, "Merhaba, " + tenant.name + " hoş geldiniz. Size nasıl yardımcı olabilirim?");
    const req = { service: "transfer", fields: { tarih: "2026-12-01", telefon: "0532 111 22 33" }, payNow: true, customerName: "Ayşe" };
    script = [D("quote", "Bakıyorum.", req), D("say", "85 EUR, onaylıyor musunuz?")];
    const r1 = await chat.message(deps(), l, token, "1 Aralık transfer, 0532 111 22 33");
    assert.equal(r1.reply, "85 EUR, onaylıyor musunuz?");
    assert.equal(r1.booking, null);
    script = [D("book", "Oluşturuyorum.", req), D("say", "Rezervasyonunuz alındı.")];
    const r2 = await chat.message(deps(), l, token, "Evet");
    assert.match(r2.booking!.reference, /^RZ/);
    assert.match(r2.booking!.paymentUrl!, /\/api\/payments\/test-page\/pay_/);
    assert.ok(!seen.at(-1)!.includes("http"), "ödeme adresi modele verilmez");
    assert.match(seen.at(-1)!, /Numara: RZ[A-Z0-9]{8}\./);
    const b = (await db.query("SELECT phone, source FROM bookings WHERE public_ref = $1", [r2.booking!.reference])).rows[0];
    assert.deepEqual(b, { phone: "+905321112233", source: "chat" });
    // Aynı sohbette ikinci rezervasyon yok (araç durumu saklanır).
    script = [D("book", "", req), D("say", "Ekibimiz yardımcı olacak.")];
    await chat.message(deps(), l, token, "bir tane daha");
    assert.match(seen.at(-1)!, /zaten bir rezervasyon/);
  });

  it("ekibe devretme: durum, iletişim seçenekleri, webhook; sonra mesaj işlenmez", async () => {
    const l = (await chat.loadByKey(db, (await chat.getWidget(db, tenant.id))!.publicKey))!;
    const { token } = await chat.start(db, l, "203.0.113.6", null);
    script = [D("transfer", "Ekibimiz size dönecek.", null, "Grup transferi fiyatı istiyor, Ali 05321234567")];
    const r = await chat.message(deps(), l, token, "20 kişilik grup için fiyat");
    assert.equal(r.status, "handoff");
    assert.deepEqual(r.contact, { phone: "+902526120000", whatsapp: null });
    const ev = (await db.query("SELECT payload FROM webhook_deliveries WHERE tenant_id = $1 AND type = 'chat.handoff'", [tenant.id])).rows;
    assert.equal(ev.length, 1);
    assert.match(ev[0].payload.data.summary, /Grup transferi/);
    const again = await chat.message(deps(), l, token, "merhaba?");
    assert.match(again.reply, /sona erdi/);
    const [row] = await chat.listSessions(db, tenant.id);
    assert.equal(row.status, "handoff");
    assert.equal(row.firstMessage, "20 kişilik grup için fiyat");
    const d = await chat.getSession(db, tenant.id, row.id);
    assert.equal(d.history[0].role, "assistant");
    await assert.rejects(chat.getSession(db, other.id, row.id), /bulunamadı/);
  });

  it("belirteç ve kiracı ayrımı, mesaj sınırları", async () => {
    const l = (await chat.loadByKey(db, (await chat.getWidget(db, tenant.id))!.publicKey))!;
    await assert.rejects(chat.message(deps(), l, "cs_yanlis", "selam"), /bulunamadı/);
    const { token } = await chat.start(db, l, "203.0.113.7", null);
    await assert.rejects(chat.message(deps(), l, token, "  "), /boş/);
    await assert.rejects(chat.message(deps(), l, token, "x".repeat(1001)), /1000/);
    const ow = await chat.saveWidget(db, other, { flow: "karsilama", enabled: true, origins: ["https://baska.com"] });
    const lo = (await chat.loadByKey(db, ow.publicKey))!;
    await assert.rejects(chat.message(deps(), lo, token, "selam"), /bulunamadı/);
    await db.query("UPDATE chat_sessions SET messages = 40 WHERE token_hash = sha256($1::text::bytea)", [token]);
    const r = await chat.message(deps(), l, token, "selam");
    assert.equal(r.status, "limit");
    await assert.rejects(chat.message({ ...deps(), llm: null }, l, (await chat.start(db, l, "203.0.113.8", null)).token, "selam"), /kullanılamıyor/);
  });

  it("IP başına saatte 20 sohbet, işletme günlük sınırı", async () => {
    const l = (await chat.loadByKey(db, (await chat.getWidget(db, tenant.id))!.publicKey))!;
    const ip = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    await db.query("DELETE FROM chat_sessions WHERE ip = $1", [ip]);
    for (let i = 0; i < 20; i++) await chat.start(db, l, ip, null);
    await assert.rejects(chat.start(db, l, ip, null), /çok fazla/);
    await chat.saveWidget(db, tenant, { dailyLimit: 10 });
    const l2 = (await chat.loadByKey(db, l.widget.publicKey))!;
    await db.query("DELETE FROM chat_sessions WHERE tenant_id = $1 AND ip LIKE '203.0.113.%'", [tenant.id]);
    await assert.rejects(chat.start(db, l2, "192.0.2.10", null), /kullanılamıyor/);
    await chat.saveWidget(db, tenant, { dailyLimit: 300 });
  });
});
