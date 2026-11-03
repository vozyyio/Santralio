// Santralio: CLI'nin ve API'nin ortak kullandığı kiracı işlemleri.
// Her işlem kiracı kimliğiyle çağrılır ve yalnızca o kiracının kayıtlarına dokunur.
// Doğrulama hataları UserError olarak fırlatılır: CLI "hata:" diye yazar, API 400/404 döner.

import { hashPassword } from "./auth.ts";
import { CURRENT_KEY_ID, masterKey } from "./config.ts";
import { aad, randomToken, seal } from "./crypto.ts";
import { audit, tx, type Db } from "./db.ts";

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Tenant = { id: number; prefix: string; name: string; status: string; reseller_id: number };

const NAME = /^[a-z0-9_]{1,32}$/;
const TARGET = /^(queue|menu|schedule):([a-z0-9_]{1,32})$/;
const WEEKDAYS = /^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function tenantByPrefix(db: Db, prefix: string | undefined): Promise<Tenant> {
  if (!prefix) throw new UserError("kiracı öneki gerekli (ör. t1)");
  const row = (await db.query("SELECT * FROM tenants WHERE prefix = $1", [prefix])).rows[0];
  if (!row) throw new UserError(`kiracı yok: ${prefix}`, 404);
  return row;
}

// Hedef (queue:<ad> | menu:<ad> | schedule:<ad>) aynı kiracıda var olmalı:
// başka kiracının nesnesine yönlendirilemez.
export async function assertTarget(db: Db, t: Tenant, target: string) {
  const m = TARGET.exec(target);
  if (!m) throw new UserError(`geçersiz hedef: ${target} (queue:<ad>, menu:<ad> ya da schedule:<ad>)`);
  const kinds = { queue: ["queues", "kuyruk"], menu: ["menus", "menü"], schedule: ["schedules", "zamanlama"] } as const;
  const [table, label] = kinds[m[1] as keyof typeof kinds];
  const row = (await db.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND name = $2`, [t.id, m[2]])).rows[0];
  if (!row) throw new UserError(`${t.prefix}: ${label} yok: ${m[2]}`);
}

export async function addExtension(db: Db, t: Tenant, number: string, displayName: string, actor?: string): Promise<string> {
  if (!/^[0-9]{2,6}$/.test(number)) throw new UserError("dahili 2–6 haneli olmalı");
  if (/["\r\n;]/.test(displayName)) throw new UserError('görünen ad " ; ya da satır sonu içeremez');
  const lic = (await db.query("SELECT max_extensions FROM licenses WHERE tenant_id = $1", [t.id])).rows[0];
  if (!lic) throw new UserError(`${t.prefix}: lisans kaydı yok`);
  const count = Number((await db.query("SELECT count(*) FROM extensions WHERE tenant_id = $1", [t.id])).rows[0].count);
  if (count >= lic.max_extensions) throw new UserError(`${t.prefix}: lisanstaki dahili sınırı dolu (${lic.max_extensions})`);
  const secret = randomToken(24);
  const sealed = seal(secret, aad.extension(t.id, number), masterKey(CURRENT_KEY_ID), CURRENT_KEY_ID);
  await db
    .query("INSERT INTO extensions (tenant_id, number, display_name, secret_enc, key_id) VALUES ($1, $2, $3, $4, $5)", [
      t.id,
      number,
      displayName,
      sealed.enc,
      sealed.keyId,
    ])
    .catch((err) => {
      if (err.code === "23505") throw new UserError(`${t.prefix}: dahili zaten var: ${number}`);
      throw err;
    });
  await audit(db, "ext.add", t.id, { number }, actor);
  return secret;
}

export type MenuInput = {
  text: string;
  invalidText?: string | null;
  defaultTarget?: string | null;
  timeoutS?: number;
  maxTries?: number;
};

export async function setMenu(db: Db, t: Tenant, name: string, m: MenuInput, actor?: string) {
  if (!NAME.test(name)) throw new UserError("menü adı küçük harf, rakam ve _ olmalı");
  if (!m.text || m.text.length > 1000) throw new UserError("anons metni 1–1000 karakter olmalı");
  if (m.invalidText != null && (!m.invalidText || m.invalidText.length > 500)) throw new UserError("geçersiz seçim anonsu 1–500 karakter olmalı");
  const timeout = m.timeoutS ?? 5;
  const tries = m.maxTries ?? 3;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) throw new UserError("bekleme süresi 1–30 saniye olmalı");
  if (!Number.isInteger(tries) || tries < 1 || tries > 10) throw new UserError("deneme sayısı 1–10 olmalı");
  if (m.defaultTarget) await assertTarget(db, t, m.defaultTarget);
  await db.query(
    `INSERT INTO menus (tenant_id, name, prompt_text, invalid_text, timeout_s, max_tries, default_target)
     VALUES ($1, $2, $3, COALESCE($4, 'Geçersiz bir seçim yaptınız.'), $5, $6, $7)
     ON CONFLICT (tenant_id, name) DO UPDATE SET prompt_text = $3, invalid_text = COALESCE($4, menus.invalid_text),
       timeout_s = $5, max_tries = $6, default_target = $7`,
    [t.id, name, m.text, m.invalidText ?? null, timeout, tries, m.defaultTarget ?? null],
  );
  await audit(db, "menu.set", t.id, { name, text: m.text, default: m.defaultTarget }, actor);
}

export async function setMenuOption(db: Db, t: Tenant, menu: string, digit: string, target: string, actor?: string) {
  if (!/^[0-9*#]$/.test(digit)) throw new UserError("tuş 0-9, * ya da # olmalı");
  const m = (await db.query("SELECT id FROM menus WHERE tenant_id = $1 AND name = $2", [t.id, menu])).rows[0];
  if (!m) throw new UserError(`${t.prefix}: menü yok: ${menu}`, 404);
  await assertTarget(db, t, target);
  await db.query(
    "INSERT INTO menu_options (menu_id, digit, target) VALUES ($1, $2, $3) ON CONFLICT (menu_id, digit) DO UPDATE SET target = $3",
    [m.id, digit, target],
  );
  await audit(db, "menu.option", t.id, { menu, digit, target }, actor);
}

// Menünün tuşlarını verilen listeyle değiştirir (listede olmayan tuşlar kaldırılır).
export async function replaceMenuOptions(db: Db, t: Tenant, menu: string, options: Record<string, string>, actor?: string) {
  const m = (await db.query("SELECT id FROM menus WHERE tenant_id = $1 AND name = $2", [t.id, menu])).rows[0];
  if (!m) throw new UserError(`${t.prefix}: menü yok: ${menu}`, 404);
  for (const [digit, target] of Object.entries(options)) {
    if (!/^[0-9*#]$/.test(digit)) throw new UserError(`geçersiz tuş: ${digit}`);
    await assertTarget(db, t, target);
  }
  await tx(db, async () => {
    await db.query("DELETE FROM menu_options WHERE menu_id = $1", [m.id]);
    for (const [digit, target] of Object.entries(options)) {
      await db.query("INSERT INTO menu_options (menu_id, digit, target) VALUES ($1, $2, $3)", [m.id, digit, target]);
    }
    await audit(db, "menu.options_replace", t.id, { menu, options }, actor);
  });
}

export type ScheduleInput = { openTarget: string; closedText: string; closedTarget?: string | null; timezone?: string };

export async function setSchedule(db: Db, t: Tenant, name: string, s: ScheduleInput, actor?: string) {
  if (!NAME.test(name)) throw new UserError("zamanlama adı küçük harf, rakam ve _ olmalı");
  if (!s.closedText || s.closedText.length > 1000) throw new UserError("kapalı anonsu 1–1000 karakter olmalı");
  await assertTarget(db, t, s.openTarget);
  if (s.closedTarget) await assertTarget(db, t, s.closedTarget);
  const tz = s.timezone ?? "Europe/Istanbul";
  try {
    new Intl.DateTimeFormat("tr", { timeZone: tz });
  } catch {
    throw new UserError(`geçersiz saat dilimi: ${tz}`);
  }
  await db.query(
    `INSERT INTO schedules (tenant_id, name, timezone, open_target, closed_text, closed_target)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, name) DO UPDATE SET timezone = $3, open_target = $4, closed_text = $5, closed_target = $6`,
    [t.id, name, tz, s.openTarget, s.closedText, s.closedTarget ?? null],
  );
  await audit(db, "schedule.set", t.id, { name, open: s.openTarget, closed: s.closedTarget, tz }, actor);
}

export type Hours = { weekdays: string; opens: string; closes: string };

function checkHours(h: Hours) {
  if (!WEEKDAYS.test(h.weekdays)) throw new UserError(`geçersiz gün: ${h.weekdays} (mon..sun ya da mon-fri)`);
  if (!HHMM.test(h.opens) || !HHMM.test(h.closes)) throw new UserError(`geçersiz saat: ${h.opens}-${h.closes}`);
  if (h.closes <= h.opens) throw new UserError(`kapanış açılıştan sonra olmalı: ${h.opens}-${h.closes}`);
}

async function scheduleId(db: Db, t: Tenant, name: string): Promise<number> {
  const sc = (await db.query("SELECT id FROM schedules WHERE tenant_id = $1 AND name = $2", [t.id, name])).rows[0];
  if (!sc) throw new UserError(`${t.prefix}: zamanlama yok: ${name}`, 404);
  return sc.id;
}

export async function addScheduleHours(db: Db, t: Tenant, name: string, h: Hours, actor?: string) {
  checkHours(h);
  const id = await scheduleId(db, t, name);
  await db.query("INSERT INTO schedule_hours (schedule_id, weekdays, opens, closes) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
    id,
    h.weekdays,
    h.opens,
    h.closes,
  ]);
  await audit(db, "schedule.hours", t.id, { name, ...h }, actor);
}

// Zamanlamanın açık aralıklarını verilen listeyle değiştirir.
export async function replaceScheduleHours(db: Db, t: Tenant, name: string, hours: Hours[], actor?: string) {
  hours.forEach(checkHours);
  const id = await scheduleId(db, t, name);
  await tx(db, async () => {
    await db.query("DELETE FROM schedule_hours WHERE schedule_id = $1", [id]);
    for (const h of hours) {
      await db.query("INSERT INTO schedule_hours (schedule_id, weekdays, opens, closes) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
        id,
        h.weekdays,
        h.opens,
        h.closes,
      ]);
    }
    await audit(db, "schedule.hours_replace", t.id, { name, hours }, actor);
  });
}

export async function addScheduleHoliday(db: Db, t: Tenant, name: string, day: string, note: string | null, actor?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new UserError(`geçersiz tarih: ${day}`);
  const id = await scheduleId(db, t, name);
  await db.query(
    "INSERT INTO schedule_holidays (schedule_id, day, note) VALUES ($1, $2, $3) ON CONFLICT (schedule_id, day) DO UPDATE SET note = $3",
    [id, day, note],
  );
  await audit(db, "schedule.holiday", t.id, { name, day, note }, actor);
}

export async function setEntryFlow(db: Db, t: Tenant, address: string, flow: string, actor?: string) {
  await assertTarget(db, t, flow);
  const r = await db.query("UPDATE entry_points SET flow = $1 WHERE tenant_id = $2 AND channel = 'voice' AND address = $3", [
    flow,
    t.id,
    address,
  ]);
  if (!r.rowCount) throw new UserError(`${t.prefix}: giriş noktası yok: ${address}`, 404);
  await audit(db, "entry.flow", t.id, { address, flow }, actor);
}

// Kuyruğun "müsait temsilci yok" anonsu.
export async function setQueueUnavailableText(db: Db, t: Tenant, queue: string, text: string, actor?: string) {
  if (!text || text.length > 500) throw new UserError("anons metni 1–500 karakter olmalı");
  const r = await db.query("UPDATE queues SET unavailable_text = $1 WHERE tenant_id = $2 AND name = $3", [text, t.id, queue]);
  if (!r.rowCount) throw new UserError(`${t.prefix}: kuyruk yok: ${queue}`, 404);
  await audit(db, "queue.unavailable_text", t.id, { queue, text }, actor);
}

export type RecordingInput = { enabled: boolean; retentionDays?: number; noticeText?: string };

// Arama kaydı ayarı. Açıkken arayan önce bilgilendirme anonsunu duyar (KVKK aydınlatma).
export async function setRecording(db: Db, t: Tenant, r: RecordingInput, actor?: string) {
  if (typeof r.enabled !== "boolean") throw new UserError("enabled true/false olmalı");
  if (r.retentionDays !== undefined && (!Number.isInteger(r.retentionDays) || r.retentionDays < 1 || r.retentionDays > 3650)) {
    throw new UserError("saklama süresi 1–3650 gün olmalı");
  }
  if (r.noticeText !== undefined && (!r.noticeText || r.noticeText.length > 500)) throw new UserError("bilgilendirme anonsu 1–500 karakter olmalı");
  await db.query(
    `UPDATE tenants SET recording_enabled = $1, recording_retention_days = COALESCE($2, recording_retention_days),
       recording_notice_text = COALESCE($3, recording_notice_text) WHERE id = $4`,
    [r.enabled, r.retentionDays ?? null, r.noticeText ?? null, t.id],
  );
  await audit(db, "recording.settings", t.id, r, actor);
}

// --- Personel (panel kullanıcıları) ---
// Kiracı yöneticisi kendi kiracısına yalnızca tenant_admin ve agent açabilir. Şifre rastgele üretilir ve
// bir kez gösterilir; kullanıcı ilk girişten sonra değiştirmelidir. E-posta adresi bütün platformda tekildir.

export type StaffInput = { email: string; name: string; role: "tenant_admin" | "agent"; extension?: string | null; extensionName?: string };

export async function createStaff(db: Db, t: Tenant, s: StaffInput, actor?: string): Promise<{ password: string; sipPassword: string | null }> {
  const email = s.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("geçersiz e-posta");
  if (s.role !== "tenant_admin" && s.role !== "agent") throw new UserError("rol tenant_admin ya da agent olmalı");
  if (s.name.length > 100) throw new UserError("ad en fazla 100 karakter");
  let extensionId: number | null = null;
  let sipPassword: string | null = null;
  if (s.role === "agent") {
    if (!s.extension) throw new UserError("temsilci için dahili gerekli");
    let e = (await db.query("SELECT id FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, s.extension])).rows[0];
    // Dahili yoksa açılır (lisanstaki dahili sınırına tabidir).
    if (!e) {
      sipPassword = await addExtension(db, t, s.extension, s.extensionName ?? s.name, actor);
      e = (await db.query("SELECT id FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, s.extension])).rows[0];
    }
    const taken = (await db.query("SELECT email FROM users WHERE extension_id = $1 AND NOT disabled", [e.id])).rows[0];
    if (taken) throw new UserError(`dahili ${s.extension} zaten ${taken.email} hesabına bağlı`);
    extensionId = e.id;
  }
  const password = randomToken(14);
  await db
    .query("INSERT INTO users (email, name, password_hash, role, tenant_id, extension_id) VALUES ($1, $2, $3, $4, $5, $6)", [
      email,
      s.name,
      await hashPassword(password),
      s.role,
      t.id,
      extensionId,
    ])
    .catch((err) => {
      if (err.code === "23505") throw new UserError(`bu e-posta zaten kayıtlı: ${email}`);
      throw err;
    });
  await audit(db, "user.add", t.id, { email, role: s.role, extension: s.extension ?? null }, actor);
  return { password, sipPassword };
}

async function staffOf(db: Db, t: Tenant, email: string) {
  const u = (await db.query("SELECT * FROM users WHERE email = $1 AND tenant_id = $2", [email.toLowerCase(), t.id])).rows[0];
  if (!u) throw new UserError("kullanıcı bulunamadı", 404);
  return u;
}

export async function setStaffDisabled(db: Db, t: Tenant, email: string, disabled: boolean, actor?: string) {
  const u = await staffOf(db, t, email);
  await db.query("UPDATE users SET disabled = $1 WHERE id = $2", [disabled, u.id]);
  if (disabled) await db.query("UPDATE sessions SET revoked = true WHERE user_id = $1", [u.id]);
  await audit(db, disabled ? "user.disable" : "user.enable", t.id, { email: u.email }, actor);
}

export async function resetStaffPassword(db: Db, t: Tenant, email: string, actor?: string): Promise<string> {
  const u = await staffOf(db, t, email);
  const password = randomToken(14);
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(password), u.id]);
  await db.query("UPDATE sessions SET revoked = true WHERE user_id = $1", [u.id]);
  await audit(db, "user.password_reset", t.id, { email: u.email }, actor);
  return password;
}

// Kuyruğun temsilcilerini verilen dahili listesiyle değiştirir. Yalnızca aynı kiracının dahilileri.
export async function setQueueMembers(db: Db, t: Tenant, queue: string, numbers: string[], actor?: string) {
  const q = (await db.query("SELECT id FROM queues WHERE tenant_id = $1 AND name = $2", [t.id, queue])).rows[0];
  if (!q) throw new UserError(`${t.prefix}: kuyruk yok: ${queue}`, 404);
  const ids: number[] = [];
  for (const n of new Set(numbers)) {
    const e = (await db.query("SELECT id FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, n])).rows[0];
    if (!e) throw new UserError(`${t.prefix}: dahili yok: ${n}`);
    ids.push(e.id);
  }
  await tx(db, async () => {
    await db.query("DELETE FROM queue_members WHERE queue_id = $1", [q.id]);
    for (const id of ids) await db.query("INSERT INTO queue_members (queue_id, extension_id) VALUES ($1, $2)", [q.id, id]);
    await audit(db, "queue.members", t.id, { queue, members: [...new Set(numbers)] }, actor);
  });
}

// Kuyruğa panelden ve aktarma listesinden kullanılacak bir iç numara verir (ör. 8001).
export async function setQueueNumber(db: Db, t: Tenant, queue: string, number: string | null, actor?: string) {
  if (number !== null && !/^[0-9]{2,6}$/.test(number)) throw new UserError("iç numara 2–6 haneli olmalı");
  if (number && (await db.query("SELECT 1 FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, number])).rowCount) {
    throw new UserError(`${number} bir dahili numarası; kuyruğa verilemez`);
  }
  const r = await db
    .query("UPDATE queues SET number = $1 WHERE tenant_id = $2 AND name = $3", [number, t.id, queue])
    .catch((err) => {
      if (err.code === "23505") throw new UserError(`${number} başka bir kuyrukta kullanılıyor`);
      throw err;
    });
  if (!r.rowCount) throw new UserError(`${t.prefix}: kuyruk yok: ${queue}`, 404);
  await audit(db, "queue.number", t.id, { queue, number }, actor);
}
