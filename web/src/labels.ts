// Ekranlarda ortak kullanılan, teknik değerleri anlaşılır metne çeviren yardımcılar.
import type { Tone } from "./Layout";

const REG_LABEL: Record<string, [string, Tone]> = {
  Registered: ["Bağlı", "ok"],
  Retrying: ["Bağlanıyor", "warn"],
  Unregistered: ["Bağlı değil", "bad"],
  Rejected: ["Reddedildi", "bad"],
  Stopped: ["Durduruldu", "bad"],
  none: ["Tanımlı değil", "idle"],
};
export const regLabel = (r: string): [string, Tone] => REG_LABEL[r] ?? ["Bilinmiyor", "warn"];

const OPERATORS: Record<string, string> = { netgsm: "Netgsm", verimor: "Verimor", turktelekom: "Türk Telekom", turkcell: "Turkcell", vodafone: "Vodafone" };
export const operatorName = (o: string) => OPERATORS[o.toLowerCase()] ?? o.charAt(0).toLocaleUpperCase("tr-TR") + o.slice(1);
