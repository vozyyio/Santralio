// Santralio kontrol CLI'si. Sunucuda /usr/local/bin/santralio ile çalıştırılır.
// Komutlar için: santralio help

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Ami, reloadTenants } from "./ami.ts";
import { renderAll } from "./apply.ts";
import { CURRENT_KEY_ID, masterKey } from "./config.ts";
import { aad, open, randomToken, seal } from "./crypto.ts";
import { audit, connect, migrate, tx, type Db } from "./db.ts";

const HELP = `santralio <komut>

  migrate                                  Veritabanı şemasını günceller
  tenant create <ad>                       Yeni kiracı açar (önek otomatik: t<id>)
  tenant list                              Kiracıları listeler
  tenant suspend|resume <önek>             Kiracıyı kapatır / açar
  license set-manual <önek> --max-ext N --max-channels N [--until YYYY-MM-DD] [--note metin]
                                           Vozyy sözleşmesi öncesi elle yetki kaydı (source=manual)
  license deactivate <önek>                Lisansı kapatır
  trunk set <önek> --operator ad --server alan --username kullanıcı [--port 5060] [--transport udp|tcp]
                                           Trunk'ı kaydeder; şifre gizli girişle sorulur
                                           (ya da --password-stdin ile standart girdiden okunur)
  trunk enable|disable <önek>
  entry add <önek> voice <numara> --flow queue:|menu:|schedule:<ad>
                                           Ses giriş noktası (DID), ör. 908501234567
  entry flow <önek> <numara> queue:|menu:|schedule:<ad>
                                           Giriş noktasının hedefini değiştirir
  ext add <önek> <numara> [--name "Ad"]    Dahili açar ve SIP şifresini bir kez gösterir
  ext secret <önek> <numara>               Dahilinin SIP bilgilerini gösterir
  queue add <önek> <ad> [--number 8001] [--strategy rrmemory] [--ring 20] [--max-wait 300]
  queue member add <önek> <kuyruk> <dahili> [--penalty 0]
  menu add <önek> <ad> --text "anons" [--invalid "anons"] [--default hedef] [--timeout 5] [--tries 3]
                                           Tuşlamalı menü; anons metinden üretilir. Varsa günceller
  menu option <önek> <menü> <tuş> <hedef>  Tuşu hedefe bağlar (hedef: queue:<ad> ya da menu:<ad>)
  schedule add <önek> <ad> --open <hedef> --closed-text "anons" [--closed <hedef>] [--tz Europe/Istanbul]
                                           Çalışma saatleri; mesai dışında anons çalar. Varsa günceller
  schedule hours <önek> <zamanlama> <günler> <HH:MM-HH:MM>
                                           Açık aralık ekler, ör. mon-fri 09:00-18:00 ya da sat 10:00-14:00
  schedule holiday <önek> <zamanlama> <YYYY-AA-GG> [--note metin]
                                           Tam gün kapalı tarih (resmî tatil, bayram)
  schedule show <önek> <zamanlama>         Aralıkları ve tatilleri listeler
  operator ip add <operatör> <cidr> [--note metin]
  apply                                    Konfigürasyonu üretir ve Asterisk'i yeniden yükler
  status [<önek>]                          Trunk kaydı ve dahililerin durumu
`;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function fail(msg: string): never {
  console.error(`hata: ${msg}`);
  process.exit(1);
}

async function tenantByPrefix(db: Db, prefix: string | undefined) {
  if (!prefix) fail("kiracı öneki gerekli (ör. t1)");
  const row = (await db.query("SELECT * FROM tenants WHERE prefix = $1", [prefix])).rows[0];
  if (!row) fail(`kiracı yok: ${prefix}`);
  return row as { id: number; prefix: string; name: string; status: string };
}

function int(v: string | undefined, name: string, def?: number): number {
  if (v === undefined) {
    if (def === undefined) fail(`--${name} gerekli`);
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) fail(`--${name} tam sayı olmalı`);
  return n;
}

