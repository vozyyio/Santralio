// "Sıranız gelince sizi arayalım" testleri.
// Birim: Asterisk "queue show" çözümleme, dialplan ve queues.conf üretimi.
// Uçtan uca (test veritabanı): talep → iş, sıra kuralı (önce girmiş bekleyen varsa beklenir), temsilci sayısı, kanal sınırı,
// bağlanma olayı, açmayınca tekrar ve "no_answer", süre aşımı, gizli numara, kapatılınca iptal, raporda sonuç.
//   SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/queuecb.test.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PG_DATABASE } from "../src/config.ts";
import { parseQueueShow, type QDialer, type QueueState } from "../src/queuecb.ts";
import { renderTenant, type TenantModel } from "../src/render.ts";

const SHOW = `t7_destek has 2 calls (max unlimited) in 'rrmemory' strategy (12s holdtime, 95s talktime), W:0, C:4, A:1, SL:0.0%, SL2:0.0% within 0s
   Members:
      1001 (Local/1001@t7-agent/n from hint:1001@t7-hints) (ringinuse disabled) (realtime) (Not in use) has taken 3 calls (last was 40 secs ago)
      1002 (Local/1002@t7-agent/n from hint:1002@t7-hints) (ringinuse disabled) (In use) has taken 1 calls (last was 10 secs ago)
      1003 (Local/1003@t7-agent/n from hint:1003@t7-hints) (ringinuse disabled) (paused:Mola) (Not in use) has taken 0 calls
      1004 (Local/1004@t7-agent/n from hint:1004@t7-hints) (ringinuse disabled) (Unavailable) has taken 0 calls
   Callers:
      1. PJSIP/t7_trunk-0000001a (wait: 1:05, prio: 0)
      2. PJSIP/t7_trunk-0000001b (wait: 0:12, prio: 0)
`.split("\n");

describe("Kuyruk geri araması: birim", () => {
  it("queue show: müsait üye (molada/erişilemez sayılmaz), bekleyen ve en uzun bekleme", () => {
    assert.deepEqual(parseQueueShow(SHOW), { available: 1, callers: 2, longestWaitS: 65 });
    assert.deepEqual(parseQueueShow(["t7_x has 0 calls (max unlimited) in 'ringall' strategy", "   No Members", "   No Callers"]), { available: 0, callers: 0, longestWaitS: 0 });
    assert.equal(parseQueueShow(["No such queue: 't7_yok'"]), null);
    // Asterisk 20 "queue show" gerçek çıktısı (renk kodlarıyla).
    const real = [
      "t7_destek has 0 calls (max unlimited) in 'rrmemory' strategy (0s holdtime, 0s talktime), W:0, C:0, A:0, SL:0.0%, SL2:0.0% within 0s",
      "   Members: ",
      "      1001 (Local/1001@t7-agent/n from hint:1001@t7-hints) (ringinuse disabled)\x1b[0m\x1b[0m\x1b[0m (\x1b[1;31;40mUnavailable\x1b[0m) has taken no calls yet",
      "      1002 (Local/1002@t7-agent/n from hint:1002@t7-hints) (ringinuse disabled)\x1b[0m\x1b[0m\x1b[0m (\x1b[1;32;40mNot in use\x1b[0m) has taken no calls yet",
      "   No Callers",
    ];
    assert.deepEqual(parseQueueShow(real), { available: 1, callers: 0, longestWaitS: 0 });
  });

  const model = (cb: boolean, trunk = true) =>
    ({
      id: 1,
      prefix: "t7",
      name: "Deniz",
      licensed: true,
      maxChannels: 4,
      trunk: trunk ? { operator: "netgsm", server: "sip.netgsm.com.tr", port: 5060, transport: "udp", username: "8508401234", secret: "x", contactToken: "abcdefabcdefabcd", enabled: true } : null,
      extensions: [{ number: "1001", displayName: "", secret: "s", enabled: true, paused: false }],
      queues: [{ name: "destek", number: null, strategy: "rrmemory", ringS: 20, maxWaitS: 300, members: [{ number: "1001", penalty: 0 }], callback: cb ? { offerAfterS: 45 } : null }],
      menus: [],
      schedules: [],
      entryPoints: [],
      recording: { enabled: false },
      outbound: null,
      pbxOpen: true,
      ai: null,
      callback: null,
    }) as unknown as TenantModel;

  it("dialplan ve queues.conf: teklif duyurusu, çıkış context'i, öncelikli geri dönüş", () => {
    const all = Object.values(renderTenant(model(true)) as unknown as Record<string, string>).join("\n");
    assert.match(all, /context=t7-qcb-destek/);
    assert.match(all, /periodic-announce=.*queue-destek-cboffer/);
    assert.match(all, /periodic-announce-frequency=45/);
    assert.match(all, /\[t7-qcb-destek\]\nexten => 1,1,/);
    assert.match(all, /SANTRALIO_QCB_REQUEST,\$\{QCBD\}/);
    assert.match(all, /Goto\(t7-queue-destek,s,join\)/);
    assert.match(all, /\[t7-qcb-out\]\nexten => qdestek,1,/);
    assert.match(all, /SANTRALIO_QCB_ANSWERED,\$\{QCBJOB\}/);
    assert.match(all, /Set\(QUEUE_PRIO=10\)/);
    assert.match(all, /same => n\(join\),Set\(CHANNEL\(musicclass\)=t7\)/);
    // Kapalıyken ya da hat yokken hiçbir şey üretilmez.
    for (const off of [model(false), model(true, false)]) {
      const s = Object.values(renderTenant(off) as unknown as Record<string, string>).join("\n");
      assert.doesNotMatch(s, /qcb/);
      assert.match(s, /periodic-announce-frequency=0/);
    }
  });
});

