// Santralio: dış arama politikası. Hangi numara türlerinin ve hangi ülkelerin aranabileceği kiracı bazındadır
// ve yalnızca platform yöneticisi tarafından değiştirilir. Özel ücretli (0900 vb.) ve kısa numaralar her zaman engellidir:
// santral yalnızca aşağıdaki desenlere uyan numaraları operatöre gönderir, gerisini reddeder.

export type Policy = {
  template: string;
  enabled: boolean;
  trMobile: boolean;
  trLandline: boolean;
  trNational: boolean;
  trTollfree: boolean;
  countries: string[];
  maxConcurrent: number;
  dailyLimit: number;
  maxMinutes: number;
};

const TR_ALL = { trMobile: true, trLandline: true, trNational: true, trTollfree: true };

// Sektör şablonları. Şablon seçilince kurallar dolar; platform yöneticisi sonra tek tek değiştirebilir.
export const TEMPLATES: Record<string, { label: string; policy: Omit<Policy, "template"> }> = {
  inbound_only: {
    label: "Yalnızca gelen arama",
    policy: { enabled: false, trMobile: false, trLandline: false, trNational: false, trTollfree: false, countries: [], maxConcurrent: 0, dailyLimit: 0, maxMinutes: 60 },
  },
  agency: {
    label: "Acente (yurt içi)",
    policy: { enabled: true, ...TR_ALL, countries: [], maxConcurrent: 4, dailyLimit: 300, maxMinutes: 60 },
  },
  hotel: {
    label: "Otel / turizm",
    // Başlıca turist gönderen pazarlar: Almanya, Birleşik Krallık, Rusya, Hollanda, Fransa, İtalya, Polonya, Ukrayna, İsrail, S. Arabistan, BAE.
    policy: { enabled: true, ...TR_ALL, countries: ["49", "44", "7", "31", "33", "39", "48", "380", "972", "966", "971"], maxConcurrent: 4, dailyLimit: 200, maxMinutes: 60 },
  },
  health_tourism: {
    label: "Sağlık turizmi",
    // Avrupa ve Körfez: Almanya, Birleşik Krallık, Hollanda, Fransa, Belçika, Avusturya, İsviçre, İsveç, S. Arabistan, BAE, Katar, Kuveyt, Irak, Azerbaycan, Rusya.
    policy: {
      enabled: true,
      ...TR_ALL,
      countries: ["49", "44", "31", "33", "32", "43", "41", "46", "966", "971", "974", "965", "964", "994", "7"],
      maxConcurrent: 6,
      dailyLimit: 400,
      maxMinutes: 90,
    },
  },
};

// Türkiye (90) yurt dışı listesine girmez; yurt içi kurallarıyla aranır.
// +1 (Kuzey Amerika numara planı) Karayipler'deki yüksek ücretli hatları da kapsadığı için kabul edilmez.
const COUNTRY = /^[1-9][0-9]{0,3}$/;
const BLOCKED_COUNTRIES = new Set(["90", "1"]);

export function validatePolicy(p: Policy): Policy {
  const ints: [keyof Policy, number, number][] = [
    ["maxConcurrent", 0, 100],
    ["dailyLimit", 0, 100000],
    ["maxMinutes", 1, 480],
  ];
  for (const [k, min, max] of ints) {
    const v = p[k] as number;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${k} ${min}–${max} arasında olmalı`);
  }
  for (const k of ["enabled", "trMobile", "trLandline", "trNational", "trTollfree"] as const) {
    if (typeof p[k] !== "boolean") throw new Error(`${k} true/false olmalı`);
  }
  if (!Array.isArray(p.countries)) throw new Error("countries bir liste olmalı");
  const countries = [...new Set(p.countries.map(String))];
  for (const c of countries) {
    if (!COUNTRY.test(c)) throw new Error(`geçersiz ülke kodu: ${c}`);
    if (BLOCKED_COUNTRIES.has(c)) throw new Error(c === "90" ? "Türkiye yurt dışı listesine eklenmez" : "+1 (Kuzey Amerika numara planı) yüksek ücretli hatlar nedeniyle açılmaz");
  }
  // Uzun kod kısa kodu kapsar (ör. 97 ile 971): kısa kod varsa uzun kod gereksizdir, ama zararı yoktur.
  return { ...p, template: String(p.template || "custom"), countries: countries.sort() };
}

// Santralin operatöre göndereceği numara desenleri (Asterisk extension pattern) ve açıklamaları.
export function dialPatterns(p: Policy): { pattern: string; label: string }[] {
  if (!p.enabled) return [];
  const out: { pattern: string; label: string }[] = [];
  if (p.trMobile) out.push({ pattern: "_05XXXXXXXXX", label: "Türkiye mobil" });
  if (p.trLandline) out.push({ pattern: "_0[234]XXXXXXXXX", label: "Türkiye sabit" });
  if (p.trNational) out.push({ pattern: "_0850XXXXXXX", label: "0850" }, { pattern: "_444XXXX", label: "444" });
  if (p.trTollfree) out.push({ pattern: "_0800XXXXXXX", label: "0800 ücretsiz" });
  for (const c of p.countries) out.push({ pattern: `_00${c}XXXX.`, label: `Yurt dışı +${c}` });
  return out;
}

// Panelden ya da temsilci masasından girilen numarayı santralin beklediği biçime getirir:
// "+90 532 …" / "90532…" / "532…" -> "0532…", "+49 …" -> "0049…". Geçersizse null.
export function normalizeNumber(input: string): string | null {
  let n = input.replace(/[\s().-]/g, "");
  if (n.startsWith("+")) n = "00" + n.slice(1);
  if (!/^[0-9]{4,20}$/.test(n)) return null;
  if (n.startsWith("0090")) n = "0" + n.slice(4);
  else if (n.startsWith("90") && n.length === 12) n = "0" + n.slice(2);
  else if (/^[2-5][0-9]{9}$/.test(n)) n = "0" + n;
  return n;
}

// Desen eşlemesi (Asterisk'in X, [..] ve . kurallarıyla), testler ve panel önizlemesi için.
export function matches(pattern: string, number: string): boolean {
  let re = "";
  for (let i = 1; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "X") re += "[0-9]";
    else if (c === ".") re += ".+";
    else if (c === "[") {
      const j = pattern.indexOf("]", i);
      re += pattern.slice(i, j + 1);
      i = j;
    } else re += c;
  }
  return new RegExp(`^${re}$`).test(number);
}

export const allowed = (p: Policy, number: string) => dialPatterns(p).some((d) => matches(d.pattern, number));
