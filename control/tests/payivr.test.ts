// Santral ve yapay zekâ ödeme adımı (payment:<profil>) testleri.
// Birim: dialplan (soru, 1 ile talep, cep numarası denetimi, menü ve yapay zekâ yönlendirmesi).
// Uçtan uca (test veritabanı): hedef doğrulaması (temsilci tutarlı profil olmaz), talepten bağlantı oluşturma,
// tutarın profilden gelmesi, ai/ivr ayrımı, numara başına günlük sınır, kapalı kiracı.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/payivr.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PG_DATABASE } from "../src/config.ts";
import { renderTenant, type TenantModel } from "../src/render.ts";

const model = (payments: { name: string; dtmf: boolean }[]) =>
  ({
    id: 1,
    prefix: "t7",
    name: "Deniz",
    licensed: true,
    maxChannels: 4,
    trunk: null,
    extensions: [{ number: "1001", displayName: "", secret: "s", enabled: true, paused: false }],
    queues: [],
    menus: [{ name: "ana", timeoutS: 5, maxTries: 2, defaultTarget: null, options: [{ digit: "3", target: "payment:kapora" }, { digit: "4", target: "payment:yok" }] }],
    schedules: [],
    entryPoints: [],
    recording: { enabled: false },
    outbound: null,
    pbxOpen: true,
    callback: null,
    payments,
    ai: { enabled: true, flows: [{ name: "karsilama", enabled: true, routes: ["payment:kapora", "queue:yok"], defaultTarget: null }] },
  }) as unknown as TenantModel;
const conf = (m: TenantModel) => Object.values(renderTenant(m) as unknown as Record<string, string>).join("\n");

describe("Ödeme adımı: dialplan", () => {
  it("soru, 1 ile talep (tutar yok), cep numarası denetimi, menü ve yapay zekâ yönlendirmesi", () => {
    const s = conf(model([{ name: "kapora", dtmf: false }]));
    assert.match(s, /\[t7-pay-kapora\]\nexten => s,1,Answer\(\)/);
    assert.match(s, /Background\(.*pay-kapora-ask\)/);
    assert.match(s, /GotoIf\(\$\["\$\{PAYD:-10:1\}" != "5"\]\?nonum\)/);
    assert.match(s, /QueueLog\(t7_pay,\$\{PAYCALL\},NONE,SANTRALIO_PAY_REQUEST,kapora\|\$\{PAYD\}\|\$\{PAYBY\}\)/);
    assert.match(s, /ExecIf\(\$\["\$\{SANTRALIO_AI\}" != ""\]\?Set\(PAYBY=ai\)\)/);
    assert.match(s, /exten => 3,1,Goto\(t7-pay-kapora,s,1\)/);
    assert.doesNotMatch(s, /exten => 4,1,Goto/); // olmayan profil
    assert.match(s, /GotoIf\(\$\["\$\{ROUTE\}" = "payment:kapora"\]\?t7-pay-kapora,s,1\)/);
    // Tuşlama hazır değilken 2 seçeneği yok.
    assert.doesNotMatch(s, /pay-dtmf-soon/);
  });

  it("profil kullanılamıyorsa (sağlayıcı yok, kapalı) bağlam üretilmez ve menü seçeneği atlanır", () => {
    const s = conf(model([]));
    assert.doesNotMatch(s, /t7-pay-/);
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;

describe("Ödeme adımı: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB tanımlı değil" }, () => {
  let db: any;
  let tenant: { id: number; prefix: string; name: string; status: string; reseller_id: number };
  let ivr: typeof import("../src/payments/ivr.ts");
  let deps: any;
  const log = (callid: string, profile: string, digits: string, by = "ivr", prefix = tenant.prefix) =>
    db.query("INSERT INTO queue_log (time, callid, queuename, agent, event, data1, data2, data3) VALUES (now() AT TIME ZONE 'UTC', $1, $2, 'NONE', 'SANTRALIO_PAY_REQUEST', $3, $4, $5)", [
      callid,
      `${prefix}_pay`,
      profile,
      digits,
      by,
    ]);
  const reqs = async () => (await db.query("SELECT * FROM payment_requests WHERE tenant_id = $1 ORDER BY id", [tenant.id])).rows;

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    ivr = await import("../src/payments/ivr.ts");
    const ops = await import("../src/ops.ts");
    const svc = await import("../src/payments/service.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0].id;
    const t = await ops.createTenant(db, "Ödeme " + randomBytes(2).toString("hex"), reseller);
    await db.query("UPDATE tenants SET status = 'active' WHERE id = $1", [t.id]);
    tenant = (await db.query("SELECT id, prefix, name, status, reseller_id FROM tenants WHERE id = $1", [t.id])).rows[0];
    const key = randomBytes(32);
    deps = { db, keys: { key: () => key, currentId: "k1" }, fetch: (async () => new Response("{}")) as any, apiBase: "https://api.santralio.site", actor: "test" };
    await svc.saveProvider(deps, tenant.id, { provider: "test", label: "Test", mode: "test", credentials: {}, isDefault: true });
    await svc.saveProfile(deps, tenant.id, { name: "kapora", title: "Oda kaporası", amountSource: "fixed", fixedAmount: "500", maxAmount: "500" });
    await svc.saveProfile(deps, tenant.id, { name: "serbest", title: "Serbest tutar", amountSource: "agent", maxAmount: "10000" });
    await ivr.scan(deps); // imleci başlat
  });
  after(async () => void (await db?.end()));

  it("hedef doğrulaması: temsilci tutarlı ya da olmayan profil santral adımı olamaz", async () => {
    const ops = await import("../src/ops.ts");
    await ops.assertTarget(db, tenant, "payment:kapora");
    await assert.rejects(ops.assertTarget(db, tenant, "payment:serbest"), /temsilci/);
    await assert.rejects(ops.assertTarget(db, tenant, "payment:yok"), /profili yok/);
    const { payableProfiles } = await import("../src/apply.ts");
    assert.deepEqual(await payableProfiles(db, tenant.id), ["kapora"]);
  });

  it("talep: tutar profilden, numara cep numarası, ai/ivr ayrımı", async () => {
    await log("p1", "kapora", "905321112233", "ivr");
    await log("p2", "kapora", "5447778899", "ai");
    const r = await ivr.scan(deps);
    assert.equal(r.sent + r.failed, 2);
    const rows = await reqs();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((x: any) => [x.amount, x.phone, x.created_by, x.call_id]),
      [
        ["500.00", "+905321112233", "ivr", "p1"],
        ["500.00", "+905447778899", "ai", "p2"],
      ],
    );
    // Aynı olay ikinci kez işlenmez.
    assert.deepEqual(await ivr.scan(deps), { sent: 0, skipped: 0, failed: 0 });
  });

  it("aynı numaraya günde en fazla 3; geçersiz profil ve başka kiracı atlanır", async () => {
    for (const c of ["p3", "p4", "p5"]) await log(c, "kapora", "905321112233");
    await log("p6", "serbest", "905329998877");
    await log("p7", "kapora", "905329998877", "ivr", "t99999");
    const r = await ivr.scan(deps);
    assert.equal(r.skipped, 2); // p5 (sınır) + p7 (kiracı yok)
    assert.equal(r.failed, 1); // p6: temsilci tutarlı profil reddedilir
    const mine = (await reqs()).filter((x: any) => x.phone === "+905321112233");
    assert.equal(mine.length, 3);
    const lim = (await db.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'payments.ivr.limited'", [tenant.id])).rowCount;
    assert.equal(lim, 1);
  });
});
