// Santralio: santral ve yapay zekâdan gelen ödeme bağlantısı talepleri.
//
// Dialplan (tN-pay-<profil>) arayan 1'e basınca SANTRALIO_PAY_REQUEST yazar: profil | cep numarası | ivr/ai.
// Burada tutar santralden ya da arayandan alınmaz: createRequest profildeki sabit tutarı ya da işletme sistemini kullanır.
// Numara taklit edilerek başkasına SMS yağdırılmasın diye sınır: aynı numaraya kiracı başına günde 3, kiracı başına günde 300.

import { audit, tx, type Db } from "../db.ts";
import { createRequest, type Deps } from "./service.ts";

export const PER_PHONE_DAY = 3;
export const PER_TENANT_DAY = 300;

export async function scan(d: Deps, batch = 100): Promise<{ sent: number; skipped: number; failed: number }> {
  const db: Db = d.db;
  // İmleç kısa bir transaction'da ilerletilir; bağlantı oluşturma (dış istek) transaction dışında yapılır.
  const rows = await tx(db, async () => {
    const cur = (await db.query("SELECT last_id FROM event_cursors WHERE name = 'payments_ivr' FOR UPDATE")).rows[0];
    const hi = Number((await db.query("SELECT COALESCE(max(id), 0) AS hi FROM queue_log")).rows[0].hi);
    if (!cur) {
      await db.query("INSERT INTO event_cursors (name, last_id) VALUES ('payments_ivr', $1) ON CONFLICT (name) DO NOTHING", [hi]);
      return [];
    }
    const from = Number(cur.last_id);
    if (hi <= from) return [];
    const r = (
      await db.query(
        `SELECT id, callid, queuename, data1, data2, data3 FROM queue_log
          WHERE id > $1 AND id <= $2 AND event = 'SANTRALIO_PAY_REQUEST' ORDER BY id LIMIT $3`,
        [from, hi, batch],
      )
    ).rows;
    await db.query("UPDATE event_cursors SET last_id = $1 WHERE name = 'payments_ivr'", [r.length === batch ? Number(r[r.length - 1].id) : hi]);
    return r;
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    const prefix = String(r.queuename).replace(/_pay$/, "");
    const t = (await db.query("SELECT id, prefix, name FROM tenants WHERE prefix = $1 AND status = 'active'", [prefix])).rows[0];
    const profile = String(r.data1 ?? "");
    const digits = String(r.data2 ?? "").replace(/\D/g, "");
    const by = r.data3 === "ai" ? "ai" : "ivr";
    if (!t || !/^[a-z0-9_]{1,32}$/.test(profile) || digits.length < 10) {
      skipped++;
      continue;
    }
    const phone = "0" + digits.slice(-10);
    const counts = (
      await db.query(
        `SELECT count(*) FILTER (WHERE phone = $2)::int AS phone, count(*)::int AS tenant FROM payment_requests
          WHERE tenant_id = $1 AND created_by IN ('ivr', 'ai') AND created_at > now() - interval '1 day'`,
        [t.id, "+90" + digits.slice(-10)],
      )
    ).rows[0];
    if (counts.phone >= PER_PHONE_DAY || counts.tenant >= PER_TENANT_DAY) {
      skipped++;
      await audit(db, "payments.ivr.limited", t.id, { profile, phone: `…${digits.slice(-4)}`, by }, "payments");
      continue;
    }
    try {
      const req = await createRequest(d, t, { profile, phone, callId: r.callid, createdBy: by, sendSms: true });
      if ((req as { failed?: boolean }).failed) failed++;
      else sent++;
    } catch (e) {
      failed++;
      await audit(db, "payments.ivr.failed", t.id, { profile, by, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }, "payments");
    }
  }
  return { sent, skipped, failed };
}
