// Canlı durum çözümleme ve birleştirme testleri (Asterisk 20.6 gerçek çıktıları ve tipik görüşme durumları).
//   node --test tests/live.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLive, parseConcise, parseQueue } from "../src/live.ts";

const E = "\x1b";
// Yerel Asterisk 20.6'dan alınan "queue show" çıktısı (renk kodlarıyla).
const REAL_QUEUE = [
  "t7_destek has 1 calls (max unlimited) in 'rrmemory' strategy (12s holdtime, 95s talktime), W:0, C:4, A:1, SL:0.0%, SL2:0.0% within 0s",
  "   Members: ",
  `      1001 (Local/1001@t7-agent/n from hint:1001@t7-hints) (ringinuse disabled)${E}[0m${E}[0m${E}[1;33;40m (in call)${E}[0m (${E}[1;32;40mNot in use${E}[0m) has taken no calls yet`,
  `      1002 (Local/1002@t7-agent/n from hint:1002@t7-hints) (ringinuse disabled)${E}[0m${E}[0m${E}[0m (${E}[1;32;40mIn use${E}[0m) has taken 2 calls`,
  `      1003 (Local/1003@t7-agent/n from hint:1003@t7-hints) (ringinuse disabled) (paused:Yemek) (${E}[1;32;40mNot in use${E}[0m) has taken 0 calls`,
  `      1004 (Local/1004@t7-agent/n from hint:1004@t7-hints) (ringinuse disabled) (${E}[1;31;40mUnavailable${E}[0m) has taken no calls yet`,
  `      1005 (Local/1005@t7-agent/n from hint:1005@t7-hints) (ringinuse disabled) (${E}[1;32;40mNot in use${E}[0m) has taken no calls yet`,
  "   Callers: ",
  "      1. PJSIP/t7_trunk-0000001b (wait: 1:25, prio: 0)",
];

// "core show channels concise" (Asterisk 20.6 alan düzeni). Senaryo:
//  a) kuyrukta bekleyen dış arayan, b) 1001 ile konuşan dış arayan (kuyruktan), c) yapay zekâyla konuşan,
//  d) menüde tuşlayan, e) 1002'den 1005'e iç arama, f) başka kiracı.
const CONCISE = [
  "PJSIP/t7_trunk-0000001b!t7-queue-destek!s!9!Up!Queue!t7_destek,,,,300!05321112233!!!3!95!!1794743127.1",
  "PJSIP/t7_trunk-0000001a!t7-queue-destek!s!9!Up!Queue!t7_destek,,,,300!05447778899!!!3!240!br-1!1794743000.1",
  "Local/1001@t7-agent-00000002;1!t7-agent!s!1!Up!AppQueue!(Outgoing Line)!05447778899!!!3!180!br-1!1794743050.4",
  "Local/1001@t7-agent-00000002;2!t7-agent!1001!2!Up!Dial!PJSIP/t7_1001,,!05447778899!!!3!180!br-2!1794743050.5",
  "PJSIP/t7_1001-00000005!t7-agent!s!1!Up!AppDial!(Outgoing Line)!1001!!!3!180!br-2!1794743050.6",
  "PJSIP/t7_trunk-0000001c!t7-ai-karsilama!s!12!Up!AudioSocket!abc,127.0.0.1:9092!05301234567!!!3!42!!1794743200.1",
  "PJSIP/t7_trunk-0000001d!t7-menu-ana!s!4!Up!WaitExten!6!05559998877!!!3!8!!1794743300.1",
  "PJSIP/t7_1002-00000006!t7-from-internal!1005!1!Up!Dial!PJSIP/t7_1005,30!1002!!!3!30!br-3!1794743310.1",
  "PJSIP/t7_1005-00000007!t7-from-internal!s!1!Up!AppDial!(Outgoing Line)!1005!!!3!30!br-3!1794743310.2",
  "PJSIP/t8_trunk-00000001!t8-queue-x!s!1!Up!Queue!t8_x!05000000000!!!3!300!!1794743000.9",
];

