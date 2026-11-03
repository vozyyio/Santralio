// Santralio: yapay zekâ karşılamasının dilleri. Ses tanıma dili, doğal kadın/erkek Azure sesi, sabit cümleler,
// varsayılan karşılama ve arayan numarasının ülke koduna göre ilk dil tahmini.

export type Lang = {
  code: string; // Azure tanıma dili (BCP-47)
  label: string; // Türkçe adı
  flag: string;
  voices: { female: string; male: string };
  greeting: (company: string) => string;
  transfer: string;
  notHeard: string;
};

export const LANGUAGES: Lang[] = [
  {
    code: "tr-TR",
    label: "Türkçe",
    flag: "🇹🇷",
    voices: { female: "azure:tr-TR-EmelNeural", male: "azure:tr-TR-AhmetNeural" },
    greeting: (c) => `${c}'a hoş geldiniz. Görüşmeniz yapay zekâ destekli asistanımız tarafından karşılanmaktadır. Size nasıl yardımcı olabilirim?`,
    transfer: "Sizi bir temsilcimize aktarıyorum.",
    notHeard: "Sizi duyamadım. Size nasıl yardımcı olabilirim?",
  },
  {
    code: "en-US",
    label: "İngilizce",
    flag: "🇬🇧",
    voices: { female: "azure:en-US-JennyNeural", male: "azure:en-US-GuyNeural" },
    greeting: (c) => `Welcome to ${c}. You are speaking with our AI assistant. How can I help you?`,
    transfer: "I am transferring you to one of our team members.",
    notHeard: "Sorry, I could not hear you. How can I help you?",
  },
  {
    code: "de-DE",
    label: "Almanca",
    flag: "🇩🇪",
    voices: { female: "azure:de-DE-KatjaNeural", male: "azure:de-DE-ConradNeural" },
    greeting: (c) => `Willkommen bei ${c}. Sie sprechen mit unserem KI-Assistenten. Wie kann ich Ihnen helfen?`,
    transfer: "Ich verbinde Sie mit einem unserer Mitarbeiter.",
    notHeard: "Entschuldigung, ich konnte Sie nicht hören. Wie kann ich Ihnen helfen?",
  },
  {
    code: "ru-RU",
    label: "Rusça",
    flag: "🇷🇺",
    voices: { female: "azure:ru-RU-SvetlanaNeural", male: "azure:ru-RU-DmitryNeural" },
    greeting: (c) => `Добро пожаловать в ${c}. Вы говорите с нашим ИИ-ассистентом. Чем я могу вам помочь?`,
    transfer: "Я соединяю вас с нашим сотрудником.",
    notHeard: "Извините, я вас не расслышала. Чем я могу вам помочь?",
  },
  {
    code: "ar-SA",
    label: "Arapça",
    flag: "🇸🇦",
    voices: { female: "azure:ar-SA-ZariyahNeural", male: "azure:ar-SA-HamedNeural" },
    greeting: (c) => `مرحباً بكم في ${c}. أنتم تتحدثون مع مساعدنا الذكي. كيف يمكنني مساعدتكم؟`,
    transfer: "سأحوّلكم الآن إلى أحد موظفينا.",
    notHeard: "عذراً، لم أسمعكم. كيف يمكنني مساعدتكم؟",
  },
  {
    code: "fr-FR",
    label: "Fransızca",
    flag: "🇫🇷",
    voices: { female: "azure:fr-FR-DeniseNeural", male: "azure:fr-FR-HenriNeural" },
    greeting: (c) => `Bienvenue chez ${c}. Vous parlez avec notre assistant IA. Comment puis-je vous aider ?`,
    transfer: "Je vous mets en relation avec un membre de notre équipe.",
    notHeard: "Excusez-moi, je ne vous ai pas entendu. Comment puis-je vous aider ?",
  },
  {
    code: "it-IT",
    label: "İtalyanca",
    flag: "🇮🇹",
    voices: { female: "azure:it-IT-ElsaNeural", male: "azure:it-IT-DiegoNeural" },
    greeting: (c) => `Benvenuti da ${c}. State parlando con il nostro assistente virtuale. Come posso aiutarvi?`,
    transfer: "Vi trasferisco a un membro del nostro team.",
    notHeard: "Mi scusi, non l'ho sentita. Come posso aiutarla?",
  },
];

export const DEFAULT_LANG = "tr-TR";
export const lang = (code: string | null | undefined): Lang => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
export const isLang = (code: unknown): code is string => typeof code === "string" && LANGUAGES.some((l) => l.code === code);

// Akışın sesi (Emel/Ahmet ya da Piper) cinsiyeti belirler; diğer dillerde aynı cinsiyetten Azure sesi kullanılır.
// Türkçe ve akışta Piper sesi seçiliyse Piper kalır.
export function voiceFor(code: string, flowVoice: string): string {
  if (code === DEFAULT_LANG) return flowVoice;
  return /AhmetNeural|male/i.test(flowVoice) && !/female/i.test(flowVoice) ? lang(code).voices.male : lang(code).voices.female;
}

// Ülke kodu -> dil (en uzun önek kazanır). Listede olmayan yabancı numara: null (bilinmeyen).
const COUNTRY: [string, string][] = [
  ["90", "tr-TR"],
  ["1", "en-US"], ["44", "en-US"], ["353", "en-US"], ["61", "en-US"], ["64", "en-US"], ["27", "en-US"],
  ["49", "de-DE"], ["43", "de-DE"], ["41", "de-DE"],
  ["7", "ru-RU"], ["375", "ru-RU"], ["996", "ru-RU"],
  ["966", "ar-SA"], ["971", "ar-SA"], ["974", "ar-SA"], ["965", "ar-SA"], ["973", "ar-SA"], ["968", "ar-SA"], ["962", "ar-SA"],
  ["961", "ar-SA"], ["964", "ar-SA"], ["963", "ar-SA"], ["967", "ar-SA"], ["20", "ar-SA"], ["212", "ar-SA"], ["213", "ar-SA"],
  ["216", "ar-SA"], ["218", "ar-SA"], ["249", "ar-SA"],
  ["33", "fr-FR"], ["32", "fr-FR"], ["352", "fr-FR"],
  ["39", "it-IT"], ["378", "it-IT"],
];

// Arayan numarasından ilk dil tahmini. Gizli ya da yurt içi numara: Türkçe. Bilinmeyen yabancı: null.
export function callerLanguage(caller: string): string | null {
  const raw = caller.replace(/[^0-9+]/g, "");
  let intl: string | null = null;
  if (raw.startsWith("+")) intl = raw.slice(1);
  else if (raw.startsWith("00")) intl = raw.slice(2);
  else if (raw.startsWith("90") && raw.length === 12) intl = raw;
  else if (raw.length <= 11) return DEFAULT_LANG; // 0532..., 532..., kısa numaralar
  else intl = raw;
  let best: [string, string] | null = null;
  for (const c of COUNTRY) if (intl.startsWith(c[0]) && (!best || c[0].length > best[0].length)) best = c;
  return best ? best[1] : null;
}

// Karşılamanın dili: arayanın ülkesinin dili akışta açıksa o; bilinmeyen ya da kapalı yabancı dilde İngilizce (açıksa); yoksa Türkçe.
export function greetingLanguage(caller: string, enabled: string[]): string {
  const guess = callerLanguage(caller);
  if (guess && enabled.includes(guess)) return guess;
  if (guess !== DEFAULT_LANG && enabled.includes("en-US")) return "en-US";
  return enabled.includes(DEFAULT_LANG) ? DEFAULT_LANG : enabled[0];
}
