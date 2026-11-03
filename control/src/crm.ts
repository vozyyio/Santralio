// Santralio: CRM işlemleri. Müşteri kartları, numaradan kart bulma, görüşme notları ve sonuç kodları.
// Her işlem kiracı kimliğiyle çağrılır ve yalnızca o kiracının kayıtlarına dokunur.

import { audit, tx, type Db } from "./db.ts";
import { UserError, type Tenant } from "./ops.ts";
import { normalizeNumber } from "./outbound.ts";

export type ContactInput = { name: string; company?: string; email?: string; phones: string[]; tags?: string[] };

function cleanPhones(phones: unknown): string[] {
  if (!Array.isArray(phones)) throw new UserError("phones bir liste olmalı");
  const out = new Set<string>();
  for (const p of phones) {
    if (typeof p !== "string" || !p.trim()) continue;
    const n = normalizeNumber(p);
    if (!n) throw new UserError(`geçersiz telefon: ${p}`);
    out.add(n);
  }
  if (out.size > 10) throw new UserError("bir kartta en fazla 10 telefon");
  return [...out];
}

function cleanTags(tags: unknown): string[] {
  if (tags == null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) throw new UserError("tags metin listesi olmalı");
  const out = [...new Set((tags as string[]).map((t) => t.trim()).filter(Boolean))];
  if (out.length > 20 || out.some((t) => t.length > 40)) throw new UserError("en fazla 20 etiket, her biri en fazla 40 karakter");
  return out;
}

export async function saveContact(db: Db, t: Tenant, id: number | null, c: ContactInput, actor?: string): Promise<number> {
  const name = String(c.name ?? "").trim();
  if (!name || name.length > 200) throw new UserError("ad 1–200 karakter olmalı");
  const company = String(c.company ?? "").trim().slice(0, 200);
  const email = String(c.email ?? "").trim().slice(0, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("geçersiz e-posta");
  const phones = cleanPhones(c.phones);
  const tags = cleanTags(c.tags);
  return tx(db, async () => {
    let contactId = id;
    if (id === null) {
      contactId = (
        await db.query("INSERT INTO contacts (tenant_id, name, company, email, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
          t.id,
          name,
          company,
          email,
          tags,
          actor ?? null,
        ])
      ).rows[0].id;
    } else {
      const r = await db.query("UPDATE contacts SET name = $3, company = $4, email = $5, tags = $6, updated_at = now() WHERE id = $1 AND tenant_id = $2", [
        id,
        t.id,
        name,
        company,
        email,
        tags,
      ]);
      if (!r.rowCount) throw new UserError("kart bulunamadı", 404);
      await db.query("DELETE FROM contact_phones WHERE contact_id = $1 AND tenant_id = $2", [id, t.id]);
    }
    for (const p of phones) {
      const other = (
        await db.query("SELECT c.name FROM contact_phones cp JOIN contacts c ON c.id = cp.contact_id WHERE cp.tenant_id = $1 AND cp.phone = $2", [t.id, p])
      ).rows[0];
      if (other) throw new UserError(`${p} numarası başka bir kartta kayıtlı: ${other.name}`);
      await db.query("INSERT INTO contact_phones (contact_id, tenant_id, phone) VALUES ($1, $2, $3)", [contactId, t.id, p]);
    }
    await audit(db, id === null ? "contact.add" : "contact.update", t.id, { id: contactId, name }, actor);
    return contactId!;
  });
}

const CONTACT_SQL = `SELECT c.id, c.name, c.company, c.email, c.tags, c.created_at, c.updated_at,
         COALESCE((SELECT array_agg(phone ORDER BY phone) FROM contact_phones p WHERE p.contact_id = c.id), '{}') AS phones
    FROM contacts c`;

export async function searchContacts(db: Db, t: Tenant, q: string, limit = 50) {
  const term = q.trim();
  if (!term) {
    return (await db.query(`${CONTACT_SQL} WHERE c.tenant_id = $1 ORDER BY c.updated_at DESC LIMIT $2`, [t.id, limit])).rows;
  }
  const digits = term.replace(/\D/g, "");
  const phone = digits.length >= 4 ? (normalizeNumber(term) ?? digits) : null;
  return (
    await db.query(
      `${CONTACT_SQL}
        WHERE c.tenant_id = $1 AND (
              lower(c.name) LIKE '%' || lower($2) || '%' OR lower(c.company) LIKE '%' || lower($2) || '%' OR lower(c.email) LIKE '%' || lower($2) || '%'
              OR $2 = ANY (c.tags)
              OR ($3::text IS NOT NULL AND EXISTS (SELECT 1 FROM contact_phones p WHERE p.contact_id = c.id AND p.phone LIKE '%' || $3 || '%')))
        ORDER BY c.updated_at DESC LIMIT $4`,
      [t.id, term.replace(/[%_\\]/g, ""), phone, limit],
    )
  ).rows;
}

export async function getContact(db: Db, t: Tenant, id: number) {
  const c = (await db.query(`${CONTACT_SQL} WHERE c.id = $1 AND c.tenant_id = $2`, [id, t.id])).rows[0];
  if (!c) throw new UserError("kart bulunamadı", 404);
  return c;
}

// Gelen ya da giden aramada numaradan kart (temsilci ekranında kartın açılması).
export async function lookupByPhone(db: Db, t: Tenant, raw: string) {
  const phone = normalizeNumber(raw);
  if (!phone) return { phone: null, contact: null };
  const row = (await db.query("SELECT contact_id FROM contact_phones WHERE tenant_id = $1 AND phone = $2", [t.id, phone])).rows[0];
  return { phone, contact: row ? await getContact(db, t, row.contact_id) : null };
}

