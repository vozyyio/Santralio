// Yapay zekâ servisinden rezervasyon işlemleri: API sürecinin iç ucuna (/api/internal/booking) gider.
// Ana anahtar ve ödeme kimlik bilgileri yalnızca API sürecindedir; bu servis yalnızca ortak iç anahtarı taşır.

import type { CreateResult, FoundBooking, QuoteResult, ToolExec } from "./assistant.ts";
import type { BookingRequest } from "./providers.ts";

const API = process.env.SANTRALIO_INTERNAL_API ?? `http://127.0.0.1:${process.env.SANTRALIO_API_PORT ?? 8090}`;

export type CallInfo = { prefix: string; phone: string | null; callId: string | null; aiSessionId: number | null };

export function httpExec(key: string, call: CallInfo, fetchFn: typeof fetch = fetch): ToolExec {
  const post = async (action: string, request: BookingRequest | null) => {
    const res = await fetchFn(`${API}/api/internal/booking`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": key },
      body: JSON.stringify({ prefix: call.prefix, action, request, ctx: { phone: call.phone, callId: call.callId, aiSessionId: call.aiSessionId } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `iç uç ${res.status}`);
    return body;
  };
  return {
    quote: (r) => post("quote", r) as Promise<QuoteResult>,
    create: (r) => post("create", r) as Promise<CreateResult>,
    lookup: () => post("lookup", null) as Promise<FoundBooking[]>,
  };
}
