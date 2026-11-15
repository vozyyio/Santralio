// Santralio: kanaldan bağımsız asistan adımı (telefon ve web sohbeti aynı mantığı kullanır).
//
// respond(): modelden karar alır. Karar bir sistem işlemiyse (quote / book / lookup) önce kısa ara cümle söylenir,
// işlem yapılır, sonucu "tool" turu olarak eklenir ve model yeniden sorulur (en fazla 3 işlem). Sonunda konuşma,
// aktarma ya da kapatma kararı döner.
// Kurallar kodda da denetlenir: fiyat sorulmadan rezervasyon oluşturulmaz, onaylanan bilgiler fiyatı sorulanla aynı olmalı,
// görüşme başına en fazla 4 fiyat sorgusu ve 1 rezervasyon.

import type { BookingRequest, Decision, FlowContext, LanguageModel, Turn } from "./providers.ts";

export type QuoteResult = { available: boolean; price: { amount: string; currency: string } | null; message: string | null };
export type CreateResult = {
  reference: string;
  status: "pending" | "confirmed";
  price: { amount: string; currency: string } | null;
  // url: yalnızca web sohbetinde ekranda düğme olarak gösterilir (modele verilmez).
  payment: { sent: boolean; reason: string | null; url?: string | null } | null;
};
export type FoundBooking = { reference: string; service: string; summary: string; date: string | null; status: string };

// Gerçek işlemi yapan taraf: API sürecinde doğrudan, yapay zekâ servisinde iç HTTP ucu üzerinden.
export interface ToolExec {
  quote(req: BookingRequest): Promise<QuoteResult>;
  create(req: BookingRequest): Promise<CreateResult>;
  lookup(): Promise<FoundBooking[]>;
}

export type ToolState = {
  quotes: number;
  booked: boolean;
  lastQuote: { key: string; result: QuoteResult } | null;
  channel?: "phone" | "chat";
  // Web sohbeti: oluşan rezervasyon ve ödeme bağlantısı ekranda gösterilir.
  created?: { reference: string; paymentUrl: string | null } | null;
};
export const newState = (channel: "phone" | "chat" = "phone"): ToolState => ({ quotes: 0, booked: false, lastQuote: null, channel, created: null });

const MAX_QUOTES = 4;
const keyOf = (r: BookingRequest) =>
  JSON.stringify([r.service, Object.entries(r.fields).map(([k, v]) => [k, v.trim().toLocaleLowerCase("tr").replace(/ı/g, "i")]).sort()]);
const money = (p: { amount: string; currency: string }) => `${p.amount} ${p.currency}`;
const spell = (ref: string) => ref.split("").join(" ");

export async function runTool(exec: ToolExec, state: ToolState, d: Decision): Promise<string> {
  try {
    if (d.action === "lookup") {
      const rows = await exec.lookup();
      if (!rows.length) return "Bu numaraya kayıtlı güncel rezervasyon bulunamadı.";
      return `Bu numaraya kayıtlı rezervasyonlar: ${rows
        .map((b) => `${b.service}${b.date ? `, ${b.date}` : ""}, durum: ${b.status}, numara: ${b.reference}`)
        .join("; ")}. Kişisel bilgi okuma.`;
    }
    if (!d.booking) return "Hata: rezervasyon bilgisi eksik; hizmeti ve alanları yaz.";
    if (d.action === "quote") {
      if (state.quotes >= MAX_QUOTES) return "Bu görüşmede fiyat sorgusu sınırına ulaşıldı. Arayanı temsilciye aktar.";
      state.quotes++;
      const r = await exec.quote(d.booking);
      state.lastQuote = { key: keyOf(d.booking), result: r };
      if (!r.available) return `Müsait değil.${r.message ? ` Sistem notu: ${r.message}` : ""} Arayana başka bir tarih ya da seçenek öner veya temsilciye aktar.`;
      return `Müsait. ${r.price ? `Fiyat: ${money(r.price)}.` : "Fiyat sistemde yok; ekibin teyit edeceğini söyle."}${r.message ? ` Sistem notu: ${r.message}` : ""} Bilgileri özetleyip onay iste.`;
    }
    // book
    if (state.booked) return "Bu görüşmede zaten bir rezervasyon oluşturuldu. İkinci rezervasyon için temsilciye aktar.";
    if (!state.lastQuote || state.lastQuote.key !== keyOf(d.booking))
      return "Hata: bu bilgilerle henüz müsaitlik sorulmadı ya da bilgiler değişti. Önce aynı bilgilerle quote seç.";
    if (!state.lastQuote.result.available) return "Hata: seçilen seçenek müsait değil; rezervasyon oluşturulamaz.";
    state.booked = true;
    const r = await exec.create(d.booking);
    const chat = state.channel === "chat";
    state.created = { reference: r.reference, paymentUrl: r.payment?.url ?? null };
    const pay = r.payment
      ? chat && r.payment.url
        ? ` Ödeme bağlantısı ekranda "Ödeme yap" düğmesi olarak gösterildi${r.payment.sent ? " ve cep telefonuna kısa mesajla da gönderildi" : ""}.`
        : r.payment.sent
          ? " Ödeme bağlantısı cep telefonuna kısa mesajla gönderildi."
          : ` Ödeme bağlantısı gönderilemedi (${r.payment.reason ?? "bilinmiyor"}); ekibin ileteceğini söyle.`
      : "";
    return `Rezervasyon ${r.status === "confirmed" ? "onaylandı" : "alındı, ekip teyit edecek"}. Numara: ${chat ? r.reference : spell(r.reference)}.${r.price ? ` Tutar: ${money(r.price)}.` : ""}${pay}`;
  } catch (e) {
    return `Sistem şu an yanıt veremedi (${e instanceof Error ? e.message.slice(0, 120) : "hata"}). Arayandan özür dile ve temsilciye aktar.`;
  }
}

const TOOL_ACTIONS = new Set(["quote", "book", "lookup"]);

export async function respond(
  llm: LanguageModel,
  flow: FlowContext,
  history: Turn[],
  tools: { exec: ToolExec; state: ToolState } | null,
  onInterim: (text: string, language: string) => Promise<void>,
): Promise<Decision> {
  let inputTokens = 0;
  let outputTokens = 0;
  for (let i = 0; i < 4; i++) {
    const d = await llm.decide(flow, history);
    inputTokens += d.inputTokens;
    outputTokens += d.outputTokens;
    if (!TOOL_ACTIONS.has(d.action)) return { ...d, inputTokens, outputTokens };
    if (!tools) return { ...d, action: "say", inputTokens, outputTokens };
    if (d.say.trim()) await onInterim(d.say, d.language);
    const result = await runTool(tools.exec, tools.state, d);
    history.push({ role: "tool", text: result });
  }
  // Döngüden çıkılamadı: güvenli taraf, aktarma.
  return { action: "transfer", say: "", target: null, summary: "Asistan rezervasyon adımında takıldı.", language: flow.languages[0], inputTokens, outputTokens };
}
