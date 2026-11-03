// Santralio: temsilci masasının SIP-over-WebSocket yolunu uçtan uca sınar (Cloudflare -> Caddy -> Asterisk).
// Kullanım: COOKIE="santralio_session=..." node check_ws.mjs <sip_kullanıcı> < şifre
//           COOKIE="" node check_ws.mjs x --expect-reject    (oturumsuz bağlantı reddedilmeli)
// Yalnızca REGISTER (Expires: 0 ile kayıt silinerek biter) gönderir; arama yapmaz.

import { createHash, randomBytes } from "node:crypto";

const URL_ = process.env.WS_URL ?? "wss://panel.santralio.site/ws";
const user = process.argv[2];
const expectReject = process.argv.includes("--expect-reject");
const md5 = (s) => createHash("md5").update(s).digest("hex");
const rand = () => randomBytes(6).toString("hex");

let password = "";
if (!expectReject) for await (const c of process.stdin) password += c;
password = password.trim();

const ws = new WebSocket(URL_, { protocols: ["sip"], headers: { cookie: process.env.COOKIE ?? "", origin: "https://panel.santralio.site" } });
const timer = setTimeout(() => finish(false, "zaman aşımı"), 10_000);

let done = false;
function finish(ok, msg) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(`${ok ? "geçti" : "KALDI"} : ${msg}`);
  try {
    ws.close();
  } catch {}
  process.exit(ok ? 0 : 1);
}

ws.onerror = () => (expectReject ? finish(true, "oturumsuz WebSocket bağlantısı reddedildi") : finish(false, "WebSocket bağlanamadı"));
ws.onclose = (e) => {
  if (expectReject) finish(true, `oturumsuz WebSocket bağlantısı reddedildi (${e.code})`);
};

const callId = `${rand()}@santralio-ws-test`;
const tag = rand();
const host = "sip.santralio.site";
const uri = `sip:${host}`;
let cseq = 1;
let registered = false;

function register(expires, auth) {
  const branch = `z9hG4bK${rand()}`;
  const lines = [
    `REGISTER ${uri} SIP/2.0`,
    `Via: SIP/2.0/WSS ${rand()}.invalid;branch=${branch}`,
    "Max-Forwards: 70",
    `From: <sip:${user}@${host}>;tag=${tag}`,
    `To: <sip:${user}@${host}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq++} REGISTER`,
    `Contact: <sip:${rand()}@${rand()}.invalid;transport=ws>;expires=${expires}`,
    `Expires: ${expires}`,
    "User-Agent: santralio-ws-test",
  ];
  if (auth) lines.push(auth);
  ws.send(lines.concat(["Content-Length: 0", "", ""]).join("\r\n"));
}

ws.onopen = () => {
  if (expectReject) return finish(false, "oturumsuz WebSocket bağlantısı kabul edildi");
  register(60);
};

ws.onmessage = (ev) => {
  const msg = String(ev.data);
  const code = Number(msg.split(" ", 3)[1]);
  if (code === 401) {
    const ch = /WWW-Authenticate: Digest (.*)/i.exec(msg)[1];
    const p = Object.fromEntries([...ch.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const ha1 = md5(`${user}:${p.realm}:${password}`);
    const ha2 = md5(`REGISTER:${uri}`);
    const nc = "00000001";
    const cnonce = rand();
    const response = p.qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    let auth = `Authorization: Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", algorithm=MD5, response="${response}"`;
    if (p.qop) auth += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    if (p.opaque) auth += `, opaque="${p.opaque}"`;
    if (ws._authTries = (ws._authTries ?? 0) + 1, ws._authTries > 2) return finish(false, "kimlik doğrulama reddedildi");
    return register(registered ? 0 : 60, auth);
  }
  if (code === 200 && !registered) {
    registered = true;
    console.log(`geçti : ${user} WSS üzerinden kayıt oldu (200)`);
    ws._authTries = 0;
    return register(0);
  }
  if (code === 200 && registered) return finish(true, "kayıt silindi, test temiz bitti");
  if (code >= 300) finish(false, `beklenmeyen yanıt ${code}`);
};
