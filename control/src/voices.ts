// Santralio: anons sesleri kataloğu ve metinden ses üretimi.
// Piper modelleri /opt/santralio/voices altından kendiliğinden bulunur: <model>.onnx + <model>.onnx.json,
// isteğe bağlı <model>.label (panelde görünen ad, ör. "Kadın · doğal"). Yeni ses eklemek için dosyaları oraya koymak yeter.
// espeak-ng sesleri (sentetik) yedek olarak her zaman listededir.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPER_BIN } from "./config.ts";

export const VOICES_DIR = process.env.SANTRALIO_VOICES_DIR ?? "/opt/santralio/voices";
export const DEFAULT_VOICE = "piper:tr_TR-dfki-medium";

export type Voice = { id: string; label: string; engine: "piper" | "espeak" };

const ESPEAK: Voice[] = [
  { id: "espeak:mb-tr2", label: "Kadın · sentetik (espeak)", engine: "espeak" },
  { id: "espeak:mb-tr1", label: "Erkek · sentetik (espeak)", engine: "espeak" },
];

// Bilinen modellerin panel adları (.label dosyası yoksa).
const KNOWN: Record<string, string> = { "tr_TR-dfki-medium": "Erkek · doğal (Piper)" };

export function listVoices(): Voice[] {
  const out: Voice[] = [];
  if (existsSync(PIPER_BIN)) {
    let files: string[] = [];
    try {
      files = readdirSync(VOICES_DIR);
    } catch {
      files = [];
    }
    for (const f of files.filter((f) => f.endsWith(".onnx")).sort()) {
      const model = f.slice(0, -5);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(model) || !files.includes(`${f}.json`)) continue;
      let label = KNOWN[model] ?? model;
      try {
        label = readFileSync(join(VOICES_DIR, `${model}.label`), "utf8").trim().slice(0, 60) || label;
      } catch {
        // etiket dosyası yok
      }
      out.push({ id: `piper:${model}`, label, engine: "piper" });
    }
  }
  return [...out, ...ESPEAK];
}

export function resolveVoice(id: string): Voice {
  return listVoices().find((v) => v.id === id) ?? listVoices()[0];
}

// Metni ham ses olarak üretir; sox'a verilecek giriş biçimini de döner.
export function synthesize(voice: Voice, text: string): { audio: Buffer; soxInput: string[] } {
  if (voice.engine === "piper") {
    const model = join(VOICES_DIR, `${voice.id.slice(6)}.onnx`);
    const r = spawnSync(PIPER_BIN, ["--model", model, "--output_raw"], { input: text, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`piper: ${r.stderr.toString().trim().split("\n").pop()}`);
    const rate = String(JSON.parse(readFileSync(`${model}.json`, "utf8")).audio.sample_rate);
    return { audio: r.stdout, soxInput: ["-t", "raw", "-r", rate, "-e", "signed", "-b", "16", "-c", "1", "-"] };
  }
  // Metin argüman olarak değil standart girdiden verilir: "-" ile başlayan metin seçenek sanılmaz.
  const r = spawnSync("espeak-ng", ["-v", voice.id.slice(7), "-s", "140", "--stdin", "--stdout"], { input: text, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`espeak-ng: ${r.stderr.toString().trim()}`);
  return { audio: r.stdout, soxInput: ["-t", "wav", "-"] };
}
