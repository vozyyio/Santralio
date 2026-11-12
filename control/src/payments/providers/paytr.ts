// PayTR Link API (https://dev.paytr.com/link-api): ödeme bağlantısı, PayTR'ın kendi SMS'i ve sunucu bildirimi.
// Kart bilgisi PayTR sayfasında girilir. Bildirim yalnızca başarılı ödemede gelir (başarısızlar için gelmez).
// Test modu PayTR mağaza panelinde açılır; uç adresler aynıdır.

import { createHmac, timingSafeEqual } from "node:crypto";
import { minor, ProviderError, type CallbackInput, type CallbackResult, type Fetch, type LinkRequest, type PaymentProvider } from "../types.ts";

const BASE = "https://www.paytr.com/odeme/api/link";
const token = (key: string, data: string) => createHmac("sha256", key).update(data).digest("base64");
const CUR: Record<string, string> = { TRY: "TL", USD: "USD", EUR: "EUR", GBP: "GBP" };

// PayTR son kullanma tarihini "YYYY-MM-DD HH:mm:ss" (Türkiye saati) bekler.
export function istanbulTime(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

// callback_id yalnızca harf ve rakam olabilir: "pay_" öneki atılır, bildirimde geri eklenir.
const callbackId = (ref: string) => ref.replace(/^pay_/, "");

// PayTR SMS'i 05XXXXXXXXX biçimini bekler (yalnızca Türkiye cep numaraları).
export function trMobile(phone: string): string | null {
  const m = /^\+905(\d{9})$/.exec(phone);
  return m ? `05${m[1]}` : null;
}

async function post(f: Fetch, path: string, form: Record<string, string>) {
  const res = await f(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError(`PayTR beklenmeyen yanıt (${res.status})`);
  }
  if (body.status !== "success") throw new ProviderError(`PayTR: ${body.err_msg ?? body.reason ?? body.status ?? "hata"}`);
  return body;
}

export function linkForm(c: Record<string, string>, req: LinkRequest): Record<string, string> {
  const name = req.description.slice(0, 200);
  const price = String(minor(req.money.amount));
  const currency = CUR[req.money.currency];
  const maxInstallment = String(Math.min(12, Math.max(1, req.maxInstallment)));
  const linkType = "product";
  const lang = req.locale;
  const minCount = "1";
  return {
    merchant_id: c.merchant_id,
    name,
    price,
    currency,
    max_installment: maxInstallment,
    link_type: linkType,
    lang,
    min_count: minCount,
    max_count: "1", // tek ödeme: stok 1, ödenince bağlantı kapanır
    expiry_date: istanbulTime(req.expiresAt),
    callback_link: req.callbackUrl,
    callback_id: callbackId(req.reference),
    debug_on: "0",
    paytr_token: token(c.merchant_key, name + price + currency + maxInstallment + linkType + lang + minCount + c.merchant_salt),
  };
}

export function callbackHash(c: Record<string, string>, p: Record<string, string>) {
  return token(c.merchant_key, (p.callback_id ?? "") + (p.merchant_oid ?? "") + c.merchant_salt + (p.status ?? "") + (p.total_amount ?? ""));
}

export const paytr: PaymentProvider = {
  validate(c) {
    if (!/^\d{1,12}$/.test(c.merchant_id ?? "")) return "Mağaza no yalnızca rakam olmalı";
    if (!c.merchant_key || c.merchant_key.length < 8) return "Merchant key eksik";
    if (!c.merchant_salt || c.merchant_salt.length < 8) return "Merchant salt eksik";
    return null;
  },

  // Gerçek bir bağlantı oluşturup hemen siler: bilgiler ve Link API yetkisi doğrulanır, para hareketi olmaz.
  async test(c, _mode, f) {
    const form = linkForm(c, {
      reference: "pay_santraliobaglantitesti",
      description: "Santralio bağlantı testi",
      money: { amount: "1.00", currency: "TRY" },
      maxInstallment: 1,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      callbackUrl: "",
      phone: null,
      locale: "tr",
    });
    form.callback_link = "";
    form.callback_id = "";
    const body = await post(f, "create", form);
    await paytr.cancelLink!(c, "test", String(body.id), f).catch(() => {});
  },

  async createLink(c, _mode, req, f) {
    const body = await post(f, "create", linkForm(c, req));
    if (!body.id || !body.link) throw new ProviderError("PayTR bağlantı bilgisi dönmedi");
    return { providerRef: String(body.id), url: String(body.link) };
  },

  async sendLinkSms(c, _mode, ref, phone, f) {
    const cell = trMobile(phone);
    if (!cell) throw new ProviderError("PayTR SMS yalnızca Türkiye cep numaralarına gider");
    await post(f, "send-sms", { merchant_id: c.merchant_id, id: ref, cell_phone: cell, debug_on: "0", paytr_token: token(c.merchant_key, ref + c.merchant_id + cell + c.merchant_salt) });
  },

  async cancelLink(c, _mode, ref, f) {
    await post(f, "delete", { merchant_id: c.merchant_id, id: ref, debug_on: "0", paytr_token: token(c.merchant_key, ref + c.merchant_id + c.merchant_salt) });
  },

  verifyCallback(c, _mode, input: CallbackInput): CallbackResult {
    // PayTR bildirimi "OK" yanıtı bekler; doğrulanamayan bildirime OK dışı yanıt verilir.
    const fail = (reason: string): CallbackResult => ({ ok: false, reason, reply: { status: 400, type: "text/plain", body: "PAYTR notification failed" } });
    const p = Object.fromEntries(new URLSearchParams(input.rawBody.toString("utf8")));
    if (!p.hash || !p.merchant_oid || !p.callback_id) return fail("eksik alan");
    if (p.merchant_id && p.merchant_id !== c.merchant_id) return fail("mağaza no uyuşmuyor");
    const want = Buffer.from(callbackHash(c, p));
    const got = Buffer.from(p.hash);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return fail("imza geçersiz");
    // Ödenen tutar (kuruş). Taksitte toplam (vade farklı) tutar ayrıca gelir; talep tutarıyla payment_amount karşılaştırılır.
    const paid = p.payment_amount ?? p.total_amount;
    const paidAmount = paid && /^\d+$/.test(paid) ? `${BigInt(paid) / 100n}.${String(BigInt(paid) % 100n).padStart(2, "0")}` : undefined;
    return {
      ok: true,
      dedupeKey: p.merchant_oid,
      reference: `pay_${p.callback_id}`,
      status: p.status === "success" ? { state: "paid", paidAmount } : { state: "failed" },
      reply: { status: 200, type: "text/plain", body: "OK" },
    };
  },
};
