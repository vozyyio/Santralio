// Santralio: veritabanından kiracı modellerini okur, dosyaları yazar ve Asterisk'i yeniden yükler.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aad, open } from "./crypto.ts";
import { masterKey, PIPER_BIN, PIPER_MODEL, SOUNDS_DIR, TENANTS_DIR } from "./config.ts";
import type { Db } from "./db.ts";
import { renderTenant, type RenderedFiles, type TenantModel } from "./render.ts";

export async function loadTenant(db: Db, tenantId: number): Promise<TenantModel> {
  const t = (
    await db.query(
      `SELECT t.id, t.prefix, t.name, t.status, l.active, l.valid_until, l.max_channels
         FROM tenants t LEFT JOIN licenses l ON l.tenant_id = t.id WHERE t.id = $1`,
      [tenantId],
    )
  ).rows[0];
  if (!t) throw new Error(`kiracı yok: ${tenantId}`);

  const licensed =
    t.status === "active" && t.active === true && (t.valid_until === null || new Date(t.valid_until) > new Date());

  const tr = (await db.query("SELECT * FROM trunks WHERE tenant_id = $1", [tenantId])).rows[0];
  const exts = (await db.query("SELECT * FROM extensions WHERE tenant_id = $1 ORDER BY number", [tenantId])).rows;
  const queues = (await db.query("SELECT * FROM queues WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows;
  const members = (
    await db.query(
      `SELECT qm.queue_id, e.number, qm.penalty FROM queue_members qm
         JOIN extensions e ON e.id = qm.extension_id
         JOIN queues q ON q.id = qm.queue_id
        WHERE q.tenant_id = $1 AND e.tenant_id = $1 ORDER BY e.number`,
      [tenantId],
    )
  ).rows;
  const menus = (await db.query("SELECT * FROM menus WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows;
  const options = (
    await db.query(
      `SELECT o.menu_id, o.digit, o.target FROM menu_options o JOIN menus m ON m.id = o.menu_id
        WHERE m.tenant_id = $1 ORDER BY o.digit`,
      [tenantId],
    )
  ).rows;
  const schedules = (await db.query("SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows;
  const hours = (
    await db.query(
      `SELECT h.schedule_id, h.weekdays, to_char(h.opens, 'HH24:MI') AS opens, to_char(h.closes, 'HH24:MI') AS closes
         FROM schedule_hours h JOIN schedules s ON s.id = h.schedule_id WHERE s.tenant_id = $1 ORDER BY h.opens`,
      [tenantId],
    )
  ).rows;
  // Geçmiş tatiller üretilmez: dialplan yalnızca bugün ve sonrasını taşır.
  const holidays = (
    await db.query(
      `SELECT h.schedule_id, to_char(h.day, 'YYYY-MM-DD') AS day
         FROM schedule_holidays h JOIN schedules s ON s.id = h.schedule_id
        WHERE s.tenant_id = $1 AND h.day >= (now() AT TIME ZONE s.timezone)::date ORDER BY h.day`,
      [tenantId],
    )
  ).rows;
  const entries = (
    await db.query("SELECT * FROM entry_points WHERE tenant_id = $1 AND channel = 'voice' ORDER BY address", [tenantId])
  ).rows;

  return {
    id: t.id,
    prefix: t.prefix,
    name: t.name,
    licensed,
    maxChannels: t.max_channels ?? 0,
    trunk: tr
      ? {
          operator: tr.operator,
          server: tr.server,
          port: tr.port,
          transport: tr.transport,
          username: tr.username,
          secret: open(tr.secret_enc, aad.trunk(tenantId), masterKey(tr.key_id)),
          contactToken: tr.contact_token,
          enabled: tr.enabled,
        }
      : null,
    extensions: exts.map((e) => ({
      number: e.number,
      displayName: e.display_name,
      secret: open(e.secret_enc, aad.extension(tenantId, e.number), masterKey(e.key_id)),
      enabled: e.enabled,
      paused: e.paused,
    })),
    queues: queues.map((q) => ({
      name: q.name,
      number: q.number,
      strategy: q.strategy,
      ringS: q.ring_s,
      maxWaitS: q.max_wait_s,
      members: members.filter((m) => m.queue_id === q.id).map((m) => ({ number: m.number, penalty: m.penalty })),
    })),
    menus: menus.map((m) => ({
      name: m.name,
      timeoutS: m.timeout_s,
      maxTries: m.max_tries,
      defaultTarget: m.default_target,
      options: options.filter((o) => o.menu_id === m.id).map((o) => ({ digit: o.digit, target: o.target })),
    })),
    schedules: schedules.map((x) => ({
      name: x.name,
      timezone: x.timezone,
      openTarget: x.open_target,
      closedTarget: x.closed_target,
      hours: hours.filter((h) => h.schedule_id === x.id).map((h) => ({ weekdays: h.weekdays, opens: h.opens, closes: h.closes })),
      holidays: holidays.filter((h) => h.schedule_id === x.id).map((h) => h.day),
    })),
    entryPoints: entries.map((e) => ({ address: e.address, flow: e.flow, enabled: e.enabled })),
  };
}

// Anons metninden 8 kHz, tek kanallı, 16 bit WAV üretir (Asterisk'in yerel biçimi).
// Metin ya da ses motoru değişmedikçe dosya yeniden üretilmez; ikisi yanındaki .txt dosyasında tutulur.
export function writePrompt(prefix: string, name: string, text: string): boolean {
  const dir = join(SOUNDS_DIR, prefix);
  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  const wav = join(dir, `${name}.wav`);
  const txt = join(dir, `${name}.txt`);
  const engine = existsSync(PIPER_BIN) && existsSync(PIPER_MODEL) ? "piper" : "espeak";
  const marker = `${engine}\n${text}`;
  let current: string | null = null;
  try {
    current = readFileSync(txt, "utf8");
  } catch {
    current = null;
  }
  if (current === marker) return false;

  // Metin argüman olarak değil standart girdiden verilir: "-" ile başlayan metin seçenek sanılmaz.
  // Ses diske yazılmadan doğrudan sox'a verilir.
  const tmp = `${wav}.tmp-${process.pid}.wav`;
  let input: string[];
  let tts;
  if (engine === "piper") {
    tts = spawnSync(PIPER_BIN, ["--model", PIPER_MODEL, "--output_raw"], { input: text, maxBuffer: 64 << 20 });
    const rate = String(JSON.parse(readFileSync(`${PIPER_MODEL}.json`, "utf8")).audio.sample_rate);
    input = ["-t", "raw", "-r", rate, "-e", "signed", "-b", "16", "-c", "1", "-"];
  } else {
    tts = spawnSync("espeak-ng", ["-v", "mb-tr2", "-s", "140", "--stdin", "--stdout"], { input: text, maxBuffer: 64 << 20 });
    input = ["-t", "wav", "-"];
  }
  if (tts.status !== 0) throw new Error(`anons üretilemedi (${name}, ${engine}): ${tts.stderr.toString().trim().split("\n").pop()}`);
  const conv = spawnSync("sox", [...input, "-r", "8000", "-c", "1", "-b", "16", tmp, "norm", "-1"], { input: tts.stdout });
  if (conv.status !== 0) throw new Error(`anons dönüştürülemedi (${name}): ${conv.stderr.toString().trim()}`);
  renameSync(tmp, wav);
  writeFileSync(txt, marker, { mode: 0o640 });
  return true;
}

async function writePrompts(db: Db, tenantId: number, prefix: string): Promise<string[]> {
  const rows = (await db.query("SELECT name, prompt_text, invalid_text FROM menus WHERE tenant_id = $1", [tenantId])).rows;
  const changed: string[] = [];
  for (const m of rows) {
    if (writePrompt(prefix, `menu-${m.name}`, m.prompt_text)) changed.push(`ses/menu-${m.name}`);
    if (writePrompt(prefix, `menu-${m.name}-invalid`, m.invalid_text)) changed.push(`ses/menu-${m.name}-invalid`);
  }
  const queues = (await db.query("SELECT name, unavailable_text FROM queues WHERE tenant_id = $1", [tenantId])).rows;
  for (const q of queues) {
    const name = `queue-${q.name}-unavailable`;
    if (writePrompt(prefix, name, q.unavailable_text)) changed.push(`ses/${name}`);
  }
  const schedules = (await db.query("SELECT name, closed_text FROM schedules WHERE tenant_id = $1", [tenantId])).rows;
  for (const x of schedules) {
    const name = `schedule-${x.name}-closed`;
    if (writePrompt(prefix, name, x.closed_text)) changed.push(`ses/${name}`);
  }
  return changed;
}

// Dosyalar önce geçici adla yazılır, sonra yerine taşınır: Asterisk yarım dosya okumaz.
export function writeTenantFiles(prefix: string, files: RenderedFiles): string[] {
  const dir = join(TENANTS_DIR, prefix);
  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  const changed: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    let current: string | null = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current === content) continue;
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o640 });
    renameSync(tmp, target);
    changed.push(join(prefix, name));
  }
  return changed;
}

// CLI ve API aynı anda üretim yapmasın diye PostgreSQL danışma kilidi alınır.
const RENDER_LOCK = 7_261_001;

export async function renderAll(db: Db): Promise<{ prefix: string; changed: string[] }[]> {
  await db.query("SELECT pg_advisory_lock($1)", [RENDER_LOCK]);
  try {
    const ids = (await db.query("SELECT id FROM tenants ORDER BY id")).rows.map((r) => r.id as number);
    const result = [];
    for (const id of ids) {
      const model = await loadTenant(db, id);
      const sounds = model.licensed ? await writePrompts(db, id, model.prefix) : [];
      result.push({ prefix: model.prefix, changed: [...writeTenantFiles(model.prefix, renderTenant(model)), ...sounds] });
    }
    return result;
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [RENDER_LOCK]);
  }
}
