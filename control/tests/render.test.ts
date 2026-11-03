// Santralio: konfigürasyon üretici ve şifreleme testleri. Çalıştırma: npm test

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { aad, open, randomToken, seal } from "../src/crypto.ts";
import { didVariants, renderTenant, timeRange, type TenantModel } from "../src/render.ts";

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
      { number: "1001", displayName: "Ayşe", secret: `ext-secret-${id}-1001`, enabled: true, paused: false },
      { number: "1002", displayName: "", secret: `ext-secret-${id}-1002`, enabled: true, paused: true },
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
    menus: [],
    schedules: [],
    recording: { enabled: false },
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
  for (const m of text.matchAll(/(?:Local\/|hint:)[0-9]+@([a-z0-9_-]+)/g)) out.add(m[1]);
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

test("menü: tuşlar yalnızca kendi kiracısının hedeflerine gider", () => {
  const t = tenant(1, {
    queues: [
      { name: "muhasebe", number: null, strategy: "ringall", ringS: 20, maxWaitS: 300, members: [{ number: "1001", penalty: 0 }] },
      { name: "diger", number: null, strategy: "ringall", ringS: 20, maxWaitS: 300, members: [{ number: "1002", penalty: 0 }] },
    ],
    menus: [
      {
        name: "ana",
        timeoutS: 5,
        maxTries: 3,
        defaultTarget: "queue:diger",
        options: [
          { digit: "1", target: "queue:muhasebe" },
          { digit: "2", target: "queue:diger" },
          { digit: "3", target: "queue:yok" },
        ],
      },
    ],
    entryPoints: [{ address: "908508404367", flow: "menu:ana", enabled: true }],
  });
  const ext = renderTenant(t)["extensions.conf"];
  assert.ok(ext.includes("exten => 908508404367,1,Goto(t1-menu-ana,s,1)"));
  assert.ok(ext.includes("exten => 1,1,Goto(t1-queue-muhasebe,s,1)"));
  assert.ok(ext.includes("exten => 2,1,Goto(t1-queue-diger,s,1)"));
  // Var olmayan kuyruğa giden tuş üretilmez.
  assert.ok(!ext.includes("exten => 3,1"));
  // Tuşlama olmazsa ya da geçersizse varsayılan hedefe gidilir.
  assert.match(ext, /exten => t,1,GotoIf\(\$\[\$\{TRIES\} < 3\]\?s,prompt\)\n same => n,Goto\(t1-queue-diger,s,1\)/);
  assert.ok(ext.includes("Background(/var/lib/asterisk/sounds/santralio/t1/menu-ana)"));
  for (const n of names(ext)) {
    if (SHARED.has(n)) continue;
    assert.ok(n.startsWith("t1_") || n.startsWith("t1-") || n === "t1" || n === "s", `t1 dışı ad: ${n}`);
  }
});

