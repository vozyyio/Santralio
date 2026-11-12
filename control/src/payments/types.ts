// Ödeme modülü: ortak tipler.
// Kural: kart bilgisi Santralio'ya gelmez (bağlantı yöntemi). Tutar her zaman sunucuda belirlenir.

export type Fetch = typeof fetch;
export type Mode = "test" | "live";
export type Money = { amount: string; currency: Currency }; // amount: "1500.00" (iki ondalık, nokta)
export type Currency = "TRY" | "USD" | "EUR" | "GBP";

export type LinkRequest = {
  reference: string; // pay_… (Santralio talep kimliği; sağlayıcıda eşleşme için)
  description: string;
  money: Money;
  maxInstallment: number;
  expiresAt: Date;
  callbackUrl: string; // sağlayıcının sunucudan bildirim atacağı adres
  phone: string | null; // +90…
  locale: "tr" | "en";
};
export type LinkResult = { providerRef: string; url: string };

export type ProviderStatus = { state: "pending" | "paid" | "failed" | "expired"; paidAmount?: string; last4?: string };

// Sağlayıcının sunucudan gönderdiği bildirim. Doğrulanmamış bildirim hiçbir durumu değiştirmez.
export type CallbackInput = { headers: Record<string, string | undefined>; rawBody: Buffer; contentType: string };
export type CallbackResult =
  | { ok: false; reason: string; reply: Reply }
  | { ok: true; dedupeKey: string; providerRef?: string; reference?: string; status: ProviderStatus; reply: Reply };
export type Reply = { status: number; type: string; body: string };

export interface PaymentProvider {
  // Kimlik bilgileri biçimce doğru mu (bağlantı kurmadan).
  validate(creds: Record<string, string>): string | null;
  // Bağlantıyı dener (ör. küçük bir okuma isteği). Para hareketi yapmaz.
  test(creds: Record<string, string>, mode: Mode, f: Fetch): Promise<void>;
  createLink(creds: Record<string, string>, mode: Mode, req: LinkRequest, f: Fetch): Promise<LinkResult>;
  // Sunucudan durum sorgusu (bildirim gelmediğinde ya da bildirimin teyidi için).
  fetchStatus?(creds: Record<string, string>, mode: Mode, providerRef: string, f: Fetch): Promise<ProviderStatus>;
  verifyCallback?(creds: Record<string, string>, mode: Mode, input: CallbackInput): CallbackResult;
  // Bağlantıyı sağlayıcının kendi SMS servisiyle gönderebiliyorsa.
  sendLinkSms?(creds: Record<string, string>, mode: Mode, providerRef: string, phone: string, f: Fetch): Promise<void>;
  cancelLink?(creds: Record<string, string>, mode: Mode, providerRef: string, f: Fetch): Promise<void>;
}

export class ProviderError extends Error {}

// "1500" / "1500.5" / 1500.5 kabul; "1.500,50" gibi biçimler reddedilir.
export function parseAmount(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = v.toFixed(2);
  if (typeof v !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(v)) return null;
  const [i, d = ""] = v.split(".");
  const out = `${BigInt(i)}.${d.padEnd(2, "0")}`;
  return out === "0.00" ? null : out;
}
// Kuruş (tam sayı) cinsinden; karşılaştırma ve sağlayıcılara gönderim için.
export const minor = (amount: string) => {
  const [i, d] = amount.split(".");
  return BigInt(i) * 100n + BigInt(d);
};