describe("Canlı durum", () => {
  it("queue show: bekleyen, temsilci durumları (molada, görüşmede, çevrimdışı)", () => {
    const q = parseQueue("destek", REAL_QUEUE)!;
    assert.deepEqual(q.waiting, [{ position: 1, channel: "PJSIP/t7_trunk-0000001b", waitS: 85 }]);
    assert.deepEqual(
      q.members.map((m) => [m.number, m.state, m.pauseReason]),
      [
        ["1001", "busy", null],
        ["1002", "busy", null],
        ["1003", "paused", "Yemek"],
        ["1004", "offline", null],
        ["1005", "available", null],
      ],
    );
    assert.equal(parseQueue("yok", ["No such queue: 't7_yok'"]), null);
  });

  it("görüşmeler, temsilciler, kiracı ayrımı ve uyarılar", () => {
    const q = parseQueue("destek", REAL_QUEUE)!;
    const l = buildLive(
      "t7",
      parseConcise(CONCISE),
      [q],
      [
        { number: "1001", name: "Resepsiyon" },
        { number: "1006", name: "Muhasebe" },
      ],
      new Set(["1001", "1002", "1003", "1005", "1006"]),
      { waitAlertS: 60, waitingAlertN: 3 },
      new Date("2026-11-15T12:00:00Z"),
    );
    const byCaller = Object.fromEntries(l.calls.map((c) => [c.caller, c]));
    assert.deepEqual([byCaller["05321112233"].stage, byCaller["05321112233"].queue, byCaller["05321112233"].waitS], ["queue", "destek", 85]);
    assert.deepEqual([byCaller["05447778899"].stage, byCaller["05447778899"].agent], ["talking", "1001"]);
    assert.equal(byCaller["05301234567"].stage, "ai");
    assert.equal(byCaller["05559998877"].stage, "menu");
    assert.deepEqual([byCaller["1002"].direction, byCaller["1002"].stage, byCaller["1002"].agent], ["internal", "talking", "1005"]);
    assert.ok(!l.calls.some((c) => c.caller === "05000000000")); // başka kiracı
    assert.equal(l.calls.length, 5);
    assert.deepEqual([l.waiting, l.longestWaitS, l.talking, l.ai], [1, 85, 2, 1]);
    const ag = Object.fromEntries(l.agents.map((a) => [a.number, a]));
    assert.equal(ag["1001"].name, "Resepsiyon");
    assert.equal(ag["1003"].state, "paused");
    assert.equal(ag["1003"].pauseReason, "Yemek");
    assert.equal(ag["1004"].state, "offline");
    assert.equal(ag["1006"].state, "available"); // kuyrukta değil ama çevrimiçi
    assert.deepEqual(ag["1006"].queues, []);
    assert.deepEqual(l.queues[0], { name: "destek", waiting: 1, longestWaitS: 85, available: 1, busy: 2, paused: 1, members: 5 });
    assert.deepEqual(l.alerts.map((a) => a.kind), ["wait"]);
    assert.match(l.alerts[0].message, /1:25 bekleyen/);
  });

  it("bekleyen var, bağlı temsilci yok ve kalabalık uyarıları", () => {
    const q = parseQueue("satis", [
      "t7_satis has 3 calls (max unlimited) in 'ringall' strategy",
      "   Members: ",
      "      1001 (Local/1001@t7-agent/n from hint:1001@t7-hints) (Unavailable) has taken no calls yet",
      "   Callers: ",
      "      1. PJSIP/t7_trunk-1 (wait: 0:20, prio: 0)",
      "      2. PJSIP/t7_trunk-2 (wait: 0:15, prio: 0)",
      "      3. PJSIP/t7_trunk-3 (wait: 0:05, prio: 0)",
    ])!;
    const l = buildLive("t7", [], [q], [], new Set(), { waitAlertS: 60, waitingAlertN: 3 });
    assert.deepEqual(l.alerts.map((a) => a.kind).sort(), ["no_agent", "waiting"]);
  });
});