test("kuyruğa bağlanılamazsa olay yazılır, arayana anons çalınır, sonra kapatılır", () => {
  const ext = renderTenant(tenant(1))["extensions.conf"];
  const q = ext.slice(ext.indexOf("[t1-queue-destek]"));
  assert.ok(q.includes('GotoIf($[${REGEX("^(TIMEOUT|FULL|JOINEMPTY|LEAVEEMPTY|JOINUNAVAIL|LEAVEUNAVAIL)$" ${QUEUESTATUS})}]?failed)'));
  assert.match(q, /n\(failed\),QueueLog\([^\n]+\n same => n,Playback\(\/var\/lib\/asterisk\/sounds\/santralio\/t1\/queue-destek-unavailable\)\n same => n,Hangup\(16\)/);
});

test("çalışma saatleri: tatil önce, sonra aralıklar; mesai dışı kapalı anonsu", () => {
  const ext = renderTenant(
    tenant(1, {
      menus: [{ name: "ana", timeoutS: 5, maxTries: 3, defaultTarget: null, options: [] }],
      schedules: [
        {
          name: "mesai",
          timezone: "Europe/Istanbul",
          openTarget: "menu:ana",
          closedTarget: null,
          hours: [
            { weekdays: "mon-fri", opens: "09:00", closes: "12:30" },
            { weekdays: "mon-fri", opens: "13:30", closes: "18:00" },
          ],
          holidays: ["2026-10-29"],
        },
      ],
      entryPoints: [{ address: "908508404367", flow: "schedule:mesai", enabled: true }],
    }),
  )["extensions.conf"];
  assert.ok(ext.includes("exten => 908508404367,1,Goto(t1-schedule-mesai,s,1)"));
  const sc = ext.slice(ext.indexOf("[t1-schedule-mesai]"), ext.indexOf("[t1-menu-ana]"));
  const lines = sc.split("\n");
  const holiday = lines.findIndex((l) => l.includes('"2026-10-29"'));
  const firstRange = lines.findIndex((l) => l.includes("GotoIfTime"));
  assert.ok(holiday > 0 && holiday < firstRange, "tatil kontrolü aralıklardan önce olmalı");
  assert.ok(sc.includes("GotoIfTime(09:00-12:29,mon-fri,*,*,Europe/Istanbul?t1-menu-ana,s,1)"));
  assert.ok(sc.includes("GotoIfTime(13:30-17:59,mon-fri,*,*,Europe/Istanbul?t1-menu-ana,s,1)"));
  assert.ok(sc.includes("STRFTIME(${EPOCH},Europe/Istanbul,%F)"));
  assert.match(sc, /n\(closed\),Answer\(\)[\s\S]*Playback\(\/var\/lib\/asterisk\/sounds\/santralio\/t1\/schedule-mesai-closed\)\n same => n,Hangup\(16\)/);
});

test("timeRange kapanış dakikasını dışarıda bırakır", () => {
  assert.equal(timeRange("09:00", "18:00"), "09:00-17:59");
  assert.equal(timeRange("00:00", "00:01"), "00:00-00:00");
  assert.throws(() => timeRange("18:00", "09:00"));
  assert.throws(() => timeRange("9:00", "18:00"));
});

test("WebRTC: her dahilinin ayrı tarayıcı uç noktası var, arama iki cihazda birden çalar", () => {
  const f = renderTenant(tenant(1));
  assert.match(f["pjsip.conf"], /\[t1_1001_web\]\ntype=endpoint\ncontext=t1-internal\ndisallow=all\nallow=alaw,ulaw\nwebrtc=yes\n/);
  assert.match(f["pjsip.conf"], /\[t1_1001_web\]\ntype=auth\nauth_type=userpass\nusername=t1_1001_web\npassword=ext-secret-1-1001\n/);
  const ext = f["extensions.conf"];
  assert.ok(ext.includes("exten => 1001,1,Dial(PJSIP/t1_1001&PJSIP/t1_1001_web,,b(santralio-lib^agent-headers^1))"));
  assert.ok(ext.includes("exten => 1001,hint,PJSIP/t1_1001&PJSIP/t1_1001_web"));
  assert.ok(ext.includes("same => n,Dial(PJSIP/t1_1001&PJSIP/t1_1001_web,30)"));
});

test("kuyruk üyesi Local kanalı, durum hint'ten, mola veritabanından", () => {
  const q = renderTenant(tenant(1))["queues.conf"];
  assert.ok(q.includes("member => Local/1001@t1-agent/n,0,1001,hint:1001@t1-hints,no,,0"));
  assert.ok(q.includes("member => Local/1002@t1-agent/n,0,1002,hint:1002@t1-hints,no,,1"));
  assert.ok(!q.includes("PJSIP/"));
});

test("kayıt kapalıyken anons ve MixMonitor yok; olaylar yine de yazılır", () => {
  const ext = renderTenant(tenant(1))["extensions.conf"];
  const q = ext.slice(ext.indexOf("[t1-queue-destek]"), ext.indexOf("[t1-internal]"));
  assert.ok(!q.includes("recording-notice"));
  assert.ok(q.includes("Queue(t1_destek,t,,,300,,)"));
  assert.ok(q.includes("QueueLog(t1_destek,${UNIQUEID},NONE,SANTRALIO_ENTER,${SANTRALIO_DID}|${CALLERID(num)})"));
  assert.ok(q.includes("n(failed),QueueLog(t1_destek,${UNIQUEID},NONE,SANTRALIO_NOAGENT,${QUEUESTATUS})"));
});

test("kayıt açıkken anons çalar, kayıt temsilci açınca kendi kiracı dizinine yapılır", () => {
  const ext = renderTenant(tenant(1, { recording: { enabled: true } }))["extensions.conf"];
  const q = ext.slice(ext.indexOf("[t1-queue-destek]"), ext.indexOf("[t1-internal]"));
  const notice = q.indexOf("Playback(/var/lib/asterisk/sounds/santralio/t1/recording-notice)");
  assert.ok(notice > 0 && notice < q.indexOf("Queue(t1_destek"), "anons kuyruktan önce");
  assert.ok(q.includes("Set(__SANTRALIO_RECDIR=/var/lib/santralio/recordings/t1)"));
  assert.ok(q.includes("Queue(t1_destek,t,,,300,,santralio-record)"));
});

test("aktarma: her kuyruk kendi kiracısının internal context'inde q-<ad> ile aranabilir", () => {
  const ext = renderTenant(tenant(1))["extensions.conf"];
  const internal = ext.slice(ext.indexOf("[t1-internal]"), ext.indexOf("[t1-agent]"));
  assert.ok(internal.includes("exten => q-destek,1,Goto(t1-queue-destek,s,1)"));
  assert.ok(!internal.includes("t2"));
});
