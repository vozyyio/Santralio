// Santralio: kiracı kaydından Asterisk konfigürasyonu üretir.
// Saf fonksiyonlar: veritabanına, diske ya da Asterisk'e dokunmaz.
// Her nesnenin adı kiracı önekiyle başlar (bkz. docs/architecture.md, "Kiracı izolasyonu").

export type TenantModel = {
  id: number;
  prefix: string;
  name: string;
  licensed: boolean;
  maxChannels: number;
  trunk: null | {
    operator: string;
    server: string;
    port: number;
    transport: "udp" | "tcp";
    username: string;
    secret: string;
    contactToken: string;
    enabled: boolean;
  };
  extensions: { number: string; displayName: string; secret: string; enabled: boolean; paused: boolean }[];
  queues: {
    name: string;
    number: string | null;
    strategy: string;
    ringS: number;
    maxWaitS: number;
    members: { number: string; penalty: number }[];
  }[];
  menus: {
    name: string;
    timeoutS: number;
    maxTries: number;
    defaultTarget: string | null;
    options: { digit: string; target: string }[];
  }[];
  schedules: {
    name: string;
    timezone: string;
    openTarget: string;
    closedTarget: string | null;
    hours: { weekdays: string; opens: string; closes: string }[]; // "HH:MM"
    holidays: string[]; // "YYYY-MM-DD"
  }[];
  entryPoints: { address: string; flow: string; enabled: boolean }[];
  recording: { enabled: boolean };
};

// Arama kayıtları: Asterisk yazar (MixMonitor), kontrol servisi saklama süresi dolanı siler.
export const recordingDir = (prefix: string) => `/var/lib/santralio/recordings/${prefix}`;

// Kiracının anons dosyaları: /var/lib/asterisk/sounds/santralio/<önek>/<ad>.wav
// Asterisk göreli yolları paketin dizininde (/usr/share/asterisk/sounds) aradığı için mutlak yol, uzantısız.
export const promptPath = (prefix: string, name: string) => `/var/lib/asterisk/sounds/santralio/${prefix}/${name}`;

export type RenderedFiles = Record<"pjsip.conf" | "extensions.conf" | "queues.conf" | "musiconhold.conf", string>;

const header = (t: TenantModel, what: string) =>
  `; Santralio: ${t.prefix} (${oneLine(t.name)}) ${what}.\n; Kontrol servisi üretir. Elle değiştirmeyin, bir sonraki üretimde ezilir.\n`;

// Yorum satırına giren serbest metin satır sonu içeremez.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

const ID = /^[a-z0-9_]+$/;
function assertId(s: string, what: string) {
  if (!ID.test(s)) throw new Error(`geçersiz ${what}: ${s}`);
}

// Asterisk ayar değerinde ; yorum başlatır, satır sonu yeni ayar başlatır.
function assertValue(s: string, what: string) {
  if (/[;\r\n\[\]]/.test(s)) throw new Error(`${what} izin verilmeyen karakter içeriyor`);
}

// Ülke koduyla yazılmış DID için operatörlerin gönderebileceği biçimler.
// 908501234567 -> 908501234567, 08501234567, 8501234567
export function didVariants(address: string): string[] {
  const out = new Set([address]);
  if (address.startsWith("90") && address.length === 12) {
    out.add("0" + address.slice(2));
    out.add(address.slice(2));
  }
  return [...out];
}

function disabled(t: TenantModel, why: string): RenderedFiles {
  const note = (what: string) => `${header(t, what)}; Kapalı: ${why}\n`;
  return {
    "pjsip.conf": note("PJSIP nesneleri"),
    "extensions.conf": note("dialplan"),
    "queues.conf": note("kuyruklar"),
    "musiconhold.conf": note("bekleme müziği"),
  };
}

export function renderTenant(t: TenantModel): RenderedFiles {
  if (!/^t[0-9]{1,6}$/.test(t.prefix)) throw new Error(`geçersiz önek: ${t.prefix}`);
  if (!t.licensed) return disabled(t, "lisans aktif değil");

  const p = t.prefix;
  return {
    "pjsip.conf": renderPjsip(t, p),
    "extensions.conf": renderDialplan(t, p),
    "queues.conf": renderQueues(t, p),
    "musiconhold.conf": `${header(t, "bekleme müziği")}\n[${p}]\nmode=files\ndirectory=moh\n`,
  };
}

