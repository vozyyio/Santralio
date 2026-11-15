// Santralio: asistanın rezervasyon işlemlerini gerçekten yapan taraf (API sürecinde çalışır; anahtarlar burada).
// Yapay zekâ servisi bunu iç uçtan (/api/internal/booking) kullanır; web sohbeti doğrudan.
// Ödeme bağlantısı: hizmet ödeme istiyorsa (ya da isteğe bağlıysa ve arayan istediyse) tutar rezervasyon bağlantısının
// döndürdüğü fiyattan, sunucu tarafında alınır; yapay zekâ tutar belirleyemez.

import * as booking from "./booking.ts";
import type { CreateResult, FoundBooking, QuoteResult, ToolExec } from "./ai/assistant.ts";
import type { BookingRequest } from "./ai/providers.ts";
import * as payments from "./payments/service.ts";

export type ExecDeps = { booking: booking.Deps; pay: payments.Deps };
export type ExecCtx = { source: "phone" | "chat"; phone: string | null; callId: string | null; aiSessionId: number | null };

const mobile = (v: string | null) => {
  const p = payments.normalizePhone(v);
  return p && /^\+905\d{9}$/.test(p) ? p : null;
};

export function directExec(deps: ExecDeps, tenant: { id: number; name: string }, ctx: ExecCtx): ToolExec {
  // Arayan sabit hattan aradıysa ödeme bağlantısı hizmetin telefon alanındaki cep numarasına gider.
  return {
    quote: (req: BookingRequest): Promise<QuoteResult> => booking.quote(deps.booking, tenant.id, { service: req.service, fields: req.fields }, { phone: ctx.phone }),
    async create(req: BookingRequest): Promise<CreateResult> {
      // Web sohbetinde numara bilinmez: kullanıcının yazdığı telefon alanı kullanılır.
      const contact = ctx.phone ?? Object.values(req.fields).map((v) => payments.normalizePhone(v)).find(Boolean) ?? null;
      const c = await booking.create(deps.booking, tenant.id, { service: req.service, fields: req.fields }, { ...ctx, phone: contact, customerName: req.customerName });
      let payment: CreateResult["payment"] = null;
      const wants = c.payment === "required" || (c.payment === "optional" && req.payNow);
      if (wants) {
        const phone = mobile(contact) ?? Object.values(req.fields).map(mobile).find(Boolean) ?? null;
        if (!c.price) payment = { sent: false, reason: "tutar belli değil" };
        else if (!phone && ctx.source !== "chat") payment = { sent: false, reason: "cep telefonu numarası yok" };
        else {
          try {
            const p = await payments.createRequest(deps.pay, tenant, {
              amount: c.price.amount,
              currency: c.price.currency,
              description: `Rezervasyon ${c.reference}`,
              phone,
              callId: ctx.callId,
              createdBy: "booking",
              sendSms: !!phone,
            });
            await deps.booking.db.query("UPDATE bookings SET payment_ref = $2, updated_at = now() WHERE id = $1", [c.bookingId, p.id]);
            const failed = (p as { failed?: boolean }).failed;
            const url = !failed && ctx.source === "chat" ? (p.linkUrl ?? null) : null;
            const shown = url ? { url } : {};
            payment = failed
              ? { sent: false, reason: "ödeme sağlayıcısı bağlantı oluşturamadı" }
              : p.smsStatus === "sent"
                ? { sent: true, reason: null, ...shown }
                : { sent: false, reason: url ? null : "SMS gönderilemedi", ...shown };
          } catch (e) {
            payment = { sent: false, reason: e instanceof Error ? e.message.slice(0, 100) : "ödeme hatası" };
          }
        }
      }
      return { reference: c.reference, status: c.status, price: c.price, payment };
    },
    lookup: (): Promise<FoundBooking[]> => booking.lookup(deps.booking, tenant.id, ctx.phone),
  };
}
