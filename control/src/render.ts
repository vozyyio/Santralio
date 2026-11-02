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
  extensions: { number: string; displayName: string; secret: string; enabled: boolean }[];
  queues: {
    name: string;
    number: string | null;
    strategy: string;
    ringS: number;
    maxWaitS: number;
    members: { number: string; penalty: number }[];
  }[];
  entryPoints: { address: string; flow: string; enabled: boolean }[];
};

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
`);
  }
  return out.join("");
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
 same => n,${toDid(`${p}-did`)}
 same => n,Set(DID=${v(`FILTER(0-9,${v("EXTEN")})`)})
 same => n,${toDid(`${p}-did`)}
 same => n,NoOp(Santralio ${p}: DID kiracıya ait değil: ${v("DID")})
 same => n,Goto(reject,s,1)
exten => i,1,Goto(reject,s,1)
`);

  out.push(`\n[${p}-did]\n`);
  for (const ep of t.entryPoints.filter((e) => e.enabled)) {
    const queue = ep.flow.replace(/^queue:/, "");
    if (!queues.has(queue)) continue;
    for (const d of didVariants(ep.address)) {
      assertId(d, "DID");
      out.push(`exten => ${d},1,Goto(${p}-queue-${queue},s,1)\n`);
    }
  }

  for (const q of t.queues) {
    assertId(q.name, "kuyruk");
    const welcome = `santralio/${p}/welcome`;
    out.push(`
[${p}-queue-${q.name}]
exten => s,1,Answer()
 same => n,Wait(0.5)
 same => n,Set(CHANNEL(musicclass)=${p})
 same => n,ExecIf($[${v(`STAT(e,/var/lib/asterisk/sounds/${welcome}.wav)`)}]?Playback(${welcome}))
 same => n,Queue(${p}_${q.name},t,,,${q.maxWaitS})
 same => n,NoOp(Santralio ${p}_${q.name}: ${v("QUEUESTATUS")})
 same => n,Hangup(16)
`);
  }

  // Dahililer yalnızca kendi kiracısının dahililerini ve kuyruklarını arayabilir.
  // Dış arama yok (2. adımın kapsamı dışında).
  out.push(`\n[${p}-internal]\n`);
  for (const e of t.extensions.filter((e) => e.enabled)) {
    out.push(`exten => ${e.number},1,${limit}\n same => n,Dial(PJSIP/${p}_${e.number},30)\n same => n,Hangup()\n`);
  }
  for (const q of t.queues.filter((q) => q.number)) {
    assertId(q.number!, "kuyruk numarası");
    out.push(`exten => ${q.number},1,${limit}\n same => n,Goto(${p}-queue-${q.name},s,1)\n`);
  }
  out.push(`exten => _[+*#0-9a-zA-Z].,1,Goto(reject,s,1)\nexten => i,1,Goto(reject,s,1)\n`);
  return out.join("");
}

function renderQueues(t: TenantModel, p: string): string {
  const out = [header(t, "kuyruklar")];
  const enabled = new Set(t.extensions.filter((e) => e.enabled).map((e) => e.number));
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
    for (const m of q.members.filter((m) => enabled.has(m.number))) {
      out.push(`member => PJSIP/${p}_${m.number},${m.penalty},${m.number}\n`);
    }
  }
  return out.join("");
}
