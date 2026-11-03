// Santralio: yerel ve test sağlayıcıları.
// PiperTts: sunucuda yerel seslendirme (dış servise metin gitmez). FakeStt / FakeModel: yalnızca testler için
// (SANTRALIO_AI_FAKE=1): Azure ve Anthropic anahtarı olmadan bütün ses yolunu uçtan uca sınamaya yarar.

import { spawnSync } from "node:child_process";
import { resolveVoice, synthesize } from "../voices.ts";
import { lang } from "./languages.ts";
import type { Decision, FlowContext, LanguageModel, SpeechToText, TextToSpeech, Turn } from "./providers.ts";

export class PiperTts implements TextToSpeech {
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const v = resolveVoice(voice.startsWith("piper:") ? voice : "piper:tr_TR-dfki-medium");
    const { audio, soxInput } = synthesize(v, text);
    const r = spawnSync("sox", [...soxInput, "-t", "raw", "-r", "8000", "-e", "signed", "-b", "16", "-c", "1", "-"], {
      input: audio,
      maxBuffer: 64 << 20,
    });
    if (r.status !== 0) throw new Error(`sox: ${r.stderr.toString()}`);
    return r.stdout;
  }
}

// Arayan konuşmaya başlayınca (ilk ~1 sn ses) sırayla verilen cümleleri "duymuş" gibi davranır.
// "de-DE:Guten Tag" biçimindeki cümle o dilde tanınmış sayılır.
export class FakeStt implements SpeechToText {
  private phrases: string[];
  private bytes = 0;
  private heard = 0;
  private onFinal: ((t: string, language?: string) => void) | null = null;
  constructor(phrases: string[]) {
    this.phrases = phrases;
  }
  get seconds() {
    return this.bytes / 16000;
  }
  write(frame: Buffer) {
    this.bytes += frame.length;
    this.heard += frame.length;
    if (this.heard >= 16000 && this.phrases.length && this.onFinal) {
      this.heard = 0;
      const p = this.phrases.shift()!;
      const m = /^([a-z]{2}-[A-Z]{2}):(.*)$/s.exec(p);
      if (m) this.onFinal(m[2], m[1]);
      else this.onFinal(p);
    }
  }
  async start(_p: (t: string) => void, onFinal: (t: string, language?: string) => void) {
    this.onFinal = onFinal;
  }
  async stop() {}
}

// Arayanın cümlesinde yönlendirme açıklamasındaki bir kelime geçiyorsa oraya aktarır; yoksa bir kez sorar, sonra varsayılana.
export class FakeModel implements LanguageModel {
  async decide(flow: FlowContext, history: Turn[]): Promise<Decision> {
    const turn = history.filter((t) => t.role === "caller").pop();
    const last = turn?.text.toLocaleLowerCase("tr") ?? "";
    // Gerçek modeldeki gibi: dili bilinmeyen cümlede son konuşulan dil sürer.
    const known = [...history].reverse().find((t) => t.language && flow.languages.includes(t.language))?.language;
    const language = known ?? flow.languages[0];
    const l = lang(language);
    for (const r of flow.routes) {
      const words = r.description.toLocaleLowerCase("tr").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
      if (words.some((w) => last.includes(w))) {
        return { action: "transfer", say: l.transfer, target: r.target, summary: `Arayan: "${last}"`, language, inputTokens: 0, outputTokens: 0 };
      }
    }
    if (history.filter((t) => t.role === "caller").length < 2) {
      return { action: "say", say: l.notHeard, target: null, summary: null, language, inputTokens: 0, outputTokens: 0 };
    }
    return { action: "transfer", say: l.transfer, target: null, summary: `Arayan: "${last}"`, language, inputTokens: 0, outputTokens: 0 };
  }
}
