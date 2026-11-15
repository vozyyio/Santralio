// API anahtarı testleri (test veritabanı): verilebilecek yetkiler, oluşturanın yetkisi, tek gösterim/özet saklama,
// anahtardan kullanıcı, iptal, askıdaki kiracı, hız sınırı.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/apikeys.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { rateLimited } from "../src/apikeys.ts";
import { PG_DATABASE } from "../src/config.ts";

describe("API anahtarı: hız sınırı", () => {
  it("dakikada 300", () => {
    const id = 987654;
    for (let i = 0; i < 300; i++) assert.equal(rateLimited(id, 1000), false);
    assert.equal(rateLimited(id, 1000), true);
    assert.equal(rateLimited(id, 62_000), false);
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;
describe("API anahtarı: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB yok" }, () => {
  let db: any;
  let k: typeof import("../src/apikeys.ts");
  let tenant: any;
  const boss: any = { email: "patron@ornek.com", permissions: ["settings.manage", "calls.all", "crm.use", "bookings.manage", "payments.request", "reports.view"] };
  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    k = await import("../src/apikeys.ts");
    const ops = await import("../src/ops.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0]?.id ?? (await db.query("INSERT INTO resellers (name) VALUES ('test') RETURNING id")).rows[0].id;
    tenant = await ops.createTenant(db, "Anahtar Otel " + randomBytes(2).toString("hex"), reseller);
  });
  after(async () => void (await db?.end()));

  it("yetki kuralları", async () => {
    await assert.rejects(k.createKey(db, tenant.id, boss, { name: "", permissions: ["crm.use"] }), /ad/);
    await assert.rejects(k.createKey(db, tenant.id, boss, { name: "x", permissions: [] }), /en az bir/);
    await assert.rejects(k.createKey(db, tenant.id, boss, { name: "x", permissions: ["settings.manage"] }), /verilemez/);
    await assert.rejects(k.createKey(db, tenant.id, boss, { name: "x", permissions: ["recordings.listen"] }), /sizde olmayan/);
  });

  it("anahtar bir kez döner, özeti saklanır; kullanıcıya dönüşür; iptal ve askı", async () => {
    const { id, key } = await k.createKey(db, tenant.id, boss, { name: "Otel yazılımı", permissions: ["crm.use", "bookings.manage", "crm.use"] });
    assert.match(key, /^sk_[a-z0-9]{36}$/);
    const raw = (await db.query("SELECT * FROM api_keys WHERE id = $1", [id])).rows[0];
    assert.ok(!JSON.stringify(raw).includes(key));
    assert.equal(raw.key_prefix, key.slice(0, 11));
    const [row] = await k.listKeys(db, tenant.id);
    assert.deepEqual(row.permissions, ["crm.use", "bookings.manage"]);
    assert.equal(row.lastUsedAt, null);
    const u = (await k.userByApiKey(db, key))!;
    assert.equal(u.tenant_id, tenant.id);
    assert.equal(u.role, "tenant_user");
    assert.deepEqual(u.permissions, ["crm.use", "bookings.manage"]);
    assert.equal(u.email, "apikey:Otel yazılımı");
    assert.ok((await k.listKeys(db, tenant.id))[0].lastUsedAt);
    assert.equal(await k.userByApiKey(db, key.slice(0, -1) + (key.endsWith("a") ? "b" : "a")), null);
    assert.equal(await k.userByApiKey(db, "sk_kisa"), null);
    // Elle eklenmiş yasak yetki etkisizdir.
    await db.query("UPDATE api_keys SET permissions = permissions || '{staff.manage}' WHERE id = $1", [id]);
    assert.ok(!(await k.userByApiKey(db, key))!.permissions.includes("staff.manage" as any));
    await db.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenant.id]);
    assert.equal(await k.userByApiKey(db, key), null);
    await db.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenant.id]);
    await k.revokeKey(db, tenant.id, id, "test");
    assert.equal(await k.userByApiKey(db, key), null);
    await assert.rejects(k.revokeKey(db, tenant.id, id, "test"), /bulunamadı/);
  });
});
