// Santralio: kimlik doğrulama, kiracı kapsamı ve rol yetkileri testleri.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appsFor, can, hashPassword, inScope, tenantScope, verifyPassword, type User } from "../src/auth.ts";
import { ALL_PERMISSIONS, DEFAULT_ROLES, type Permission } from "../src/permissions.ts";

const user = (over: Partial<User>): User => ({
  id: 1,
  email: "x@example.com",
  name: "",
  role: "tenant_user",
  reseller_id: null,
  tenant_id: null,
  extension_id: null,
  role_id: null,
  role_name: null,
  permissions: [],
  ...over,
});
const staff = (tenant: number, permissions: Permission[], extension: number | null = null) =>
  user({ role: "tenant_user", tenant_id: tenant, role_id: 9, extension_id: extension, permissions });

// İki bayi: Platform (1) altında t1, Bayi A (2) altında t2 ve t3.
const t1 = { id: 1, reseller_id: 1 };
const t2 = { id: 2, reseller_id: 2 };
const t3 = { id: 3, reseller_id: 2 };

test("platform yöneticisi her kiracıda her yetkiye sahip", () => {
  const u = user({ role: "platform_admin", permissions: ALL_PERMISSIONS });
  for (const t of [t1, t2, t3]) assert.ok(can(u, t, "settings.manage"));
});

test("bayi yöneticisi yalnızca kendi bayisinin kiracılarında", () => {
  const u = user({ role: "reseller_admin", reseller_id: 2, permissions: ALL_PERMISSIONS });
  assert.ok(can(u, t2, "settings.manage") && can(u, t3, "staff.manage"));
  assert.ok(!can(u, t1) && !inScope(u, t1));
});

test("bayisi olmayan bayi yöneticisi hiçbir kiracıda değil", () => {
  const u = user({ role: "reseller_admin", reseller_id: null, permissions: ALL_PERMISSIONS });
  for (const t of [t1, t2, t3]) assert.ok(!can(u, t));
});

test("kiracı kullanıcısı yalnızca kendi kiracısında ve yalnızca rolündeki yetkilerle", () => {
  const u = staff(2, ["calls.all", "reports.view"]);
  assert.ok(can(u, t2, "reports.view"));
  assert.ok(can(u, t2, "settings.manage", "calls.all"), "yetkilerden biri yeterli");
  assert.ok(!can(u, t2, "settings.manage"));
  assert.ok(!can(u, t2, "recordings.listen"));
  assert.ok(!can(u, t3, "reports.view"), "başka kiracı");
});

test("yetkisiz rol hiçbir uca erişemez ama kiracı kapsamındadır", () => {
  const u = staff(1, []);
  assert.ok(inScope(u, t1));
  for (const p of ALL_PERMISSIONS) assert.ok(!can(u, t1, p));
});

test("açılabilecek adresler yetkiye göre; temsilci masası dahili ister", () => {
  assert.deepEqual(appsFor(staff(1, ["agent.desk", "calls.own"], 5)), ["crm", "agent"]);
  assert.deepEqual(appsFor(staff(1, ["agent.desk", "calls.own"], null)), ["crm"]);
  assert.deepEqual(appsFor(staff(1, ["settings.manage"])), ["panel"]);
  assert.deepEqual(appsFor(staff(1, ALL_PERMISSIONS, 5)), ["panel", "crm", "agent"]);
  assert.deepEqual(appsFor(user({ role: "platform_admin", permissions: ALL_PERMISSIONS })), ["panel", "crm"]);
});

test("başlangıç rolleri: Patron her şey, Temsilci yönetemez", () => {
  const patron = DEFAULT_ROLES.find((r) => r.name === "Patron")!;
  const temsilci = DEFAULT_ROLES.find((r) => r.name === "Temsilci")!;
  assert.deepEqual([...patron.permissions].sort(), [...ALL_PERMISSIONS].sort());
  assert.ok(!temsilci.permissions.includes("settings.manage") && !temsilci.permissions.includes("calls.all"));
});

test("liste kapsamı role göre daralır", () => {
  assert.equal(tenantScope(user({ role: "platform_admin" })).where, "true");
  assert.deepEqual(tenantScope(user({ role: "reseller_admin", reseller_id: 2 })), { where: "t.reseller_id = $1", params: [2] });
  assert.deepEqual(tenantScope(staff(3, [])), { where: "t.id = $1", params: [3] });
});

test("scrypt: doğru şifre geçer, yanlış şifre ve kısa şifre geçmez", async () => {
  const h = await hashPassword("doğru-şifre-123");
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(await verifyPassword("doğru-şifre-123", h));
  assert.ok(!(await verifyPassword("dogru-sifre-123", h)));
  await assert.rejects(hashPassword("kısa"));
});
