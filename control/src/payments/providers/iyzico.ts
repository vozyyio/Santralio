// iyzico Link API (https://docs.iyzico.com/urunler/iyzilink/iyzilink-api): stoklu (tek kullanımlık) ödeme bağlantısı.
// iyzico Link için bağlantı başına bildirim yok; ödeme, sunucudan durum sorgusuyla (satış adedi) anlaşılır.
// Kimlik doğrulama: IYZWSv2 (HMAC-SHA256, randomKey + uri yolu + gövde).
// NOT: Gerçek iyzico sandbox hesabıyla uçtan uca doğrulanmadan canlıya alınmamalı.

import { createHmac, randomBytes } from "node:crypto";
import { ProviderError, type Fetch, type Mode, type PaymentProvider } from "../types.ts";

const BASE: Record<Mode, string> = { live: "https://api.iyzipay.com", test: "https://sandbox-api.iyzipay.com" };
// Bağlantı sayfasında görünen ürün görseli (iyzico zorunlu tutuyor).
const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAIAAAAErfB6AAAB10lEQVR42u3dMU4CURSG0Yeho6QwsabU1oTOJVi5SCuWQEdiq2sgcRc2FhMcBmMiM/ef83UzVHDyhkvIy1us1pum3G58BIAFWIAFWIAFWIABC7AAC7AAC7AAAxZgARZgARZgARZgwAIswAIswAIswIAFWIAFWIAFWIABC7Bqtgx7P3fPh+7lcbe1gmN1e+8AztFlnAM8rDhnY0MWYAEWYAEWYAEW4Dm19BGcdLt/615+Pj1awbG6vXcA5+gGGAP+lWJdY8CmaAEWYPkd3NrD60f38v3lnlDOCj7R7b2jqsDnLBknAA8rMjZkqciQldGkRkUrOHxUBBw+KgIOHxUBm6IFWIAFWIAFWIABC7AAC7AAC7AAAxZgARZgARZgARZgwAKs74b3II21QwnwNYxH3H8G+N+Nx91daPvotZ/VVrDigKc5ngAOH08Ah48nGU1ryCJqyBJgAQYswFkNn65S9+wVwJcVS5+sA/iCZfVzk/zZ0MJErWBDlgALsAALsAALMODqHXfbP78KuLbxnHXTHtE/LWeu21pbrNYbX1RWsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABVsG+AGdHWdofC03rAAAAAElFTkSuQmCC";

export function authorization(apiKey: string, secretKey: string, randomKey: string, uriPath: string, body: string): string {
  const signature = createHmac("sha256", secretKey).update(randomKey + uriPath + body).digest("hex");
  return "IYZWSv2 " + Buffer.from(`apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`).toString("base64");
}

async function call(f: Fetch, c: Record<string, string>, mode: Mode, method: string, path: string, query = "", body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const rnd = Date.now() + randomBytes(6).toString("hex");
  const res = await f(BASE[mode] + path + query, {
    method,
    headers: {
      authorization: authorization(c.api_key, c.secret_key, rnd, path, raw),
      "x-iyzi-rnd": rnd,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: raw || undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let out: any;
  try {
    out = await res.json();
  } catch {
    throw new ProviderError(`iyzico beklenmeyen yanıt (${res.status})`);
  }
  if (out.status !== "success") throw new ProviderError(`iyzico: ${out.errorMessage ?? out.errorCode ?? "hata"}`);
  return out;
}

export const iyzico: PaymentProvider = {
  validate(c) {
    if (!c.api_key || c.api_key.length < 8) return "API anahtarı eksik";
    if (!c.secret_key || c.secret_key.length < 8) return "Gizli anahtar eksik";
    return null;
  },

  async test(c, mode, f) {
    await call(f, c, mode, "GET", "/v2/iyzilink/products", "?locale=tr&page=1&count=1");
  },

  async createLink(c, mode, req, f) {
    const out = await call(f, c, mode, "POST", "/v2/iyzilink/products", "", {
      locale: req.locale,
      conversationId: req.reference,
      name: req.description.slice(0, 80),
      description: req.description,
      price: req.money.amount,
      currencyCode: req.money.currency,
      encodedImageFile: IMAGE,
      addressIgnorable: true,
      installmentRequested: req.maxInstallment > 1,
      stockEnabled: true,
      stockCount: 1,
    });
    if (!out.data?.token || !out.data?.url) throw new ProviderError("iyzico bağlantı bilgisi dönmedi");
    return { providerRef: String(out.data.token), url: String(out.data.url) };
  },

  async fetchStatus(c, mode, ref, f) {
    const out = await call(f, c, mode, "GET", `/v2/iyzilink/products/${encodeURIComponent(ref)}`, "?locale=tr");
    const d = out.data ?? {};
    if (Number(d.soldCount) >= 1) return { state: "paid", paidAmount: typeof d.price === "string" ? d.price : String(d.price ?? "") || undefined };
    return { state: "pending" };
  },

  async cancelLink(c, mode, ref, f) {
    await call(f, c, mode, "DELETE", `/v2/iyzilink/products/${encodeURIComponent(ref)}`, "?locale=tr");
  },
};
