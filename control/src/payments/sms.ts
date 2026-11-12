// Ödeme bağlantısı SMS'i. İşlem bildirimidir (ticari ileti değil): İYS süzgeci "bilgilendirme" (0).
// Netgsm REST v2: POST https://api.netgsm.com.tr/sms/rest/v2/send, HTTP Basic (kullanıcı kodu:şifre), JSON gövde.

import { ProviderError, type Fetch } from "./types.ts";

export function netgsmNumber(phone: string): string | null {
  const m = /^\+90(5\d{9})$/.exec(phone);
  return m ? m[1] : null;
}

export async function netgsmSend(c: Record<string, string>, phone: string, text: string, f: Fetch): Promise<void> {
  const no = netgsmNumber(phone);
  if (!no) throw new ProviderError("SMS yalnızca Türkiye cep numaralarına gönderilir");
  const res = await f("https://api.netgsm.com.tr/sms/rest/v2/send", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${c.usercode}:${c.password}`).toString("base64"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ msgheader: c.msgheader, encoding: "TR", iysfilter: "0", messages: [{ msg: text, no }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (body.code !== "00") throw new ProviderError(`Netgsm SMS: ${body.description ?? body.code ?? res.status}`);
}

export function validateNetgsm(c: Record<string, string>): string | null {
  if (!/^\d{6,15}$/.test(c.usercode ?? "")) return "Netgsm kullanıcı kodu (abone no) rakamlardan oluşmalı";
  if (!c.password) return "Netgsm API şifresi eksik";
  if (!/^.{2,11}$/.test(c.msgheader ?? "")) return "SMS başlığı (onaylı gönderici adı) 2-11 karakter olmalı";
  return null;
}

// SMS metni: {firma} {tutar} {aciklama}. Bağlantı her zaman metnin sonundadır.
export function smsText(template: string, v: { company: string; amount: string; currency: string; description: string; link: string }) {
  const money = `${Number(v.amount).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${v.currency === "TRY" ? "TL" : v.currency}`;
  const base = (template.trim() || "{firma}: {aciklama} için {tutar} ödemeniz:")
    .replaceAll("{firma}", v.company)
    .replaceAll("{tutar}", money)
    .replaceAll("{aciklama}", v.description)
    .replaceAll("{link}", "")
    .trim();
  return `${base} ${v.link}`.slice(0, 600);
}