async function readSecret(prompt: string, fromStdin: boolean): Promise<string> {
  const stdin = process.stdin;
  if (fromStdin || !stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function apply(db: Db) {
  const results = await renderAll(db);
  for (const r of results) console.log(`${r.prefix}: ${r.changed.length ? r.changed.join(", ") : "değişiklik yok"}`);
  await reloadTenants();
  console.log("Asterisk yeniden yüklendi.");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "max-ext": { type: "string" },
      "max-channels": { type: "string" },
      until: { type: "string" },
      note: { type: "string" },
      operator: { type: "string" },
      server: { type: "string" },
      username: { type: "string" },
      port: { type: "string" },
      transport: { type: "string" },
      "password-stdin": { type: "boolean" },
      flow: { type: "string" },
      name: { type: "string" },
      number: { type: "string" },
      strategy: { type: "string" },
      ring: { type: "string" },
      "max-wait": { type: "string" },
      penalty: { type: "string" },
      text: { type: "string" },
      invalid: { type: "string" },
      default: { type: "string" },
      timeout: { type: "string" },
      tries: { type: "string" },
      open: { type: "string" },
      closed: { type: "string" },
      "closed-text": { type: "string" },
      tz: { type: "string" },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (!cmd || cmd === "help") {
    console.log(HELP);
    return;
  }

  const db = await connect();
  try {
    // Alt komutu olmayan komutlarda ikinci kelime argümandır (ör. status t1).
    const key = ["migrate", "apply", "status"].includes(cmd) ? cmd : `${cmd} ${sub ?? ""}`.trim();
    switch (key) {
      case "migrate": {
        const applied = await migrate(db, MIGRATIONS);
        console.log(applied.length ? `uygulandı: ${applied.join(", ")}` : "şema güncel");
        break;
      }

      case "tenant create": {
        const name = rest.join(" ").trim();
        if (!name) fail("kiracı adı gerekli");
        const row = await tx(db, async () => {
          const id = Number((await db.query("SELECT nextval(pg_get_serial_sequence('tenants', 'id')) AS id")).rows[0].id);
          const r = (
            await db.query("INSERT INTO tenants (id, prefix, name) VALUES ($1, $2, $3) RETURNING id, prefix", [id, `t${id}`, name])
          ).rows[0];
          await audit(db, "tenant.create", r.id, { name });
          return r;
        });
        console.log(`kiracı açıldı: ${row.prefix} (${name})`);
        break;
      }

      case "tenant list": {
        const rows = (
          await db.query(
            `SELECT t.prefix, t.name, t.status, l.source, l.active, l.valid_until, l.max_extensions, l.max_channels,
                    (SELECT count(*) FROM extensions e WHERE e.tenant_id = t.id) AS exts,
                    (SELECT count(*) FROM trunks tr WHERE tr.tenant_id = t.id) AS trunks
               FROM tenants t LEFT JOIN licenses l ON l.tenant_id = t.id ORDER BY t.id`,
          )
        ).rows;
        console.table(rows);
        break;
      }

      case "tenant suspend":
      case "tenant resume": {
        const t = await tenantByPrefix(db, rest[0]);
        const status = sub === "suspend" ? "suspended" : "active";
        await db.query("UPDATE tenants SET status = $1 WHERE id = $2", [status, t.id]);
        await audit(db, `tenant.${sub}`, t.id);
        console.log(`${t.prefix}: ${status}. Uygulamak için: santralio apply`);
        break;
      }

      case "license set-manual": {
        const t = await tenantByPrefix(db, rest[0]);
        const maxExt = int(values["max-ext"], "max-ext");
        const maxCh = int(values["max-channels"], "max-channels");
        const until = values.until ? new Date(`${values.until}T23:59:59Z`) : null;
        if (until && Number.isNaN(until.getTime())) fail("--until YYYY-MM-DD olmalı");
        await db.query(
          `INSERT INTO licenses (tenant_id, source, active, valid_until, max_extensions, max_channels, note)
           VALUES ($1, 'manual', true, $2, $3, $4, $5)
           ON CONFLICT (tenant_id) DO UPDATE SET source = 'manual', active = true, valid_until = $2,
             max_extensions = $3, max_channels = $4, note = $5, updated_at = now()`,
          [t.id, until, maxExt, maxCh, values.note ?? null],
        );
        await audit(db, "license.set_manual", t.id, { maxExt, maxCh, until, note: values.note });
        console.log(`${t.prefix}: elle yetki kaydı (source=manual) yazıldı. Uygulamak için: santralio apply`);
        break;
      }

      case "license deactivate": {
        const t = await tenantByPrefix(db, rest[0]);
        await db.query("UPDATE licenses SET active = false, updated_at = now() WHERE tenant_id = $1", [t.id]);
        await audit(db, "license.deactivate", t.id);
        console.log(`${t.prefix}: lisans kapatıldı. Uygulamak için: santralio apply`);
        break;
      }

      case "trunk set": {
        const t = await tenantByPrefix(db, rest[0]);
        const operator = values.operator ?? fail("--operator gerekli");
        const server = values.server ?? fail("--server gerekli");
        const username = values.username ?? fail("--username gerekli");
        const port = int(values.port, "port", 5060);
        const transport = values.transport ?? "udp";
        const secret = await readSecret(`${t.prefix} trunk şifresi (${operator}, ${username}): `, !!values["password-stdin"]);
        if (!secret) fail("şifre boş olamaz");
        if (/[;\r\n\[\]]/.test(secret)) fail("şifre ; [ ] ya da satır sonu içeremez (Asterisk ayar dosyası kısıtı)");
        const sealed = seal(secret, aad.trunk(t.id), masterKey(CURRENT_KEY_ID), CURRENT_KEY_ID);
        await tx(db, async () => {
          await db.query(
            `INSERT INTO trunks (tenant_id, operator, server, port, transport, username, secret_enc, key_id, contact_token)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (tenant_id) DO UPDATE SET operator = $2, server = $3, port = $4, transport = $5,
               username = $6, secret_enc = $7, key_id = $8, updated_at = now()`,
            [t.id, operator, server, port, transport, username, sealed.enc, sealed.keyId, randomToken(24)],
          );
          await audit(db, "trunk.set", t.id, { operator, server, port, transport, username });
        });
        console.log(`${t.prefix}: trunk kaydedildi (şifre şifreli). Uygulamak için: santralio apply`);
        break;
      }

      case "trunk enable":
      case "trunk disable": {
        const t = await tenantByPrefix(db, rest[0]);
        const r = await db.query("UPDATE trunks SET enabled = $1, updated_at = now() WHERE tenant_id = $2", [sub === "enable", t.id]);
        if (!r.rowCount) fail(`${t.prefix}: trunk yok`);
        await audit(db, `trunk.${sub}`, t.id);
        console.log(`${t.prefix}: trunk ${sub === "enable" ? "açıldı" : "kapatıldı"}. Uygulamak için: santralio apply`);
        break;
      }

      case "entry add": {
        const t = await tenantByPrefix(db, rest[0]);
        const [channel, address] = rest.slice(1);
        if (channel !== "voice") fail("şimdilik yalnızca voice kanalı");
        if (!address || !/^[1-9][0-9]{7,14}$/.test(address)) fail("numara ülke koduyla, yalnızca rakam olmalı (ör. 908501234567)");
        const flow = values.flow ?? fail("--flow queue:<kuyruk> ya da menu:<menü> gerekli");
        await assertTarget(db, t, flow);
        const trunk = (await db.query("SELECT id FROM trunks WHERE tenant_id = $1", [t.id])).rows[0];
        await db.query("INSERT INTO entry_points (tenant_id, channel, address, trunk_id, flow) VALUES ($1, 'voice', $2, $3, $4)", [
          t.id,
          address,
          trunk?.id ?? null,
          flow,
        ]).catch((err) => {
          if (err.code === "23505") fail(`bu numara zaten bir giriş noktası: ${address}`);
          throw err;
        });
        await audit(db, "entry.add", t.id, { channel, address, flow });
        console.log(`${t.prefix}: ${address} -> ${flow}. Uygulamak için: santralio apply`);
        break;
      }

      case "entry flow": {
        const t = await tenantByPrefix(db, rest[0]);
        const [address, flow] = rest.slice(1);
        if (!address || !flow) fail("kullanım: entry flow <önek> <numara> <hedef>");
        await assertTarget(db, t, flow);
        const r = await db.query("UPDATE entry_points SET flow = $1 WHERE tenant_id = $2 AND channel = 'voice' AND address = $3", [
          flow,
          t.id,
          address,
        ]);
        if (!r.rowCount) fail(`${t.prefix}: giriş noktası yok: ${address}`);
        await audit(db, "entry.flow", t.id, { address, flow });
        console.log(`${t.prefix}: ${address} -> ${flow}. Uygulamak için: santralio apply`);
        break;
      }

      case "menu add": {
        const t = await tenantByPrefix(db, rest[0]);
        const name = rest[1];
        if (!name || !/^[a-z0-9_]{1,32}$/.test(name)) fail("menü adı küçük harf, rakam ve _ olmalı");
        const text = values.text ?? fail('--text "anons metni" gerekli');
        if (values.default) await assertTarget(db, t, values.default);
        await db.query(
          `INSERT INTO menus (tenant_id, name, prompt_text, invalid_text, timeout_s, max_tries, default_target)
           VALUES ($1, $2, $3, COALESCE($4, 'Geçersiz bir seçim yaptınız.'), $5, $6, $7)
           ON CONFLICT (tenant_id, name) DO UPDATE SET prompt_text = $3, invalid_text = COALESCE($4, menus.invalid_text),
             timeout_s = $5, max_tries = $6, default_target = $7`,
          [t.id, name, text, values.invalid ?? null, int(values.timeout, "timeout", 5), int(values.tries, "tries", 3), values.default ?? null],
        );
        await audit(db, "menu.add", t.id, { name, text, default: values.default });
        console.log(`${t.prefix}: menü ${name} kaydedildi. Uygulamak için: santralio apply`);
        break;
      }

      case "menu option": {
        const t = await tenantByPrefix(db, rest[0]);
        const [menu, digit, target] = rest.slice(1);
        if (!menu || !digit || !target) fail("kullanım: menu option <önek> <menü> <tuş> <hedef>");
        if (!/^[0-9*#]$/.test(digit)) fail("tuş 0-9, * ya da # olmalı");
        const m = (await db.query("SELECT id FROM menus WHERE tenant_id = $1 AND name = $2", [t.id, menu])).rows[0];
        if (!m) fail(`${t.prefix}: menü yok: ${menu}`);
        await assertTarget(db, t, target);
        await db.query(
          "INSERT INTO menu_options (menu_id, digit, target) VALUES ($1, $2, $3) ON CONFLICT (menu_id, digit) DO UPDATE SET target = $3",
          [m.id, digit, target],
        );
        await audit(db, "menu.option", t.id, { menu, digit, target });
        console.log(`${t.prefix}: ${menu} menüsünde ${digit} -> ${target}. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule add": {
        const t = await tenantByPrefix(db, rest[0]);
        const name = rest[1];
        if (!name || !/^[a-z0-9_]{1,32}$/.test(name)) fail("zamanlama adı küçük harf, rakam ve _ olmalı");
        const open = values.open ?? fail("--open <hedef> gerekli (ör. menu:ana)");
        const text = values["closed-text"] ?? fail('--closed-text "anons" gerekli');
        await assertTarget(db, t, open);
        if (values.closed) await assertTarget(db, t, values.closed);
        const tz = values.tz ?? "Europe/Istanbul";
        try {
          new Intl.DateTimeFormat("tr", { timeZone: tz });
        } catch {
          fail(`geçersiz saat dilimi: ${tz}`);
        }
        await db.query(
          `INSERT INTO schedules (tenant_id, name, timezone, open_target, closed_text, closed_target)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, name) DO UPDATE SET timezone = $3, open_target = $4, closed_text = $5, closed_target = $6`,
          [t.id, name, tz, open, text, values.closed ?? null],
        );
        await audit(db, "schedule.add", t.id, { name, open, closed: values.closed, tz });
        console.log(`${t.prefix}: zamanlama ${name} kaydedildi. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule hours": {
        const t = await tenantByPrefix(db, rest[0]);
        const [name, days, range] = rest.slice(1);
        const m = /^([0-2]\d:[0-5]\d)-([0-2]\d:[0-5]\d)$/.exec(range ?? "");
        if (!name || !days || !m) fail("kullanım: schedule hours <önek> <zamanlama> mon-fri 09:00-18:00");
        if (!/^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$/.test(days)) fail("günler: mon..sun ya da aralık (mon-fri)");
        const sc = (await db.query("SELECT id FROM schedules WHERE tenant_id = $1 AND name = $2", [t.id, name])).rows[0];
        if (!sc) fail(`${t.prefix}: zamanlama yok: ${name}`);
        await db.query(
          "INSERT INTO schedule_hours (schedule_id, weekdays, opens, closes) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
          [sc.id, days, m[1], m[2]],
        ).catch((err) => {
          if (err.code === "23514" || err.code === "22007" || err.code === "22008") fail(`geçersiz aralık: ${range}`);
          throw err;
        });
        await audit(db, "schedule.hours", t.id, { name, days, range });
        console.log(`${t.prefix}: ${name} ${days} ${range} açık. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule holiday": {
        const t = await tenantByPrefix(db, rest[0]);
        const [name, day] = rest.slice(1);
        if (!name || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("kullanım: schedule holiday <önek> <zamanlama> YYYY-AA-GG");
        const sc = (await db.query("SELECT id FROM schedules WHERE tenant_id = $1 AND name = $2", [t.id, name])).rows[0];
        if (!sc) fail(`${t.prefix}: zamanlama yok: ${name}`);
        await db.query(
          "INSERT INTO schedule_holidays (schedule_id, day, note) VALUES ($1, $2, $3) ON CONFLICT (schedule_id, day) DO UPDATE SET note = $3",
          [sc.id, day, values.note ?? null],
        ).catch((err) => {
          if (err.code === "22007" || err.code === "22008") fail(`geçersiz tarih: ${day}`);
          throw err;
        });
        await audit(db, "schedule.holiday", t.id, { name, day, note: values.note });
        console.log(`${t.prefix}: ${name} ${day} kapalı${values.note ? ` (${values.note})` : ""}. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule show": {
        const t = await tenantByPrefix(db, rest[0]);
        const sc = (await db.query("SELECT * FROM schedules WHERE tenant_id = $1 AND name = $2", [t.id, rest[1]])).rows[0];
        if (!sc) fail(`${t.prefix}: zamanlama yok: ${rest[1]}`);
        console.log(`${t.prefix} ${sc.name} (${sc.timezone}): açıkken -> ${sc.open_target}, kapalıyken -> anons${sc.closed_target ? ` + ${sc.closed_target}` : ", kapat"}`);
        for (const h of (
          await db.query("SELECT weekdays, to_char(opens,'HH24:MI') o, to_char(closes,'HH24:MI') c FROM schedule_hours WHERE schedule_id = $1 ORDER BY opens", [sc.id])
        ).rows) {
          console.log(`  açık : ${h.weekdays} ${h.o}-${h.c}`);
        }
        for (const h of (
          await db.query("SELECT to_char(day,'YYYY-MM-DD') d, note FROM schedule_holidays WHERE schedule_id = $1 AND day >= current_date ORDER BY day", [sc.id])
        ).rows) {
          console.log(`  tatil: ${h.d}${h.note ? ` ${h.note}` : ""}`);
        }
        console.log(`  kapalı anonsu: ${sc.closed_text}`);
        break;
      }

      case "ext add": {
        const t = await tenantByPrefix(db, rest[0]);
        const number = rest[1];
        if (!number || !/^[0-9]{2,6}$/.test(number)) fail("dahili 2–6 haneli olmalı");
        const lic = (await db.query("SELECT max_extensions FROM licenses WHERE tenant_id = $1", [t.id])).rows[0];
        if (!lic) fail(`${t.prefix}: lisans kaydı yok`);
        const count = Number((await db.query("SELECT count(*) FROM extensions WHERE tenant_id = $1", [t.id])).rows[0].count);
        if (count >= lic.max_extensions) fail(`${t.prefix}: lisanstaki dahili sınırı dolu (${lic.max_extensions})`);
        const secret = randomToken(24);
        const sealed = seal(secret, aad.extension(t.id, number), masterKey(CURRENT_KEY_ID), CURRENT_KEY_ID);
        await db.query(
          "INSERT INTO extensions (tenant_id, number, display_name, secret_enc, key_id) VALUES ($1, $2, $3, $4, $5)",
          [t.id, number, values.name ?? "", sealed.enc, sealed.keyId],
        ).catch((err) => {
          if (err.code === "23505") fail(`${t.prefix}: dahili zaten var: ${number}`);
          throw err;
        });
        await audit(db, "ext.add", t.id, { number });
        printSip(t.prefix, number, secret);
        console.log("Uygulamak için: santralio apply");
        break;
      }

      case "ext secret": {
        const t = await tenantByPrefix(db, rest[0]);
        const e = (await db.query("SELECT * FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, rest[1]])).rows[0];
        if (!e) fail(`${t.prefix}: dahili yok: ${rest[1]}`);
        await audit(db, "ext.secret_view", t.id, { number: e.number });
        printSip(t.prefix, e.number, open(e.secret_enc, aad.extension(t.id, e.number), masterKey(e.key_id)));
        break;
      }

      case "queue add": {
        const t = await tenantByPrefix(db, rest[0]);
        const name = rest[1];
        if (!name || !/^[a-z0-9_]{1,32}$/.test(name)) fail("kuyruk adı küçük harf, rakam ve _ olmalı");
        await db.query(
          "INSERT INTO queues (tenant_id, name, number, strategy, ring_s, max_wait_s) VALUES ($1, $2, $3, $4, $5, $6)",
          [t.id, name, values.number ?? null, values.strategy ?? "rrmemory", int(values.ring, "ring", 20), int(values["max-wait"], "max-wait", 300)],
        );
        await audit(db, "queue.add", t.id, { name, number: values.number });
        console.log(`${t.prefix}: kuyruk ${t.prefix}_${name} açıldı. Uygulamak için: santralio apply`);
        break;
      }

      case "queue member": {
        if (rest[0] !== "add") fail("kullanım: queue member add <önek> <kuyruk> <dahili>");
        const t = await tenantByPrefix(db, rest[1]);
        const q = (await db.query("SELECT id FROM queues WHERE tenant_id = $1 AND name = $2", [t.id, rest[2]])).rows[0];
        if (!q) fail(`${t.prefix}: kuyruk yok: ${rest[2]}`);
        // Dahili aynı kiracıda aranır: başka kiracının dahilisi kuyruğa eklenemez.
        const e = (await db.query("SELECT id FROM extensions WHERE tenant_id = $1 AND number = $2", [t.id, rest[3]])).rows[0];
        if (!e) fail(`${t.prefix}: dahili yok: ${rest[3]}`);
        await db.query("INSERT INTO queue_members (queue_id, extension_id, penalty) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
          q.id,
          e.id,
          int(values.penalty, "penalty", 0),
        ]);
        await audit(db, "queue.member_add", t.id, { queue: rest[2], ext: rest[3] });
        console.log(`${t.prefix}: ${rest[3]} -> ${t.prefix}_${rest[2]}. Uygulamak için: santralio apply`);
        break;
      }

      case "operator ip": {
        if (rest[0] !== "add") fail("kullanım: operator ip add <operatör> <cidr>");
        await db.query("INSERT INTO operator_ip_ranges (operator, cidr, note) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
          rest[1],
          rest[2],
          values.note ?? null,
        ]);
        await audit(db, "operator.ip_add", null, { operator: rest[1], cidr: rest[2] });
        console.log(`${rest[1]}: ${rest[2]} eklendi. Güvenlik duvarına uygulamak için: sudo infra/firewall-sync.sh`);
        break;
      }

      case "apply":
        await apply(db);
        break;

      case "status": {
        const ami = await Ami.open();
        try {
          const like = sub ? `${(await tenantByPrefix(db, sub)).prefix}_` : "t";
          for (const c of ["pjsip show registrations", `pjsip show endpoints like ^${like}`]) {
            console.log((await ami.command(c)).join("\n"));
          }
        } finally {
          await ami.close();
        }
        break;
      }

      default:
        fail(`bilinmeyen komut: ${positionals.join(" ")}\n\n${HELP}`);
    }
  } finally {
    await db.end();
  }
}

// Hedef (queue:<ad> | menu:<ad>) aynı kiracıda var olmalı: başka kiracının nesnesine yönlendirilemez.
async function assertTarget(db: Db, t: { id: number; prefix: string }, target: string) {
  const m = /^(queue|menu|schedule):([a-z0-9_]{1,32})$/.exec(target);
  if (!m) fail(`geçersiz hedef: ${target} (queue:<ad>, menu:<ad> ya da schedule:<ad>)`);
  const kinds = { queue: ["queues", "kuyruk"], menu: ["menus", "menü"], schedule: ["schedules", "zamanlama"] } as const;
  const [table, label] = kinds[m[1] as keyof typeof kinds];
  const row = (await db.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND name = $2`, [t.id, m[2]])).rows[0];
  if (!row) fail(`${t.prefix}: ${label} yok: ${m[2]}`);
}

function printSip(prefix: string, number: string, secret: string) {
  console.log(`Dahili ${number} SIP bilgileri:
  sunucu      : sip.santralio.site
  port        : 5061 (TLS)
  kullanıcı   : ${prefix}_${number}
  şifre       : ${secret}
  ses şifreleme: SRTP (SDES), destekleniyorsa`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