function renderPjsip(t: TenantModel, p: string): string {
  const out = [header(t, "PJSIP nesneleri")];

  const tr = t.trunk;
  if (tr && tr.enabled) {
    for (const [v, w] of [[tr.server, "sunucu"], [tr.username, "kullanıcı adı"], [tr.secret, "trunk şifresi"]] as const) {
      assertValue(v, w);
    }
    assertId(tr.contactToken, "contact token");
    const transport = `transport-${tr.transport}`;
    const server = `sip:${tr.server}:${tr.port}`;
    out.push(`
; --- Trunk (${tr.operator}) ---
[${p}_trunk]
type=endpoint
transport=${transport}
context=${p}-inbound
disallow=all
allow=alaw,ulaw
aors=${p}_trunk
outbound_auth=${p}_trunk_auth
from_user=${tr.username}
from_domain=${tr.server}
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
set_var=TENANT=${p}

[${p}_trunk]
type=aor
contact=${server}
qualify_frequency=60

[${p}_trunk_auth]
type=auth
auth_type=userpass
username=${tr.username}
password=${tr.secret}

[${p}_trunk_reg]
type=registration
transport=${transport}
outbound_auth=${p}_trunk_auth
server_uri=${server}
client_uri=sip:${tr.username}@${tr.server}
contact_user=${tr.contactToken}
line=yes
endpoint=${p}_trunk
expiration=300
retry_interval=60
forbidden_retry_interval=600
max_retries=10000

[${p}_trunk_identify]
type=identify
endpoint=${p}_trunk
; Asterisk tüm Request-URI ile karşılaştırır; yalnızca kullanıcı kısmı için regex kullanılır.
match_request_uri=/^sips?:${tr.contactToken}@/
`);
  }

  for (const e of t.extensions.filter((e) => e.enabled)) {
    assertId(e.number, "dahili");
    assertValue(e.secret, "dahili şifresi");
    assertValue(e.displayName, "görünen ad");
    const name = `${p}_${e.number}`;
    const cid = e.displayName ? `"${e.displayName.replace(/"/g, "")}" <${e.number}>` : `<${e.number}>`;
    out.push(`
; --- Dahili ${e.number} ---
[${name}]
type=endpoint
context=${p}-internal
disallow=all
allow=alaw,ulaw
aors=${name}
auth=${name}
callerid=${cid}
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
media_encryption=sdes
media_encryption_optimistic=yes
device_state_busy_at=1
set_var=TENANT=${p}

[${name}]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=30

[${name}]
type=auth
auth_type=userpass
username=${name}
password=${e.secret}

; Tarayıcıdaki temsilci masası (WebRTC: DTLS-SRTP, ICE). Aynı şifre, ayrı kullanıcı adı.
; Ses G.711 kalır: operatör hattıyla arasında dönüştürme yapılmaz.
[${name}_web]
type=endpoint
context=${p}-internal
disallow=all
allow=alaw,ulaw
webrtc=yes
aors=${name}_web
auth=${name}_web
callerid=${cid}
device_state_busy_at=1
set_var=TENANT=${p}

[${name}_web]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=30

[${name}_web]
type=auth
auth_type=userpass
username=${name}_web
password=${e.secret}
`);
  }
  return out.join("");
}

// Bir dahilinin iki cihazı: masaüstü/mobil softphone ve tarayıcı. Arama ikisinde birden çalar.
const devices = (p: string, number: string) => `PJSIP/${p}_${number}&PJSIP/${p}_${number}_web`;

// Kayıt açıksa: kuyruğa girmeden önce bilgilendirme anonsu; kayıt temsilci açınca başlar
// (Queue gosub -> santralio-record,s,1). Böylece bekleme müziği kayda girmez.
function recordingSteps(t: TenantModel, p: string): string {
  if (!t.recording.enabled) return "";
  return ` same => n,Playback(${promptPath(p, "recording-notice")})
 same => n,Set(__SANTRALIO_RECDIR=${recordingDir(p)})
`;
}

// Arayanın temsilciye bağlanamadığı Queue() sonuçları: müsait temsilci yok, kuyruk dolu ya da süre doldu.
const QUEUE_FAILED = "^(TIMEOUT|FULL|JOINEMPTY|LEAVEEMPTY|JOINUNAVAIL|LEAVEUNAVAIL)$";

