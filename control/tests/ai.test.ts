// Santralio: yapay zekâ karşılaması testleri (sahte sağlayıcılarla, ağ yok).

import assert from "node:assert/strict";
import { test } from "node:test";
import { encode, KIND, Parser, uuidString } from "../src/ai/audiosocket.ts";
import { FakeModel, FakeStt } from "../src/ai/local.ts";
import type { Decision, FlowContext, LanguageModel, SpeechToText, TextToSpeech } from "../src/ai/providers.ts";
import { CallSession } from "../src/ai/session.ts";

const flow: FlowContext = {
  company: "Dosyazılım",
  instructions: "",
  routes: [
    { target: "queue:muhasebe", description: "fatura, ödeme, borç" },
    { target: "queue:destek", description: "arıza, kurulum, şifre" },
  ],
  defaultTarget: "queue:destek",
  model: "test",
};

// 0,1 sn'lik sessizlik üreten TTS (çalma süresini kısa tutar).
class SilentTts implements TextToSpeech {
  said: string[] = [];
  async synthesize(text: string) {
    this.said.push(text);
    return Buffer.alloc(1600);
  }
}

// Arayanın sesi: konuşma boyunca 20 ms'de bir çerçeve.
function feed(s: CallSession, ms: number) {
  const timer = setInterval(() => s.audio(Buffer.alloc(320)), 20);
  setTimeout(() => clearInterval(timer), ms);
}

test("AudioSocket: mesajlar parçalı gelse de doğru ayrılır; UUID biçimi", () => {
  const p = new Parser();
  const uuid = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const all = Buffer.concat([encode(KIND.uuid, uuid), encode(KIND.audio, Buffer.alloc(320, 7)), encode(KIND.hangup)]);
  const out = [...p.push(all.subarray(0, 10)), ...p.push(all.subarray(10, 200)), ...p.push(all.subarray(200))];
  assert.deepEqual(out.map((m) => m.kind), [KIND.uuid, KIND.audio, KIND.hangup]);
  assert.equal(out[1].payload.length, 320);
  assert.equal(uuidString(out[0].payload), "01234567-89ab-cdef-0123-456789abcdef");
});

test("akış: karşılama, arayan 'faturam' der, muhasebeye aktarılır ve ses gerçek zamanlı gönderilir", async () => {
  const tts = new SilentTts();
  const frames: Buffer[] = [];
  const s = new CallSession({ stt: new FakeStt(["faturam hakkında bilgi almak istiyorum"]), tts, llm: new FakeModel(), send: (f) => frames.push(f), voice: "x" });
  feed(s, 2500);
  const t0 = Date.now();
  const r = await s.run(flow, "Dosyazılım'a hoş geldiniz.", 4);
  assert.equal(r.reason, "transfer");
  assert.equal(r.target, "queue:muhasebe");
  assert.ok(r.summary?.includes("faturam"));
  assert.deepEqual(tts.said, ["Dosyazılım'a hoş geldiniz.", "Sizi ilgili birimimize aktarıyorum."]);
  assert.ok(frames.every((f) => f.length === 320), "her çerçeve 320 bayt");
  assert.ok(Date.now() - t0 >= 100, "ses gerçek zamanlı hızda çalınır");
  assert.deepEqual(r.history.map((h) => h.role), ["assistant", "caller", "assistant"]);
});

test("anlaşılmayan istek bir kez sorulur, sonra varsayılana (target null) aktarılır", async () => {
  const s = new CallSession({ stt: new FakeStt(["merhaba", "şey bilmiyorum"]), tts: new SilentTts(), llm: new FakeModel(), send: () => {}, voice: "x" });
  feed(s, 4500);
  const r = await s.run(flow, "Merhaba.", 4);
  assert.equal(r.reason, "transfer");
  assert.equal(r.target, null);
});

test("dil modeli hata verirse çağrı düşmez: varsayılana", async () => {
  const broken: LanguageModel = { decide: async (): Promise<Decision> => Promise.reject(new Error("ağ yok")) };
  const s = new CallSession({ stt: new FakeStt(["fatura"]), tts: new SilentTts(), llm: broken, send: () => {}, voice: "x" });
  feed(s, 2500);
  const r = await s.run(flow, "Merhaba.", 4);
  assert.equal(r.reason, "error");
  assert.equal(r.target, null);
});

test("arayan kapatırsa oturum hemen biter", async () => {
  const stt: SpeechToText = { seconds: 0, write() {}, start: async () => {}, stop: async () => {} };
  const s = new CallSession({ stt, tts: new SilentTts(), llm: new FakeModel(), send: () => {}, voice: "x" });
  setTimeout(() => s.close(), 200);
  const t0 = Date.now();
  const r = await s.run(flow, "Merhaba.", 4);
  assert.equal(r.reason, "hangup");
  assert.ok(Date.now() - t0 < 2000);
});

test("söze girme: arayan konuşmaya başlayınca asistan susar", async () => {
  let partial: ((t: string) => void) | null = null;
  const stt: SpeechToText = { seconds: 0, write() {}, start: async (p) => void (partial = p), stop: async () => {} };
  const long: TextToSpeech = { synthesize: async () => Buffer.alloc(16000 * 3) }; // 3 sn
  let sent = 0;
  const s = new CallSession({ stt, tts: long, llm: new FakeModel(), send: () => sent++, voice: "x" });
  await stt.start(() => {}, () => {});
  const speaking = s.speak("uzun bir anons");
  // start() oturum içinde çağrılmadığı için onPartial'ı elle bağla.
  setTimeout(() => (s as unknown as { onPartial: (t: string) => void }).onPartial("evet bir sorum var"), 700);
  await speaking;
  assert.ok(sent < 60, `çalma erken durmalı (gönderilen çerçeve: ${sent}, tamamı 150)`);
  void partial;
});
