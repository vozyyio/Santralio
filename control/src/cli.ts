// Santralio kontrol CLI'si. Sunucuda /usr/local/bin/santralio ile çalıştırılır.
// Komutlar için: santralio help

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Ami, reloadTenants } from "./ami.ts";
import { renderAll } from "./apply.ts";
import { CURRENT_KEY_ID, masterKey, optionalCredential, SIP_HOST, VOZYY_API_BASE } from "./config.ts";
import { aad, open, randomToken, seal } from "./crypto.ts";
import { audit, connect, migrate, tx, type Db } from "./db.ts";
import { hashPassword } from "./auth.ts";
import * as ops from "./ops.ts";
import { dialPatterns, TEMPLATES } from "./outbound.ts";
import { recordingDir } from "./render.ts";
import * as vozyy from "./vozyy.ts";
import { assertTarget, tenantByPrefix, UserError } from "./ops.ts";

const HELP = `santralio <komut>

  migrate                                  Veritabanı şemasını günceller
  reseller add <ad>                        Bayi açar (platformun kendisi "Platform" adlı bayidir)
  reseller list
  tenant create <ad> [--reseller ad]       Yeni kiracı açar (önek otomatik: t<id>), varsayılan bayi Platform
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
  user add <e-posta> --role platform_admin|reseller_admin|tenant_user
           [--reseller ad] [--tenant önek --role-name "Patron"] [--ext dahili] [--name "Ad"]
                                           Panel/API kullanıcısı; şifre gizli girişle sorulur
                                           (ya da --password-stdin ile standart girdiden okunur)
  user password <e-posta>                  Şifreyi değiştirir ve açık oturumları kapatır
  user disable|enable <e-posta>
  user list
  outbound set <önek> --template inbound_only|agency|hotel|health_tourism
                                           Dış arama politikası (şablondan; ayrıntı panelde, platform yöneticisi)
  outbound show <önek>
  recording set <önek> --enabled yes|no [--retention gün] [--notice "anons"]
                                           Arama kaydı (varsayılan kapalı). Açıkken arayan önce anonsu duyar
  recordings purge                         Saklama süresi dolan kayıtları siler (her gece zamanlayıcıyla çalışır)
  vozyy sync                               Lisansları Vozyy'den doğrular; fark varsa Vozyy esas (her gün zamanlayıcıyla)
  vozyy install-status <lisans> <önek> <panel-alan-adı>
                                           self_hosted kurulum bitti: Vozyy'ye bildirir (kurulum anahtarı credential'dan)
  operator ip add <operatör> <cidr> [--note metin]
  apply                                    Konfigürasyonu üretir ve Asterisk'i yeniden yükler
  status [<önek>]                          Trunk kaydı ve dahililerin durumu
`;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function fail(msg: string): never {
  console.error(`hata: ${msg}`);
  process.exit(1);
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
      role: { type: "string" },
      reseller: { type: "string" },
      tenant: { type: "string" },
      ext: { type: "string" },
      "role-name": { type: "string" },
      enabled: { type: "string" },
      retention: { type: "string" },
      notice: { type: "string" },
      template: { type: "string" },
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

      case "reseller add": {
        const name = rest.join(" ").trim();
        if (!name) fail("bayi adı gerekli");
        const r = await db.query("INSERT INTO resellers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id", [name]);
        if (!r.rowCount) fail(`bayi zaten var: ${name}`);
        await audit(db, "reseller.add", null, { name });
        console.log(`bayi açıldı: ${name}`);
        break;
      }

      case "reseller list": {
        console.table(
          (
            await db.query(
              "SELECT r.name, r.status, (SELECT count(*) FROM tenants t WHERE t.reseller_id = r.id) AS tenants FROM resellers r ORDER BY r.id",
            )
          ).rows,
        );
        break;
      }

      case "tenant create": {
        const name = rest.join(" ").trim();
        if (!name) fail("kiracı adı gerekli");
        const reseller = await resellerId(db, values.reseller ?? "Platform");
        const row = await tx(db, () => ops.createTenant(db, name, reseller));
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
        await ops.setEntryFlow(db, t, address, flow);
        console.log(`${t.prefix}: ${address} -> ${flow}. Uygulamak için: santralio apply`);
        break;
      }

      case "menu add": {
        const t = await tenantByPrefix(db, rest[0]);
        const name = rest[1] ?? fail("menü adı gerekli");
        await ops.setMenu(db, t, name, {
          text: values.text ?? fail('--text "anons metni" gerekli'),
          invalidText: values.invalid ?? null,
          defaultTarget: values.default ?? null,
          timeoutS: int(values.timeout, "timeout", 5),
          maxTries: int(values.tries, "tries", 3),
        });
        console.log(`${t.prefix}: menü ${name} kaydedildi. Uygulamak için: santralio apply`);
        break;
      }

      case "menu option": {
        const t = await tenantByPrefix(db, rest[0]);
        const [menu, digit, target] = rest.slice(1);
        if (!menu || !digit || !target) fail("kullanım: menu option <önek> <menü> <tuş> <hedef>");
        await ops.setMenuOption(db, t, menu, digit, target);
        console.log(`${t.prefix}: ${menu} menüsünde ${digit} -> ${target}. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule add": {
        const t = await tenantByPrefix(db, rest[0]);
        const name = rest[1] ?? fail("zamanlama adı gerekli");
        await ops.setSchedule(db, t, name, {
          openTarget: values.open ?? fail("--open <hedef> gerekli (ör. menu:ana)"),
          closedText: values["closed-text"] ?? fail('--closed-text "anons" gerekli'),
          closedTarget: values.closed ?? null,
          timezone: values.tz,
        });
        console.log(`${t.prefix}: zamanlama ${name} kaydedildi. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule hours": {
        const t = await tenantByPrefix(db, rest[0]);
        const [name, days, range] = rest.slice(1);
        const m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(range ?? "");
        if (!name || !days || !m) fail("kullanım: schedule hours <önek> <zamanlama> mon-fri 09:00-18:00");
        await ops.addScheduleHours(db, t, name, { weekdays: days, opens: m[1], closes: m[2] });
        console.log(`${t.prefix}: ${name} ${days} ${range} açık. Uygulamak için: santralio apply`);
        break;
      }

      case "schedule holiday": {
        const t = await tenantByPrefix(db, rest[0]);
        const [name, day] = rest.slice(1);
        if (!name || !day) fail("kullanım: schedule holiday <önek> <zamanlama> YYYY-AA-GG");
        await ops.addScheduleHoliday(db, t, name, day, values.note ?? null);
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
        const number = rest[1] ?? fail("dahili numarası gerekli");
        printSip(t.prefix, number, await ops.addExtension(db, t, number, values.name ?? ""));
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

      case "user add": {
        const email = (rest[0] ?? fail("e-posta gerekli")).trim().toLowerCase();
        const role = values.role ?? fail("--role gerekli");
        if (!["platform_admin", "reseller_admin", "tenant_user"].includes(role)) fail(`geçersiz rol: ${role} (platform_admin, reseller_admin, tenant_user)`);
        let reseller: number | null = null;
        let tenant: number | null = null;
        let roleId: number | null = null;
        let ext: number | null = null;
        if (role === "reseller_admin") reseller = await resellerId(db, values.reseller ?? fail("--reseller gerekli"));
        if (role === "tenant_user") {
          tenant = (await tenantByPrefix(db, values.tenant ?? fail("--tenant gerekli"))).id;
          const roleName = values["role-name"] ?? fail("--role-name gerekli (ör. Patron)");
          const r = (await db.query("SELECT id FROM roles WHERE tenant_id = $1 AND name = $2", [tenant, roleName])).rows[0];
          if (!r) fail(`rol yok: ${roleName}`);
          roleId = r.id;
          if (values.ext) {
            const e = (await db.query("SELECT id FROM extensions WHERE tenant_id = $1 AND number = $2", [tenant, values.ext])).rows[0];
            if (!e) fail(`dahili yok: ${values.ext}`);
            ext = e.id;
          }
        }
        const password = await readSecret(`${email} için şifre (en az 10 karakter): `, !!values["password-stdin"]);
        const hash = await hashPassword(password).catch((err) => fail(err.message));
        await db
          .query(
            "INSERT INTO users (email, name, password_hash, role, reseller_id, tenant_id, role_id, extension_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [email, values.name ?? "", hash, role, reseller, tenant, roleId, ext],
          )
          .catch((err) => {
            if (err.code === "23505") fail(`kullanıcı zaten var: ${email}`);
            if (err.code === "23514") fail("geçersiz e-posta ya da rol/kapsam");
            throw err;
          });
        await audit(db, "user.add", tenant, { email, role });
        console.log(`kullanıcı açıldı: ${email} (${role})`);
        break;
      }

      case "user password": {
        const email = (rest[0] ?? fail("e-posta gerekli")).trim().toLowerCase();
        const u = (await db.query("SELECT id, tenant_id FROM users WHERE email = $1", [email])).rows[0];
        if (!u) fail(`kullanıcı yok: ${email}`);
        const hash = await hashPassword(await readSecret(`${email} için yeni şifre: `, !!values["password-stdin"])).catch((err) => fail(err.message));
        await tx(db, async () => {
          await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, u.id]);
          await db.query("UPDATE sessions SET revoked = true WHERE user_id = $1", [u.id]);
          await audit(db, "user.password", u.tenant_id, { email });
        });
        console.log(`${email}: şifre değişti, açık oturumlar kapatıldı`);
        break;
      }

      case "user disable":
      case "user enable": {
        const email = (rest[0] ?? fail("e-posta gerekli")).trim().toLowerCase();
        const r = await db.query("UPDATE users SET disabled = $1 WHERE email = $2 RETURNING tenant_id", [sub === "disable", email]);
        if (!r.rowCount) fail(`kullanıcı yok: ${email}`);
        await audit(db, `user.${sub}`, r.rows[0].tenant_id, { email });
        console.log(`${email}: ${sub === "disable" ? "kapatıldı" : "açıldı"}`);
        break;
      }

      case "user list": {
        console.table(
          (
            await db.query(
              `SELECT u.email, u.role, ro.name AS "rol", r.name AS reseller, t.prefix AS tenant, e.number AS ext, u.disabled,
                      (SELECT max(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
                 FROM users u LEFT JOIN resellers r ON r.id = u.reseller_id LEFT JOIN tenants t ON t.id = u.tenant_id
                 LEFT JOIN extensions e ON e.id = u.extension_id LEFT JOIN roles ro ON ro.id = u.role_id ORDER BY u.id`,
            )
          ).rows,
        );
        break;
      }

      case "outbound set": {
        const t = await tenantByPrefix(db, rest[0]);
        const tpl = values.template ?? fail("--template gerekli");
        const x = TEMPLATES[tpl] ?? fail(`şablon yok: ${tpl} (${Object.keys(TEMPLATES).join(", ")})`);
        await ops.setPolicy(db, t, { template: tpl, ...x.policy });
        console.log(`${t.prefix}: dış arama politikası "${x.label}". Uygulamak için: santralio apply`);
        break;
      }

      case "outbound show": {
        const t = await tenantByPrefix(db, rest[0]);
        const p = await ops.getPolicy(db, t.id);
        console.log(`${t.prefix}: ${TEMPLATES[p.template]?.label ?? p.template} · ${p.enabled ? "açık" : "kapalı"}`);
        console.log(`  açık numaralar: ${dialPatterns(p).map((d) => d.label).join(", ") || "yok"}`);
        console.log(`  eş zamanlı ${p.maxConcurrent} · günlük ${p.dailyLimit} · en uzun ${p.maxMinutes} dk`);
        break;
      }

      case "recording set": {
        const t = await tenantByPrefix(db, rest[0]);
        const e = values.enabled ?? fail("--enabled yes|no gerekli");
        if (e !== "yes" && e !== "no") fail("--enabled yes ya da no olmalı");
        await ops.setRecording(db, t, {
          enabled: e === "yes",
          retentionDays: values.retention === undefined ? undefined : int(values.retention, "retention"),
          noticeText: values.notice,
        });
        console.log(`${t.prefix}: kayıt ${e === "yes" ? "açık" : "kapalı"}. Uygulamak için: santralio apply`);
        break;
      }

      case "recordings purge": {
        // Her kiracının kendi dizininde, kendi saklama süresinden eski .wav dosyaları silinir.
        const rows = (await db.query("SELECT id, prefix, recording_retention_days AS days FROM tenants ORDER BY id")).rows;
        for (const t of rows) {
          const dir = recordingDir(t.prefix);
          let files: string[] = [];
          try {
            files = readdirSync(dir).filter((f) => /^\d+\.\d+\.wav$/.test(f));
          } catch {
            continue;
          }
          const cutoff = Date.now() - t.days * 86_400_000;
          let removed = 0;
          for (const f of files) {
            const path = join(dir, f);
            if (statSync(path).mtimeMs < cutoff) {
              unlinkSync(path);
              removed++;
            }
          }
          if (removed) await audit(db, "recordings.purge", t.id, { removed, retentionDays: t.days });
          console.log(`${t.prefix}: ${removed} kayıt silindi (saklama ${t.days} gün, kalan ${files.length - removed})`);
        }
        break;
      }

      case "vozyy sync": {
        const key = optionalCredential(vozyy.SECRET_INBOUND);
        if (!key) throw new UserError("Vozyy servis anahtarı yok: sudo infra/set-secret.sh vozyy-inbound");
        const r = await vozyy.syncLicenses(db, VOZYY_API_BASE, key);
        console.log(`doğrulandı: ${r.checked}, değişen: ${r.changed.join(", ") || "yok"}`);
        for (const e of r.errors) console.error(`hata: ${e}`);
        if (r.tenants.size) await apply(db);
        if (r.errors.length) process.exitCode = 1;
        break;
      }

      case "vozyy install-status": {
        const [licenseId, tenantPrefix, panelDomain] = rest;
        if (!licenseId || !tenantPrefix || !panelDomain) throw new UserError("kullanım: vozyy install-status <lisans> <önek> <panel-alan-adı>");
        // Kendi sunucusundaki kurulumda o lisansın kurulum anahtarı; yoksa servis anahtarı.
        const token = optionalCredential("santralio-vozyy-install-token") ?? optionalCredential(vozyy.SECRET_INBOUND);
        if (!token) throw new UserError("Vozyy kurulum anahtarı yok");
        const sent = await vozyy.reportInstallStatus(VOZYY_API_BASE, token, { licenseId, tenantPrefix, panelDomain });
        await db.query("UPDATE vozyy_licenses SET install_status = 'provisioned', panel_domain = $2, updated_at = now() WHERE license_id = $1", [
          licenseId,
          sent.panel_domain,
        ]);
        await audit(db, "vozyy.install_status", null, sent);
        console.log(`Vozyy'ye bildirildi: ${sent.panel_url} (${tenantPrefix})`);
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

async function resellerId(db: Db, name: string): Promise<number> {
  const r = (await db.query("SELECT id FROM resellers WHERE name = $1", [name])).rows[0];
  if (!r) fail(`bayi yok: ${name}`);
  return r.id;
}

function printSip(prefix: string, number: string, secret: string) {
  console.log(`Dahili ${number} SIP bilgileri:
  sunucu      : ${SIP_HOST}
  port        : 5061 (TLS)
  kullanıcı   : ${prefix}_${number}
  şifre       : ${secret}
  ses şifreleme: SRTP (SDES), destekleniyorsa`);
}

main().catch((err) => fail(err instanceof UserError || err instanceof Error ? err.message : String(err)));