export async function interactionsOf(db: Db, t: Tenant, where: { contactId?: number; phone?: string }, limit = 50) {
  const cond = where.contactId !== undefined ? "i.contact_id = $2" : "i.phone = $2";
  return (
    await db.query(
      `SELECT i.id, i.external_id AS callid, i.direction, i.phone, i.note, i.user_email AS "user", d.name AS disposition,
              to_char(i.started_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS at,
              to_char(i.follow_up_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') AS "followUpAt"
         FROM interactions i LEFT JOIN dispositions d ON d.id = i.disposition_id
        WHERE i.tenant_id = $1 AND ${cond} ORDER BY i.started_at DESC LIMIT ${Math.min(limit, 200)}`,
      [t.id, where.contactId ?? where.phone],
    )
  ).rows;
}

export type NoteInput = {
  callid?: string | null;
  phone?: string | null;
  contactId?: number | null;
  direction?: "in" | "out" | null;
  dispositionId?: number | null;
  note?: string;
  followUpAt?: string | null; // "YYYY-MM-DDTHH:MM" (İstanbul saati)
};

// Görüşme notu. Aynı görüşmeye aynı kullanıcının ikinci notu öncekini günceller.
export async function saveNote(db: Db, t: Tenant, user: { email: string; extension_id: number | null }, n: NoteInput) {
  const note = String(n.note ?? "").slice(0, 5000);
  const phone = n.phone ? normalizeNumber(n.phone) : null;
  if (n.phone && !phone) throw new UserError("geçersiz telefon");
  const callid = n.callid && /^\d{6,12}\.\d{1,8}$/.test(n.callid) ? n.callid : null;
  if (n.contactId != null) {
    const ok = (await db.query("SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2", [n.contactId, t.id])).rowCount;
    if (!ok) throw new UserError("kart bulunamadı");
  }
  if (n.dispositionId != null) {
    const ok = (await db.query("SELECT 1 FROM dispositions WHERE id = $1 AND tenant_id = $2 AND enabled", [n.dispositionId, t.id])).rowCount;
    if (!ok) throw new UserError("sonuç kodu bulunamadı");
  }
  if (n.followUpAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(n.followUpAt)) throw new UserError("geri arama zamanı YYYY-AA-GGTSS:DD olmalı");
  if (!note && n.dispositionId == null) throw new UserError("not ya da sonuç kodu gerekli");
  // Numara karta bağlıysa ve kart verilmemişse kart numaradan bulunur.
  let contactId = n.contactId ?? null;
  if (contactId === null && phone) {
    contactId = (await db.query("SELECT contact_id FROM contact_phones WHERE tenant_id = $1 AND phone = $2", [t.id, phone])).rows[0]?.contact_id ?? null;
  }
  const existing = callid
    ? (await db.query("SELECT id FROM interactions WHERE tenant_id = $1 AND external_id = $2 AND user_email = $3", [t.id, callid, user.email])).rows[0]
    : null;
  const follow = n.followUpAt ? `${n.followUpAt}:00` : null;
  if (existing) {
    await db.query(
      `UPDATE interactions SET note = $2, disposition_id = $3, contact_id = COALESCE($4, contact_id), follow_up_at = ($5::timestamp AT TIME ZONE 'Europe/Istanbul')
        WHERE id = $1`,
      [existing.id, note, n.dispositionId ?? null, contactId, follow],
    );
    return existing.id as number;
  }
  const r = await db.query(
    `INSERT INTO interactions (tenant_id, channel, external_id, extension_id, contact_id, phone, direction, disposition_id, note, follow_up_at, user_email)
     VALUES ($1, 'voice', $2, $3, $4, $5, $6, $7, $8, ($9::timestamp AT TIME ZONE 'Europe/Istanbul'), $10) RETURNING id`,
    [t.id, callid, user.extension_id, contactId, phone, n.direction ?? null, n.dispositionId ?? null, note, follow, user.email],
  );
  return r.rows[0].id as number;
}

// --- Sonuç kodları ---

export async function listDispositions(db: Db, t: Tenant, all = false) {
  return (
    await db.query(`SELECT id, name, sort, enabled FROM dispositions WHERE tenant_id = $1 ${all ? "" : "AND enabled"} ORDER BY sort, name`, [t.id])
  ).rows;
}

export async function saveDisposition(db: Db, t: Tenant, id: number | null, name: string, enabled: boolean, actor?: string) {
  const n = name.trim();
  if (!n || n.length > 50) throw new UserError("sonuç kodu 1–50 karakter olmalı");
  const r = await db
    .query(
      id === null
        ? "INSERT INTO dispositions (tenant_id, name, sort, enabled) VALUES ($1, $2, (SELECT COALESCE(max(sort), 0) + 1 FROM dispositions WHERE tenant_id = $1), $3) RETURNING id"
        : "UPDATE dispositions SET name = $2, enabled = $3 WHERE tenant_id = $1 AND id = $4 RETURNING id",
      id === null ? [t.id, n, enabled] : [t.id, n, enabled, id],
    )
    .catch((err) => {
      if (err.code === "23505") throw new UserError(`bu sonuç kodu zaten var: ${n}`);
      throw err;
    });
  if (!r.rowCount) throw new UserError("sonuç kodu bulunamadı", 404);
  await audit(db, id === null ? "disposition.add" : "disposition.update", t.id, { name: n, enabled }, actor);
  return r.rows[0].id as number;
}

export async function createDefaultDispositions(db: Db, tenantId: number) {
  const names = ["Çözüldü", "Bilgi verildi", "Geri aranacak", "Satış", "Şikâyet", "Yanlış numara"];
  for (const [i, n] of names.entries()) {
    await db.query("INSERT INTO dispositions (tenant_id, name, sort) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [tenantId, n, i + 1]);
  }
}
