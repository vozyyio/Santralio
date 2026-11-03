// Santralio: veritabanından kiracı modellerini okur, dosyaları yazar ve Asterisk'i yeniden yükler.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aad, open } from "./crypto.ts";
import { masterKey, SOUNDS_DIR, TENANTS_DIR } from "./config.ts";
import type { Db } from "./db.ts";
import { getPolicy, UserError } from "./ops.ts";
import { DEFAULT_VOICE, resolveVoice, synthesize } from "./voices.ts";
import { recordingDir, renderTenant, type RenderedFiles, type TenantModel } from "./render.ts";

export async function loadTenant(db: Db, tenantId: number): Promise<TenantModel> {
  const t = (
    await db.query(
      `SELECT t.id, t.prefix, t.name, t.status, t.recording_enabled, t.pbx_open, l.active, l.valid_until, l.max_channels
         FROM tenants t LEFT JOIN licenses l ON l.tenant_id = t.id WHERE t.id = $1`,
      [tenantId],
    )
  ).rows[0];
  if (!t) throw new Error(`kiracı yok: ${tenantId}`);

  const licensed =
    t.status === "active" && t.active === true && (t.valid_until === null || new Date(t.valid_until) > new Date());

  const tr = (await db.query("SELECT * FROM trunks WHERE tenant_id = $1", [tenantId])).rows[0];
  // outbound: dahiliye bağlı açık bir hesabın rolünde dış arama yetkisi var.
  const exts = (
    await db.query(
      `SELECT e.*, EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
                            WHERE u.extension_id = e.id AND NOT u.disabled AND 'agent.outbound' = ANY (r.permissions)) AS outbound
         FROM extensions e WHERE e.tenant_id = $1 ORDER BY e.number`,
      [tenantId],
    )
  ).rows;
  const pol = await getPolicy(db, tenantId);
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
      outbound: e.outbound,
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
    recording: { enabled: t.recording_enabled },
    outbound: pol,
    pbxOpen: t.pbx_open,
  };
}

// Anons metninden 8 kHz, tek kanallı, 16 bit WAV üretir (Asterisk'in yerel biçimi).
// Metin ya da ses değişmedikçe dosya yeniden üretilmez; ikisi yanındaki .txt dosyasında tutulur.
export function writePrompt(prefix: string, name: string, text: string, voiceId: string = DEFAULT_VOICE): boolean {
  const dir = join(SOUNDS_DIR, prefix);
  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  const wav = join(dir, `${name}.wav`);
  const txt = join(dir, `${name}.txt`);
  const voice = resolveVoice(voiceId);
  const marker = `${voice.id}\n${text}`;
  let current: string | null = null;
  try {
    current = readFileSync(txt, "utf8");
  } catch {
    current = null;
  }
  if (current === marker) return false;
  // Ses diske yazılmadan doğrudan sox'a verilir.
  const { audio, soxInput } = synthesize(voice, text);
  const tmp = `${wav}.tmp-${process.pid}.wav`;
  const conv = spawnSync("sox", [...soxInput, "-r", "8000", "-c", "1", "-b", "16", tmp, "norm", "-1"], { input: audio });
  if (conv.status !== 0) throw new Error(`anons dönüştürülemedi (${name}): ${conv.stderr.toString().trim()}`);
  renameSync(tmp, wav);
  writeFileSync(txt, marker, { mode: 0o640 });
  return true;
}

