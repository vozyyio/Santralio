// Santralio: yapay zekâ karşılamasının tek bir çağrıdaki akışı.
// Karşılama -> (arayanı dinle -> karar -> söyle) x en fazla max_turns -> aktar / kapat.
// Hiçbir durumda çağrı düşürülmez: hata, sessizlik, tur sınırı ya da süre aşımında varsayılan yere aktarılır.

import { FRAME_BYTES, FRAME_MS } from "./audiosocket.ts";
import { lang, voiceFor } from "./languages.ts";
import type { FlowContext, LanguageModel, SpeechToText, TextToSpeech, Turn } from "./providers.ts";

export type Result = {
  target: string | null; // null: varsayılan; "hangup": kapat
  summary: string | null;
  reason: "transfer" | "end" | "max_turns" | "silence" | "error" | "hangup" | "timeout";
  history: Turn[];
  language: string; // görüşmenin son dili
  inputTokens: number;
  outputTokens: number;
  error?: string;
};

const SILENCE_MS = 9_000; // arayan bu kadar konuşmazsa bir kez daha sorulur
const MAX_CALL_MS = 180_000; // asistanla en fazla 3 dakika
const BARGE_IN_AFTER_MS = 400; // çalmanın ilk anındaki yankı söze girme sayılmaz

export class CallSession {
  private stt: SpeechToText;
  private tts: TextToSpeech;
  private llm: LanguageModel;
  private send: (frame: Buffer) => void;
  private voice: string;
  private languages: string[];
  private finals: { text: string; language?: string }[] = [];
  private waiter: (() => void) | null = null;
  private playing: { started: number; stop: boolean } | null = null;
  closed = false;
  history: Turn[] = [];
  // Konuşulan dil: karşılamada arayanın numarasına göre, sonra tanınan dile ve modelin yanıt diline göre değişir.
  language: string;

  constructor(deps: {
    stt: SpeechToText;
    tts: TextToSpeech;
    llm: LanguageModel;
    send: (f: Buffer) => void;
    voice: string;
    languages?: string[];
    language?: string;
  }) {
    this.stt = deps.stt;
    this.tts = deps.tts;
    this.llm = deps.llm;
    this.send = deps.send;
    this.voice = deps.voice;
    this.languages = deps.languages ?? ["tr-TR"];
    this.language = deps.language && this.languages.includes(deps.language) ? deps.language : this.languages[0];
  }

  // Arayanın sesi.
  audio(frame: Buffer) {
    if (!this.closed) this.stt.write(frame);
  }

  // Arayan kapattı.
  close() {
    this.closed = true;
    if (this.playing) this.playing.stop = true;
    this.waiter?.();
  }

  private onPartial = (text: string) => {
    // Söze girme: asistan konuşurken arayan anlamlı bir şey söylemeye başlarsa çalma durur.
    if (this.playing && text.trim().length >= 3 && Date.now() - this.playing.started > BARGE_IN_AFTER_MS) this.playing.stop = true;
  };

  private onFinal = (text: string, language?: string) => {
    this.finals.push({ text, language: language && this.languages.includes(language) ? language : undefined });
    this.waiter?.();
  };

  // Sesi gerçek zamanlı hızda, 20 ms'lik çerçevelerle gönderir; söze girilirse ya da çağrı kapanırsa durur.
  async speak(text: string) {
    if (this.closed || !text.trim()) return;
    const pcm = await this.tts.synthesize(text, voiceFor(this.language, this.voice));
    this.history.push({ role: "assistant", text, language: this.language });
    const state = { started: Date.now(), stop: false };
    this.playing = state;
    const t0 = Date.now();
    for (let i = 0, n = 0; i < pcm.length && !state.stop && !this.closed; i += FRAME_BYTES, n++) {
      let frame = pcm.subarray(i, i + FRAME_BYTES);
      if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
      this.send(frame);
      // Saat kaymasını önlemek için her çerçeve başlangıca göre zamanlanır.
      const wait = t0 + (n + 1) * FRAME_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    this.playing = null;
  }

  private async nextUtterance(timeoutMs: number): Promise<{ text: string; language?: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (this.finals.length) {
        // Kısa aralıkla gelen parçalar tek cümle sayılır.
        await new Promise((r) => setTimeout(r, 300));
        const parts = this.finals.splice(0);
        return { text: parts.map((p) => p.text).join(" "), language: parts.map((p) => p.language).filter(Boolean).pop() };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = null;
    }
    return null;
  }

  async run(flow: FlowContext, greeting: string, maxTurns: number): Promise<Result> {
    let inputTokens = 0;
    let outputTokens = 0;
    const done = (r: Omit<Result, "history" | "language" | "inputTokens" | "outputTokens">): Result => ({
      ...r,
      history: this.history,
      language: this.language,
      inputTokens,
      outputTokens,
    });
    const say = (key: "transfer" | "notHeard") => this.speak(lang(this.language)[key]);
    const started = Date.now();
    try {
      await this.stt.start(this.onPartial, this.onFinal);
      await this.speak(greeting);
      let silent = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.closed) return done({ target: null, summary: null, reason: "hangup" });
        if (Date.now() - started > MAX_CALL_MS) {
          await say("transfer");
          return done({ target: null, summary: null, reason: "timeout" });
        }
        const heard = await this.nextUtterance(SILENCE_MS);
        if (this.closed) return done({ target: null, summary: null, reason: "hangup" });
        if (!heard) {
          if (++silent >= 2) {
            await say("transfer");
            return done({ target: null, summary: null, reason: "silence" });
          }
          await say("notHeard");
          turn--;
          continue;
        }
        silent = 0;
        if (heard.language) this.language = heard.language;
        this.history.push({ role: "caller", text: heard.text, language: heard.language });
        const d = await this.llm.decide(flow, this.history);
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        // Model arayanın diline geçtiyse (ya da dil tanıma yanıldıysa) ses modelin yanıt diline uyar.
        if (this.languages.includes(d.language)) this.language = d.language;
        if (d.action === "say") {
          await this.speak(d.say);
          continue;
        }
        await this.speak(d.say);
        if (d.action === "end") return done({ target: "hangup", summary: d.summary, reason: "end" });
        return done({ target: d.target, summary: d.summary, reason: "transfer" });
      }
      await say("transfer");
      return done({ target: null, summary: null, reason: "max_turns" });
    } catch (e) {
      return done({ target: null, summary: null, reason: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.stt.stop().catch(() => {});
    }
  }
}
