// Santralio: Azure Speech. Konuşmayı yazıya çevirme (SDK, canlı) ve seslendirme (REST, 8 kHz PCM).
// Bölge sunucu ayarındadır (SANTRALIO_AZURE_SPEECH_REGION, ör. westeurope); anahtar systemd credential'dır.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import type { SpeechToText, TextToSpeech } from "./providers.ts";

export class AzureStt implements SpeechToText {
  private push: sdk.PushAudioInputStream;
  private recognizer: sdk.SpeechRecognizer;
  private bytes = 0;

  constructor(key: string, region: string, language = "tr-TR") {
    const config = sdk.SpeechConfig.fromSubscription(key, region);
    config.speechRecognitionLanguage = language;
    // Arayan susunca cümleyi daha çabuk kapat (varsayılan ~1 sn).
    config.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, "700");
    this.push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1));
    this.recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(this.push));
  }

  get seconds() {
    return this.bytes / 16000;
  }

  write(frame: Buffer) {
    this.bytes += frame.length;
    this.push.write(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) as ArrayBuffer);
  }

  start(onPartial: (t: string) => void, onFinal: (t: string) => void): Promise<void> {
    this.recognizer.recognizing = (_s, e) => onPartial(e.result.text);
    this.recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text.trim()) onFinal(e.result.text.trim());
    };
    return new Promise((resolve, reject) => this.recognizer.startContinuousRecognitionAsync(resolve, (err) => reject(new Error(err))));
  }

  stop(): Promise<void> {
    this.push.close();
    return new Promise((resolve) =>
      this.recognizer.stopContinuousRecognitionAsync(
        () => {
          this.recognizer.close();
          resolve();
        },
        () => resolve(),
      ),
    );
  }
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

// Aynı metin ve ses için üretilen ses diskte saklanır (karşılama cümlesi her aramada ücretlendirilmez).
export class AzureTts implements TextToSpeech {
  private key: string;
  private region: string;
  private cacheDir: string;
  chars = 0;

  constructor(key: string, region: string, cacheDir: string) {
    this.key = key;
    this.region = region;
    this.cacheDir = cacheDir;
  }

  async synthesize(text: string, voice: string): Promise<Buffer> {
    const name = voice.replace(/^azure:/, "");
    if (!/^[A-Za-z]{2}-[A-Za-z]{2}-[A-Za-z0-9]+Neural$/.test(name)) throw new Error(`geçersiz Azure sesi: ${name}`);
    const file = join(this.cacheDir, `${createHash("sha256").update(`${name}\n${text}`).digest("hex").slice(0, 32)}.raw`);
    const cached = await readFile(file).catch(() => null);
    if (cached) return cached;
    const ssml = `<speak version="1.0" xml:lang="tr-TR"><voice name="${name}">${xml(text)}</voice></speak>`;
    const res = await fetch(`https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-8khz-16bit-mono-pcm",
        "User-Agent": "santralio",
      },
      body: ssml,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    this.chars += text.length;
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(file, audio);
    return audio;
  }
}