// Kiracının yüklediği ses dosyasını (mp3, wav, m4a, ogg, webm…) anons olarak kurar: 8 kHz, tek kanal, en fazla 5 dakika,
// ses düzeyi dengelenir. Bu anons artık metinden üretilmez (.txt "upload" olarak işaretlenir).
export function installUploadedPrompt(prefix: string, name: string, data: Buffer): number {
  const dir = join(SOUNDS_DIR, prefix);
  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  const work = mkdtempSync(join(tmpdir(), "santralio-upload-"));
  const input = join(work, "in");
  const out = join(dir, `${name}.wav.tmp-${process.pid}.wav`);
  try {
    writeFileSync(input, data);
    const r = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-i", input, "-t", "300", "-vn", "-af", "highpass=f=80,dynaudnorm", "-ar", "8000", "-ac", "1", "-c:a", "pcm_s16le", out],
      { maxBuffer: 16 << 20 },
    );
    if (r.status !== 0) throw new UserError("ses dosyası okunamadı (desteklenen: mp3, wav, m4a, ogg, webm, flac)");
    const seconds = (statSync(out).size - 44) / 16000;
    if (seconds < 0.3) throw new UserError("ses dosyası boş ya da çok kısa");
    renameSync(out, join(dir, `${name}.wav`));
    writeFileSync(join(dir, `${name}.txt`), `upload\n${new Date().toISOString()}`, { mode: 0o640 });
    return Math.round(seconds * 10) / 10;
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
}

// Kiracının bütün anonsları: dosya adı, panelde görünen ad ve metni. Üretim ve yükleme ekranı bu listeyi kullanır.
export async function tenantPrompts(db: Db, tenantId: number): Promise<{ name: string; label: string; text: string }[]> {
  const out: { name: string; label: string; text: string }[] = [];
  for (const m of (await db.query("SELECT name, prompt_text, invalid_text FROM menus WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows) {
    out.push({ name: `menu-${m.name}`, label: `Menü ${m.name}: karşılama`, text: m.prompt_text });
    out.push({ name: `menu-${m.name}-invalid`, label: `Menü ${m.name}: geçersiz tuş`, text: m.invalid_text });
  }
  for (const q of (await db.query("SELECT name, unavailable_text FROM queues WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows) {
    out.push({ name: `queue-${q.name}-unavailable`, label: `Kuyruk ${q.name}: müsait temsilci yok`, text: q.unavailable_text });
  }
  for (const x of (await db.query("SELECT name, closed_text FROM schedules WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows) {
    out.push({ name: `schedule-${x.name}-closed`, label: `Çalışma saati ${x.name}: mesai dışı`, text: x.closed_text });
  }
  const t = (await db.query("SELECT recording_notice_text, ext_unavailable_text, pbx_closed_text FROM tenants WHERE id = $1", [tenantId])).rows[0];
  out.push({ name: "recording-notice", label: "Kayıt bilgilendirmesi (KVKK)", text: t.recording_notice_text });
  out.push({ name: "ext-unavailable", label: "Dahiliye ulaşılamıyor", text: t.ext_unavailable_text });
  out.push({ name: "pbx-closed", label: "Santral kapalı", text: t.pbx_closed_text });
  return out;
}

async function writePrompts(db: Db, tenantId: number, prefix: string): Promise<string[]> {
  const voice = (await db.query("SELECT tts_voice FROM tenants WHERE id = $1", [tenantId])).rows[0].tts_voice;
  const uploaded = new Set((await db.query("SELECT name FROM prompt_uploads WHERE tenant_id = $1", [tenantId])).rows.map((r) => r.name));
  const changed: string[] = [];
  for (const pr of await tenantPrompts(db, tenantId)) {
    // Kiracının kendi yüklediği kayıt metinden üretilenle ezilmez.
    if (uploaded.has(pr.name)) continue;
    if (writePrompt(prefix, pr.name, pr.text, voice)) changed.push(`ses/${pr.name}`);
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
      // Kayıt dizini: kontrol servisine ait, grup asterisk (yazar), setgid.
      // Servis umask'ı (0027) grup yazmayı kaldırdığı için izin açıkça verilir.
      mkdirSync(recordingDir(model.prefix), { recursive: true });
      chmodSync(recordingDir(model.prefix), 0o2770);
      const sounds = model.licensed ? await writePrompts(db, id, model.prefix) : [];
      result.push({ prefix: model.prefix, changed: [...writeTenantFiles(model.prefix, renderTenant(model)), ...sounds] });
    }
    return result;
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [RENDER_LOCK]);
  }
}
