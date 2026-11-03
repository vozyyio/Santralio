// Santralio: dış arama politikası testleri. Bu kurallar doğrudan ücretle ilgilidir.

import assert from "node:assert/strict";
import { test } from "node:test";
import { allowed, dialPatterns, normalizeNumber, TEMPLATES, validatePolicy, type Policy } from "../src/outbound.ts";

const tpl = (name: string): Policy => ({ template: name, ...TEMPLATES[name].policy });

test("hiçbir şablonda özel ücretli ve kısa numaralar aranamaz", () => {
  for (const name of Object.keys(TEMPLATES)) {
    const p = tpl(name);
    for (const n of ["09001234567", "08981234567", "08221234567", "112", "155", "11880", "0090212345678"]) {
      assert.ok(!allowed(p, n), `${name}: ${n} açık olmamalı`);
    }
  }
});

test("yalnızca gelen arama şablonunda hiçbir numara aranamaz", () => {
  const p = tpl("inbound_only");
  assert.deepEqual(dialPatterns(p), []);
  assert.ok(!allowed(p, "05321234567"));
});

test("acente: yurt içi açık, yurt dışı kapalı", () => {
  const p = tpl("agency");
  for (const n of ["05321234567", "02121234567", "03121234567", "04621234567", "08501234567", "4441234", "08001234567"]) assert.ok(allowed(p, n), n);
  for (const n of ["00491711234567", "00447911123456"]) assert.ok(!allowed(p, n), n);
});

test("sağlık turizmi: yalnızca listedeki ülkeler", () => {
  const p = tpl("health_tourism");
  assert.ok(allowed(p, "00491711234567"), "Almanya");
  assert.ok(allowed(p, "00971501234567"), "BAE");
  assert.ok(!allowed(p, "0086138000000"), "Çin listede değil");
  assert.ok(!allowed(p, "0012025550123"), "+1 hiçbir şablonda yok");
});

test("Türkiye ve +1 yurt dışı listesine eklenemez; geçersiz kod reddedilir", () => {
  const base = tpl("agency");
  assert.throws(() => validatePolicy({ ...base, countries: ["90"] }));
  assert.throws(() => validatePolicy({ ...base, countries: ["1"] }));
  assert.throws(() => validatePolicy({ ...base, countries: ["0049"] }));
  assert.throws(() => validatePolicy({ ...base, dailyLimit: -1 }));
  assert.deepEqual(validatePolicy({ ...base, countries: ["49", "44", "49"] }).countries, ["44", "49"]);
});

test("numara biçimleri santralin beklediği biçime döner", () => {
  assert.equal(normalizeNumber("+90 532 123 45 67"), "05321234567");
  assert.equal(normalizeNumber("905321234567"), "05321234567");
  assert.equal(normalizeNumber("532 123 45 67"), "05321234567");
  assert.equal(normalizeNumber("(0212) 123-45-67"), "02121234567");
  assert.equal(normalizeNumber("+49 171 1234567"), "00491711234567");
  assert.equal(normalizeNumber("0090 532 123 45 67"), "05321234567");
  assert.equal(normalizeNumber("1001"), "1001");
  assert.equal(normalizeNumber("abc"), null);
});