const TEST_DB = process.env.SANTRALIO_TEST_DB;

describe("Kuyruk geri araması: uçtan uca", { skip: !TEST_DB && "SANTRALIO_TEST_DB tanımlı değil" }, () => {
  let db: any;
  let q: typeof import("../src/queuecb.ts");
  let tenant: { id: number; prefix: string };
  let queueId = 0;
  const dialed: { dial: string; jobId: number; queue: string }[] = [];
  let state: QueueState | null = { available: 1, callers: 0, longestWaitS: 0 };
  let channels = 0;
  const dialer: QDialer = {
    async originate(o) {
      dialed.push({ dial: o.dial, jobId: o.jobId, queue: o.queue });
    },
    activeChannels: async () => channels,
    queueState: async () => state,
  };
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace("T", " ").replace("Z", "");
  const log = (callid: string, event: string, data1: string, t = ago(0), queue = `${tenant.prefix}_destek`) =>
    db.query("INSERT INTO queue_log (time, callid, queuename, agent, event, data1) VALUES ($1, $2, $3, 'NONE', $4, $5)", [t, callid, queue, event, data1]);
  const job = async (callid: string) => (await db.query("SELECT * FROM queue_callbacks WHERE tenant_id = $1 AND source_callid = $2", [tenant.id, callid])).rows[0];

  before(async () => {
    if (PG_DATABASE !== TEST_DB || !/_test$/.test(TEST_DB!)) throw new Error(`test veritabanı değil: ${PG_DATABASE}`);
    const { connect, migrate } = await import("../src/db.ts");
    db = await connect();
    await migrate(db, new URL("../migrations", import.meta.url).pathname);
    q = await import("../src/queuecb.ts");
    const ops = await import("../src/ops.ts");
    const reseller = (await db.query("SELECT id FROM resellers ORDER BY id LIMIT 1")).rows[0].id;
    tenant = await ops.createTenant(db, "Kuyruk " + randomBytes(2).toString("hex"), reseller);
    await db.query("INSERT INTO licenses (tenant_id, source, active, max_extensions, max_channels) VALUES ($1, 'manual', true, 10, 4)", [tenant.id]);
    queueId = (await db.query("INSERT INTO queues (tenant_id, name) VALUES ($1, 'destek') RETURNING id", [tenant.id])).rows[0].id;
    // Bu testin dışındaki kiracıların bekleyen işleri karışmasın.
    await db.query("UPDATE queue_callbacks SET status = 'cancelled' WHERE status IN ('waiting', 'dialing')");
    await q.scan(db); // imleci başlat
  });
  after(async () => void (await db?.end()));

  it("hat yokken açılamaz; hat varsa açılır, teklif metni 1 tuşunu söylemeli", async () => {
    await assert.rejects(q.saveSettings(db, tenant.id, "destek", { enabled: true }), /hat/);
    await db.query(
      "INSERT INTO trunks (tenant_id, operator, server, username, secret_enc, key_id, contact_token) VALUES ($1, 'netgsm', 'sip.netgsm.com.tr', '8508401234', '\\x00', 'k1', $2)",
      [tenant.id, randomBytes(8).toString("hex")],
    );
    await assert.rejects(q.saveSettings(db, tenant.id, "destek", { enabled: true, offerText: "Lütfen bekleyin." }), /1 tuşunu/);
    await assert.rejects(q.saveSettings(db, tenant.id, "destek", { enabled: true, offerAfterS: 5 }), /20-600/);
    const s = await q.saveSettings(db, tenant.id, "destek", { enabled: true, offerAfterS: 45 });
    assert.equal(s.enabled, true);
    await assert.rejects(q.getSettings(db, tenant.id, "yok"), /bulunamadı/);
  });

  it("talep: iş açılır, sıra kuyruğa ilk giriş zamanıdır; gizli/geçersiz numara 'failed'", async () => {
    await log("c1", "SANTRALIO_ENTER", "8508401234|05321112233", ago(120));
    await log("c1", "SANTRALIO_QCB_REQUEST", "05321112233", ago(60));
    await log("c2", "SANTRALIO_ENTER", "8508401234|+905324445566", ago(90));
    await log("c2", "SANTRALIO_QCB_REQUEST", "905324445566", ago(50));
    await log("c3", "SANTRALIO_QCB_REQUEST", "4420712345678", ago(40));
    const r = await q.scan(db);
    assert.deepEqual(r, { requested: 2, connected: 0 });
    const j1 = await job("c1");
    assert.deepEqual([j1.status, j1.phone], ["waiting", "+905321112233"]);
    assert.ok(Math.abs(j1.entered_at.getTime() - (Date.now() - 120_000)) < 5000);
    assert.equal((await job("c2")).phone, "+905324445566");
    assert.equal((await job("c3")).status, "failed");
    // Aynı olay ikinci kez işlenmez.
    assert.deepEqual(await q.scan(db), { requested: 0, connected: 0 });
  });

  it("sıra: kuyrukta talepten önce girmiş biri bekliyorsa aranmaz; temsilci yoksa aranmaz", async () => {
    state = { available: 1, callers: 1, longestWaitS: 300 }; // 5 dk bekleyen biri var: c1 (2 dk önce girdi) bekler
    assert.equal((await q.tick(db, dialer)).dialed, 0);
    state = { available: 0, callers: 0, longestWaitS: 0 };
    assert.equal((await q.tick(db, dialer)).dialed, 0);
    state = null; // Asterisk'e ulaşılamadı
    assert.equal((await q.tick(db, dialer)).dialed, 0);
  });

  it("temsilci boşalınca en önce gireni arar; bir temsilci için tek arama; kanal sınırı", async () => {
    channels = 4;
    state = { available: 2, callers: 0, longestWaitS: 0 };
    assert.equal((await q.tick(db, dialer)).dialed, 0);
    channels = 0;
    state = { available: 1, callers: 1, longestWaitS: 30 }; // 30 sn bekleyen var ama c1 daha önce girdi
    assert.equal((await q.tick(db, dialer)).dialed, 1);
    assert.deepEqual(dialed.at(-1), { dial: "05321112233", jobId: Number((await job("c1")).id), queue: "destek" });
    assert.equal((await job("c1")).status, "dialing");
    // Aynı temsilci için ikinci arama başlatılmaz (biri zaten aranıyor).
    assert.equal((await q.tick(db, dialer)).dialed, 0);
  });

  it("açınca bağlanma olayı işi 'connected' yapar; sonra sıradaki aranır", async () => {
    const id = (await job("c1")).id;
    await log("out1", "SANTRALIO_QCB_ANSWERED", String(id));
    assert.deepEqual(await q.scan(db), { requested: 0, connected: 1 });
    assert.equal((await job("c1")).status, "connected");
    state = { available: 1, callers: 0, longestWaitS: 0 };
    assert.equal((await q.tick(db, dialer)).dialed, 1);
    assert.equal(dialed.at(-1)!.dial, "05324445566");
  });

  it("açmazsa 2 dk sonra tekrar, 3 denemeden sonra 'no_answer'", async () => {
    state = { available: 1, callers: 0, longestWaitS: 0 };
    let now = new Date();
    for (let i = 1; i <= 3; i++) {
      now = new Date(now.getTime() + 100_000); // çaldırma + pay geçti
      await q.tick(db, dialer, now);
      const j = await job("c2");
      if (i < 3) {
        assert.equal(j.status, "waiting", `deneme ${i}`);
        now = new Date(j.next_at.getTime() + 1000);
        assert.equal((await q.tick(db, dialer, now)).dialed, 1);
      } else assert.equal(j.status, "no_answer");
    }
    assert.equal((await job("c2")).attempts, 3);
  });

  it("süresi içinde sıra gelmeyen talep 'expired'; kapatılınca bekleyenler iptal", async () => {
    await log("c4", "SANTRALIO_QCB_REQUEST", "05329990011", ago(10));
    await log("c5", "SANTRALIO_QCB_REQUEST", "05329990022", ago(5));
    await q.scan(db);
    await db.query("UPDATE queue_callbacks SET requested_at = now() - interval '3 hours' WHERE tenant_id = $1 AND source_callid = 'c4'", [tenant.id]);
    state = { available: 0, callers: 0, longestWaitS: 0 };
    await q.tick(db, dialer);
    assert.equal((await job("c4")).status, "expired");
    await q.saveSettings(db, tenant.id, "destek", { enabled: false });
    assert.equal((await job("c5")).status, "cancelled");
    const list = await q.listJobs(db, tenant.id);
    assert.ok(list.some((j: any) => j.status === "connected" && j.waitS !== null));
  });

  it("raporda 'geri arama istedi' olarak görünür, 'kapattı' sayılmaz", async () => {
    const reports = await import("../src/reports.ts");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
    const calls = await reports.listCalls(db, tenant.prefix, reports.parseRange(day, day));
    const c1 = calls.find((c) => c.callid === "c1")!;
    assert.equal(c1.outcome, "callback_requested");
    const s = await reports.summary(db, tenant.prefix, reports.parseRange(day, day));
    assert.ok((s.totals as any).callbackRequested >= 2);
    void queueId;
  });
});
