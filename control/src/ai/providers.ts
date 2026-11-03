// Santralio: yapay zekâ karşılamasının sağlayıcı arayüzleri. Ses tanıma (STT), seslendirme (TTS) ve dil modeli (LLM)
// birbirinden bağımsız değiştirilebilir (bkz. docs/architecture.md, "Ek: Kanaldan bağımsız mimari").

export interface SpeechToText {
  // Arayanın sesi (slin, 8 kHz) parça parça verilir.
  write(frame: Buffer): void;
  // onPartial: konuşma sürerken ara metin (söze girmeyi algılamak için); onFinal: tamamlanmış cümle ve
  // (birden çok aday dil varsa) tanınan dil.
  start(onPartial: (text: string) => void, onFinal: (text: string, language?: string) => void): Promise<void>;
  stop(): Promise<void>;
  // Faturalanan ses süresi (saniye).
  readonly seconds: number;
}

export interface TextToSpeech {
  // slin, 8 kHz, 16 bit, tek kanal.
  synthesize(text: string, voice: string): Promise<Buffer>;
}

export type Route = { target: string; description: string };
export type Turn = { role: "caller" | "assistant"; text: string; language?: string };

export type Decision = {
  action: "say" | "transfer" | "end";
  say: string; // arayana söylenecek (aktarma ve kapatmada kısa bir cümle)
  target: string | null; // yalnızca "transfer" için; routes içinden
  summary: string | null; // temsilciye bırakılacak özet (aktarmada; her zaman Türkçe)
  language: string; // "say" cümlesinin dili (seslendirme sesi buna göre seçilir)
  inputTokens: number;
  outputTokens: number;
};

export type FlowContext = {
  company: string;
  instructions: string;
  routes: Route[];
  defaultTarget: string | null;
  model: string;
  languages: string[]; // arayanın konuşabileceği diller (ilk: ana dil)
};

export interface LanguageModel {
  decide(flow: FlowContext, history: Turn[]): Promise<Decision>;
}