// GotoIfTime aralığı uçları dahil sayar: 09:00-18:00, 18:00:59'a kadar açık demektir.
// Kapanış dakikası bu yüzden bir dakika geri alınır: 09:00-17:59.
export function timeRange(opens: string, closes: string): string {
  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const a = hm.exec(opens);
  const b = hm.exec(closes);
  if (!a || !b) throw new Error(`geçersiz saat: ${opens}-${closes}`);
  const end = Number(b[1]) * 60 + Number(b[2]) - 1;
  if (end < Number(a[1]) * 60 + Number(a[2])) throw new Error(`kapanış açılıştan sonra olmalı: ${opens}-${closes}`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${opens}-${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

function weekdays(w: string): string {
  if (!/^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$/.test(w)) throw new Error(`geçersiz gün: ${w}`);
  return w;
}

// Asterisk değişkeni ya da fonksiyonu: v("EXTEN") -> ${EXTEN}
const v = (s: string) => "${" + s + "}";

function renderDialplan(t: TenantModel, p: string): string {
  const out = [header(t, "dialplan")];
  const queues = new Set(t.queues.map((q) => q.name));
  const limit = `Gosub(santralio-lib,limit,1(${t.maxChannels}))`;
  const toDid = (ctx: string) => `GotoIf($[${v(`DIALPLAN_EXISTS(${ctx},${v("DID")},1)`)}]?${ctx},${v("DID")},1)`;

  // Gelen arama: trunk'tan gelir. DID önce To başlığından, sonra Request-URI'den okunur.
  // <sip:908501234567@host> -> 908501234567
  out.push(`
[${p}-inbound]
exten => _[+0-9a-zA-Z].,1,NoOp(Santralio ${p} gelen: ${v("CALLERID(num)")} -> ${v("EXTEN")})
 same => n,${limit}
 same => n,Set(TO=${v("PJSIP_HEADER(read,To)")})
 same => n,Set(TO=${v("CUT(TO,@,1)")})
 same => n,Set(TO=${v("CUT(TO,:,2)")})
 same => n,Set(DID=${v(`FILTER(0-9,${v("TO")})`)})
 same => n,Set(__SANTRALIO_DID=${v("DID")})
 same => n,${toDid(`${p}-did`)}
 same => n,Set(DID=${v(`FILTER(0-9,${v("EXTEN")})`)})
 same => n,Set(__SANTRALIO_DID=${v("DID")})
 same => n,${toDid(`${p}-did`)}
 same => n,NoOp(Santralio ${p}: DID kiracıya ait değil: ${v("DID")})
 same => n,Goto(reject,s,1)
exten => i,1,Goto(reject,s,1)
`);

  // Hedefler (queue:<ad>, menu:<ad>) yalnızca bu kiracının nesnelerine çözülür.
  const menus = new Set(t.menus.map((m) => m.name));
  const schedules = new Set(t.schedules.map((x) => x.name));
  const extensions = new Set(t.extensions.filter((e) => e.enabled).map((e) => e.number));
  const target = (flow: string): string | null => {
    const ext = /^ext:([0-9]{2,6})$/.exec(flow);
    if (ext) return extensions.has(ext[1]) ? `${p}-ext,${ext[1]},1` : null;
    const m = /^(queue|menu|schedule):([a-z0-9_]{1,32})$/.exec(flow);
    if (!m) return null;
    const [, kind, name] = m;
    if (kind === "queue" && queues.has(name)) return `${p}-queue-${name},s,1`;
    if (kind === "menu" && menus.has(name)) return `${p}-menu-${name},s,1`;
    if (kind === "schedule" && schedules.has(name)) return `${p}-schedule-${name},s,1`;
    return null;
  };

  out.push(`\n[${p}-did]\n`);
  for (const ep of t.entryPoints.filter((e) => e.enabled)) {
    const dest = target(ep.flow);
    if (!dest) continue;
    for (const d of didVariants(ep.address)) {
      assertId(d, "DID");
      out.push(`exten => ${d},1,Goto(${dest})\n`);
    }
  }

  // Çalışma saatleri: önce tatil günleri, sonra açık aralıklar kontrol edilir.
  // Hiçbiri tutmazsa kapalı anonsu çalar, kapalı hedefine gider ya da kapatır.
  for (const sc of t.schedules) {
    assertId(sc.name, "zamanlama");
    if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(sc.timezone)) throw new Error(`geçersiz saat dilimi: ${sc.timezone}`);
    const open = target(sc.openTarget);
    const closed = sc.closedTarget ? target(sc.closedTarget) : null;
    out.push(`
[${p}-schedule-${sc.name}]
exten => s,1,Set(TODAY=${v(`STRFTIME(${v("EPOCH")},${sc.timezone},%F)`)})
`);
    for (const day of sc.holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`geçersiz tarih: ${day}`);
      out.push(` same => n,GotoIf($["${v("TODAY")}" = "${day}"]?closed)\n`);
    }
    if (open) {
      for (const h of sc.hours) {
        out.push(` same => n,GotoIfTime(${timeRange(h.opens, h.closes)},${weekdays(h.weekdays)},*,*,${sc.timezone}?${open})\n`);
      }
    }
    out.push(` same => n(closed),Answer()
 same => n,QueueLog(${p}__schedule_${sc.name},${v("UNIQUEID")},NONE,SANTRALIO_CLOSED,${v("SANTRALIO_DID")}|${v("CALLERID(num)")})
 same => n,Wait(0.5)
 same => n,Playback(${promptPath(p, `schedule-${sc.name}-closed`)})
 same => n,${closed ? `Goto(${closed})` : "Hangup(16)"}
`);
  }

  // Tuşlamalı menü: anons çalar, tuşa göre hedefe gider.
  // Tuşlama yoksa ya da geçersizse anons max_tries kez tekrarlanır, sonra varsayılan hedefe gidilir.
  for (const m of t.menus) {
    assertId(m.name, "menü");
    const fallback = m.defaultTarget ? target(m.defaultTarget) : null;
    const end = fallback ? `Goto(${fallback})` : "Hangup(16)";
    const retry = `GotoIf($[${v("TRIES")} < ${m.maxTries}]?s,prompt)`;
    out.push(`
[${p}-menu-${m.name}]
exten => s,1,Answer()
 same => n,Wait(0.5)
 same => n,Set(TRIES=0)
 same => n(prompt),Set(TRIES=$[${v("TRIES")} + 1])
 same => n,Background(${promptPath(p, `menu-${m.name}`)})
 same => n,WaitExten(${m.timeoutS})
`);
    for (const o of m.options) {
      if (!/^[0-9*#]$/.test(o.digit)) throw new Error(`geçersiz tuş: ${o.digit}`);
      const dest = target(o.target);
      if (dest) out.push(`exten => ${o.digit},1,Goto(${dest})\n`);
    }
    out.push(`exten => t,1,${retry}
 same => n,${end}
exten => i,1,Playback(${promptPath(p, `menu-${m.name}-invalid`)})
 same => n,${retry}
 same => n,${end}
`);
  }

  for (const q of t.queues) {
    assertId(q.name, "kuyruk");
    const welcome = promptPath(p, "welcome");
    out.push(`
[${p}-queue-${q.name}]
exten => s,1,Answer()
 same => n,Wait(0.5)
 same => n,Set(CHANNEL(musicclass)=${p})
 same => n,ExecIf($[${v(`STAT(e,${welcome}.wav)`)}]?Playback(${welcome}))
 same => n,Set(__SANTRALIO_QUEUE=${q.name})
 same => n,Set(__SANTRALIO_QLOG=${p}_${q.name})
 same => n,Set(__SANTRALIO_CALLID=${v("UNIQUEID")})
 same => n,QueueLog(${p}_${q.name},${v("UNIQUEID")},NONE,SANTRALIO_ENTER,${v("SANTRALIO_DID")}|${v("CALLERID(num)")})
${recordingSteps(t, p)} same => n,Queue(${p}_${q.name},t,,,${q.maxWaitS},,${t.recording.enabled ? "santralio-record" : ""})
 same => n,NoOp(Santralio ${p}_${q.name}: ${v("QUEUESTATUS")})
 same => n,GotoIf($[${v(`REGEX("${QUEUE_FAILED}" ${v("QUEUESTATUS")})`)}]?failed)
 same => n,Hangup(16)
 same => n(failed),QueueLog(${p}_${q.name},${v("UNIQUEID")},NONE,SANTRALIO_NOAGENT,${v("QUEUESTATUS")})
 same => n,Playback(${promptPath(p, `queue-${q.name}-unavailable`)})
 same => n,Hangup(16)
`);
  }

  // Menüden ya da numaradan doğrudan bir dahiliyi çaldırmak (ext:<numara>). Raporlara "ext-<numara>"
  // adlı sanal kuyruk olarak girer: giriş olayı, sonuç olayı (kapanışta, hangup handler ile).
  out.push(`\n[${p}-ext]\n`);
  for (const e of t.extensions.filter((e) => e.enabled)) {
    const qlog = `${p}_ext-${e.number}`;
    out.push(`exten => ${e.number},1,Answer()
 same => n,Set(__SANTRALIO_QUEUE=ext-${e.number})
 same => n,Set(__SANTRALIO_QLOG=${qlog})
 same => n,Set(__SANTRALIO_CALLID=${v("UNIQUEID")})
 same => n,QueueLog(${qlog},${v("UNIQUEID")},NONE,SANTRALIO_ENTER,${v("SANTRALIO_DID")}|${v("CALLERID(num)")})
${recordingSteps(t, p)} same => n,Set(CHANNEL(hangup_handler_push)=santralio-lib,ext-done,1(${qlog},${e.number}))
 same => n,Gosub(santralio-lib,devices,1(${p}_${e.number}))
 same => n,ExecIf($["${v("GOSUB_RETVAL")}" = ""]?Set(DIALSTATUS=CHANUNAVAIL))
 same => n,ExecIf($["${v("GOSUB_RETVAL")}" != ""]?Dial(${v("GOSUB_RETVAL")},30,${t.recording.enabled ? "U(santralio-record)" : ""}b(santralio-lib^agent-headers^1)))
 same => n,GotoIf($["${v("DIALSTATUS")}" = "ANSWER"]?done)
 same => n,Playback(${promptPath(p, "ext-unavailable")})
 same => n(done),Hangup(16)
`);
  }

  // Dahililer yalnızca kendi kiracısının dahililerini ve kuyruklarını arayabilir.
  // Dış arama yok (2. adımın kapsamı dışında).
  out.push(`\n[${p}-internal]\n`);
  for (const e of t.extensions.filter((e) => e.enabled)) {
    out.push(`exten => ${e.number},1,${limit}
 same => n,Gosub(santralio-lib,devices,1(${p}_${e.number}))
 same => n,GotoIf($["${v("GOSUB_RETVAL")}" = ""]?unavail)
 same => n,Dial(${v("GOSUB_RETVAL")},30)
 same => n(unavail),Hangup()
`);
  }
  for (const q of t.queues.filter((q) => q.number)) {
    assertId(q.number!, "kuyruk numarası");
    out.push(`exten => ${q.number},1,${limit}\n same => n,Goto(${p}-queue-${q.name},s,1)\n`);
  }
  // Aktarma hedefi: temsilci aramayı q-<kuyruk> adresine aktarır (iç numarası olmayan kuyruklar dahil).
  for (const q of t.queues) {
    out.push(`exten => q-${q.name.replace(/_/g, "-")},1,Goto(${p}-queue-${q.name},s,1)\n`);
  }
  out.push(`exten => _[+*#0-9a-zA-Z].,1,Goto(reject,s,1)\nexten => i,1,Goto(reject,s,1)\n`);

  // Kuyruğun temsilciyi çaldırdığı yer. Yalnızca queues.conf'taki Local üyeleri buraya girer.
  // Ön arama işleyicisi (b) temsilcinin ekranı için kuyruk adını ve aranan numarayı SIP başlığına ekler.
  out.push(`\n[${p}-agent]\n`);
  for (const e of t.extensions.filter((e) => e.enabled)) {
    out.push(`exten => ${e.number},1,Gosub(santralio-lib,devices,1(${p}_${e.number}))
 same => n,GotoIf($["${v("GOSUB_RETVAL")}" = ""]?unavail)
 same => n,Dial(${v("GOSUB_RETVAL")},,b(santralio-lib^agent-headers^1))
 same => n(unavail),Hangup()
`);
  }
  out.push(`exten => _[+*#0-9a-zA-Z].,1,Hangup(21)\n`);

  out.push(`\n[${p}-hints]\n`);
  for (const e of t.extensions.filter((e) => e.enabled)) {
    out.push(`exten => ${e.number},hint,${devices(p, e.number)}\n`);
  }
  return out.join("");
}

function renderQueues(t: TenantModel, p: string): string {
  const out = [header(t, "kuyruklar")];
  const enabled = new Set(t.extensions.filter((e) => e.enabled).map((e) => e.number));
  const pausedSet = new Set(t.extensions.filter((e) => e.paused).map((e) => e.number));
  for (const q of t.queues) {
    out.push(`
[${p}_${q.name}]
strategy=${q.strategy}
timeout=${q.ringS}
retry=2
wrapuptime=5
ringinuse=no
musicclass=${p}
joinempty=unavailable,invalid
leavewhenempty=unavailable,invalid
announce-frequency=0
periodic-announce-frequency=0
`);
    // Üye bir Local kanalıdır: dahilinin iki cihazını birlikte çaldırır ({p}-agent).
    // Meşgul/müsait durumu iki cihazı birlikte izleyen hint'ten okunur ({p}-hints).
    // Son alan mola durumudur: kuyruk yeniden yüklense de veritabanındaki durum korunur.
    for (const m of q.members.filter((m) => enabled.has(m.number))) {
      const paused = pausedSet.has(m.number) ? 1 : 0;
      out.push(`member => Local/${m.number}@${p}-agent/n,${m.penalty},${m.number},hint:${m.number}@${p}-hints,no,,${paused}\n`);
    }
  }
  return out.join("");
}
