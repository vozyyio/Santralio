// Panelden kurulum testleri (test veritabanı): operatör hattı (iç ağ, şifre saklama), kuyruk, numara, kurulum adımları.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test CREDENTIALS_DIRECTORY=… node --test tests/setup.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PG_DATABASE } from "../src/config.ts";

const TEST_DB = process.env.SANTRALIO_TEST_DB;
describe("Kurulum", { skip: (!TEST_DB || !process.env.CREDENTIALS_DIRECTORY) && "SANTRALIO_TEST_DB / CREDENTIALS_DIRECTORY yok" }, () => {
  let db: any;
  let ops: typeof import("../src/ops.ts");
  let setup: typeof import("../src/setup.ts");
  let t: any;
  let other: any;
  const pub = async () => ["185.88.7.40"];
  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    ops = await import("../src/ops.ts");
    setup = await import("../src/setup.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0]?.id ?? (await db.query("INSERT INTO resellers (name) VALUES ('test') RETURNING id")).rows[0].id;
    t = await ops.tenantByPrefix(db, (await ops.createTenant(db, "Kurulum Otel " + randomBytes(2).toString("hex"), reseller)).prefix);
    other = await ops.tenantByPrefix(db, (await ops.createTenant(db, "Diğer Otel " + randomBytes(2).toString("hex"), reseller)).prefix);
  });
  after(async () => void (await db?.end()));

  it("operatör hattı: biçim, iç ağ, şifre şart; güncellemede şifre korunur", async () => {
    const base = { operator: "netgsm", server: "sip.netgsm.com.tr", username: "8508401234" };
    await assert.rejects(ops.setTrunk(db, t, { ...base, password: "x" }, "test", async () => ["10.0.0.5"]), /iç ağ/);
    await assert.rejects(ops.setTrunk(db, t, { ...base, server: "localhost", password: "x" }, "test", pub), /sunucu/);
    await assert.rejects(ops.setTrunk(db, t, { ...base, password: "" }, "test", pub), /şifre gerekli/);
    await assert.rejects(ops.setTrunk(db, t, { ...base, password: "a;b" }, "test", pub), /içeremez/);
    await assert.rejects(ops.setTrunk(db, t, { ...base, port: 80, password: "x" }, "test", pub), /port/);
    await assert.rejects(ops.setTrunk(db, t, { ...base, password: "x" }, "test", async () => []), /çözülemedi/);
    await ops.setTrunk(db, t, { ...base, password: "Gizli-123" }, "test", pub);
    const first = (await db.query("SELECT secret_enc, contact_token FROM trunks WHERE tenant_id = $1", [t.id])).rows[0];
    assert.ok(!first.secret_enc.toString("latin1").includes("Gizli-123"));
    await ops.setTrunk(db, t, { ...base, username: "8508409999", password: null }, "test", pub);
    const second = (await db.query("SELECT secret_enc, contact_token, username FROM trunks WHERE tenant_id = $1", [t.id])).rows[0];
    assert.deepEqual(second.secret_enc, first.secret_enc);
    assert.equal(second.contact_token, first.contact_token);
    assert.equal(second.username, "8508409999");
    const a = (await db.query("SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'trunk.set' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.ok(!JSON.stringify(a).includes("Gizli"));
  });

  it("kuyruk ve numara", async () => {
    await assert.rejects(ops.addQueue(db, t, { name: "Rezervasyon" }), /küçük harf/);
    await ops.addQueue(db, t, { name: "rezervasyon", number: "8001" });
    await assert.rejects(ops.addQueue(db, t, { name: "rezervasyon" }), /zaten/);
    await assert.rejects(ops.addQueue(db, t, { name: "x", ringS: 1 }), /çalma/);
    await assert.rejects(ops.addEntryPoint(db, t, "0850 123", "queue:rezervasyon"), /ülke kodu/);
    await assert.rejects(ops.addEntryPoint(db, t, "08501234567", "queue:yok"), Error);
    const n = "0850" + String(Math.floor(1000000 + Math.random() * 8999999));
    const a = await ops.addEntryPoint(db, t, n.replace(/(\d{4})(\d{3})/, "$1 $2 "), "queue:rezervasyon");
    assert.equal(a, "90" + n.slice(1));
    const ep = (await db.query("SELECT trunk_id FROM entry_points WHERE address = $1", [a])).rows[0];
    assert.ok(ep.trunk_id);
    await ops.addQueue(db, other, { name: "genel" });
    await assert.rejects(ops.addEntryPoint(db, other, a, "queue:genel"), /eklenemiyor/);
  });

  it("kurulum adımları veriden hesaplanır", async () => {
    let s = await setup.steps(db, t.id, false);
    const by = (id: string) => s.find((x) => x.id === id)!;
    assert.equal(by("trunk").done, false); // kayıtlı değil
    assert.match(by("trunk").detail, /kayıtlı değil/);
    assert.equal(by("number").done, true);
    assert.equal(by("queues").done, false); // üye yok
    assert.ok(!s.some((x) => x.id === "chat")); // yapay zekâ kapalı
    await db.query("INSERT INTO licenses (tenant_id, source, active, max_extensions, max_channels) VALUES ($1, 'manual', true, 10, 4)", [t.id]);
    await ops.addExtension(db, t, "1001", "Ayşe");
    await ops.setQueueMembers(db, t, "rezervasyon", ["1001"]);
    await db.query("UPDATE tenants SET ai_enabled = true WHERE id = $1", [t.id]);
    s = await setup.steps(db, t.id, true);
    assert.ok(s.filter((x) => x.required).every((x) => x.done));
    assert.ok(s.some((x) => x.id === "chat"));
  });
});
