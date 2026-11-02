// Santralio: konfigürasyon üretici ve şifreleme testleri. Çalıştırma: npm test

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { aad, open, randomToken, seal } from "../src/crypto.ts";
import { didVariants, renderTenant, type TenantModel } from "../src/render.ts";

function tenant(id: number, over: Partial<TenantModel> = {}): TenantModel {
  return {
    id,
    prefix: `t${id}`,
    name: `Test ${id}`,
    licensed: true,
    maxChannels: 4,
    trunk: {
      operator: "netgsm",
      server: "sip.example.net",
      port: 5060,
      transport: "udp",
      username: `85000000${id}`,
      secret: `trunk-secret-${id}`,
      contactToken: `token${id}aaaaaaaaaaaaaaaa`,
      enabled: true,
    },
    extensions: [
      { number: "1001", displayName: "Ayşe", secret: `ext-secret-${id}-1001`, enabled: true },
      { number: "1002", displayName: "", secret: `ext-secret-${id}-1002`, enabled: true },
    ],
    queues: [
      {
        name: "destek",
        number: "8001",
        strategy: "rrmemory",
        ringS: 20,
        maxWaitS: 300,
        members: [
          { number: "1001", penalty: 0 },
          { number: "1002", penalty: 0 },
        ],
      },
    ],
    entryPoints: [{ address: `90850000000${id}`, flow: "queue:destek", enabled: true }],
    ...over,
  };
}

// Bir kiracının çıktısında geçen her nesne, context ve kuyruk adı.
function names(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\[([^\]]+)\]/gm)) out.add(m[1]);
  for (const m of text.matchAll(/(?:context|aors|auth|outbound_auth|endpoint|musicclass)=([^\s,]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/PJSIP\/([a-z0-9_]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?:Goto|GotoIf)\(([^,()$]+),/g)) out.add(m[1]);
  for (const m of text.matchAll(/Queue\(([^,)]+)/g)) out.add(m[1]);
  return [...out];
}

const SHARED = new Set(["reject", "santralio-lib"]);

test("kiracı çıktısı yalnızca kendi önekli nesnelerine başvurur", () => {
  for (const id of [1, 2]) {
    const files = renderTenant(tenant(id));
    for (const [file, text] of Object.entries(files)) {
      for (const n of names(text)) {
        if (SHARED.has(n)) continue;
        assert.ok(n.startsWith(`t${id}_`) || n.startsWith(`t${id}-`) || n === `t${id}`, `${file}: t${id} dışı ad: ${n}`);
      }
    }
  }
});

test("bir kiracının şifreleri başka kiracının çıktısında geçmez", () => {
  const t1 = Object.values(renderTenant(tenant(1))).join("\n");
  assert.ok(t1.includes("trunk-secret-1"));
  assert.ok(!t1.includes("trunk-secret-2"));
  assert.ok(!t1.includes("ext-secret-2-"));
});

test("dahililerin context'i kendi kiracısının internal context'idir", () => {
  const pjsip = renderTenant(tenant(1))["pjsip.conf"];
  assert.match(pjsip, /\[t1_1001\]\ntype=endpoint\ncontext=t1-internal\n/);
  assert.match(pjsip, /\[t1_trunk\]\ntype=endpoint\ntransport=transport-udp\ncontext=t1-inbound\n/);
  assert.ok(!/context=(default|reject)/.test(pjsip));
});

test("trunk kaydı line=yes ve kiracıya özel contact token ile yapılır", () => {
  const pjsip = renderTenant(tenant(1))["pjsip.conf"];
  assert.match(pjsip, /line=yes\nendpoint=t1_trunk\n/);
  assert.match(pjsip, /contact_user=token1a+\n/);
  assert.match(pjsip, /match_request_uri=\/\^sips\?:token1a+@\/\n/);
});

test("internal context dış arama içermez, eşleşmeyen numara reject'e düşer", () => {
  const ext = renderTenant(tenant(1))["extensions.conf"];
  const internal = ext.slice(ext.indexOf("[t1-internal]"));
  assert.ok(!internal.includes("t1_trunk"));
  assert.match(internal, /exten => _\[\+\*#0-9a-zA-Z\]\.,1,Goto\(reject,s,1\)/);
});

test("DID her biçimde aynı kuyruğa gider", () => {
  assert.deepEqual(didVariants("908501234567"), ["908501234567", "08501234567", "8501234567"]);
  const ext = renderTenant(tenant(1, { entryPoints: [{ address: "908501234567", flow: "queue:destek", enabled: true }] }))[
    "extensions.conf"
  ];
  for (const d of ["908501234567", "08501234567", "8501234567"]) {
    assert.ok(ext.includes(`exten => ${d},1,Goto(t1-queue-destek,s,1)`), d);
  }
});

test("lisansı olmayan kiracı için hiçbir nesne üretilmez", () => {
  const files = renderTenant(tenant(1, { licensed: false }));
  for (const text of Object.values(files)) {
    assert.ok(!/^\[/m.test(text), "nesne üretilmiş");
    assert.ok(!text.includes("trunk-secret-1"));
  }
});

test("ayar dosyasını bozacak şifre reddedilir", () => {
  const bad = tenant(1);
  bad.trunk!.secret = "abc\n[t2_1001]";
  assert.throws(() => renderTenant(bad), /izin verilmeyen/);
});

test("AES-GCM: doğru satırda açılır, başka satırda açılmaz", () => {
  const key = randomBytes(32);
  const s = seal("gizli", aad.trunk(1), key, "k1");
  assert.equal(open(s.enc, aad.trunk(1), key), "gizli");
  assert.throws(() => open(s.enc, aad.trunk(2), key));
  assert.throws(() => open(s.enc, aad.trunk(1), randomBytes(32)));
});

test("randomToken istenen uzunlukta ve alfabede", () => {
  const t = randomToken(24);
  assert.equal(t.length, 24);
  assert.match(t, /^[a-z2-9]+$/);
});
