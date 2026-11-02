// Santralio: kimlik doğrulama ve kiracı erişim kuralı testleri.

import assert from "node:assert/strict";
import { test } from "node:test";
import { canAccessTenant, hashPassword, tenantScope, verifyPassword, type User } from "../src/auth.ts";

const user = (over: Partial<User>): User => ({
  id: 1,
  email: "x@example.com",
  name: "",
  role: "agent",
  reseller_id: null,
  tenant_id: null,
  extension_id: null,
  ...over,
});

// İki bayi: Platform (1) altında t1, Bayi A (2) altında t2 ve t3.
const t1 = { id: 1, reseller_id: 1 };
const t2 = { id: 2, reseller_id: 2 };
const t3 = { id: 3, reseller_id: 2 };

test("platform yöneticisi her kiracıyı yönetir", () => {
  const u = user({ role: "platform_admin" });
  for (const t of [t1, t2, t3]) assert.ok(canAccessTenant(u, t, "admin"));
});

test("bayi yöneticisi yalnızca kendi bayisinin kiracılarını yönetir", () => {
  const u = user({ role: "reseller_admin", reseller_id: 2 });
  assert.ok(canAccessTenant(u, t2, "admin"));
  assert.ok(canAccessTenant(u, t3, "admin"));
  assert.ok(!canAccessTenant(u, t1, "admin"));
  assert.ok(!canAccessTenant(u, t1, "read"));
});

test("bayisi olmayan bayi yöneticisi hiçbir kiracıya erişemez", () => {
  const u = user({ role: "reseller_admin", reseller_id: null });
  for (const t of [t1, t2, t3]) assert.ok(!canAccessTenant(u, t, "read"));
});

test("kiracı yöneticisi yalnızca kendi kiracısını yönetir", () => {
  const u = user({ role: "tenant_admin", tenant_id: 2 });
  assert.ok(canAccessTenant(u, t2, "admin"));
  assert.ok(!canAccessTenant(u, t3, "admin"));
  assert.ok(!canAccessTenant(u, t1, "read"));
});

test("temsilci kendi kiracısını yalnızca okur, yönetemez", () => {
  const u = user({ role: "agent", tenant_id: 1, extension_id: 5 });
  assert.ok(canAccessTenant(u, t1, "read"));
  assert.ok(!canAccessTenant(u, t1, "admin"));
  assert.ok(!canAccessTenant(u, t2, "read"));
});

test("liste kapsamı role göre daralır", () => {
  assert.equal(tenantScope(user({ role: "platform_admin" })).where, "true");
  assert.deepEqual(tenantScope(user({ role: "reseller_admin", reseller_id: 2 })), { where: "t.reseller_id = $1", params: [2] });
  assert.deepEqual(tenantScope(user({ role: "tenant_admin", tenant_id: 3 })), { where: "t.id = $1", params: [3] });
});

test("scrypt: doğru şifre geçer, yanlış şifre ve kısa şifre geçmez", async () => {
  const h = await hashPassword("doğru-şifre-123");
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(await verifyPassword("doğru-şifre-123", h));
  assert.ok(!(await verifyPassword("dogru-sifre-123", h)));
  await assert.rejects(hashPassword("kısa"));
});
