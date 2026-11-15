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
// "tool": sistemin (rezervasyon bağlantısının) sonucu; modele etiketli ve arayanın sözlerinden ayrı verilir.
export type Turn = { role: "caller" | "assistant" | "tool"; text: string; language?: string };

export type BookingField = { key: string; label: string; type: string; required: boolean; choices?: string[] };
export type BookingService = { key: string; label: string; description: string; fields: BookingField[]; payment: "none" | "optional" | "required" };
export type BookingRequest = { service: string; fields: Record<string, string>; payNow: boolean; customerName: string | null };

export type Decision = {
  // quote: müsaitlik ve fiyat sor; book: arayan onayladı, rezervasyonu oluştur; lookup: arayanın rezervasyonlarını getir.
  action: "say" | "transfer" | "end" | "quote" | "book" | "lookup";
  booking?: BookingRequest | null;
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
  // Rezervasyon açıksa hizmetler ve sistem sonuçlarını arayanın sözlerinden ayıran tek kullanımlık etiket.
  booking?: { services: BookingService[]; nonce: string; today: string } | null;
  channel?: "phone" | "chat";
};

export interface LanguageModel {
  decide(flow: FlowContext, history: Turn[]): Promise<Decision>;
}
