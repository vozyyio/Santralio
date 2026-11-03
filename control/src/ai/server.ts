// Santralio yapay zekâ karşılama servisi (santralio-ai). Yalnızca 127.0.0.1:9092'yi dinler; Asterisk AudioSocket ile bağlanır.
// Çağrı bilgileri (kiracı, akış, callid, aranan numara, arayan) dialplan tarafından AstDB'ye yazılır: santralio_ai/<uuid>.
// Servis kararını santralio_ai/<uuid>/route anahtarına yazar ve bağlantıyı kapatır; dialplan oradan devam eder.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { Ami } from "../ami.ts";
import { PG_DATABASE, PG_HOST } from "../config.ts";
import { encode, KIND, Parser, uuidString } from "./audiosocket.ts";
import { AzureStt, AzureTts } from "./azure.ts";
import { ClaudeModel } from "./claude.ts";
import { FakeModel, FakeStt, PiperTts } from "./local.ts";
import type { FlowContext, LanguageModel, Route, SpeechToText, TextToSpeech } from "./providers.ts";
import { CallSession, type Result } from "./session.ts";

const PORT = Number(process.env.SANTRALIO_AI_PORT ?? 9092);
const REGION = process.env.SANTRALIO_AZURE_SPEECH_REGION ?? "westeurope";
const CACHE = process.env.SANTRALIO_AI_CACHE ?? "/var/lib/santralio/ai/cache";
// Yalnızca testler: anahtarsız, sahte ses tanıma ve dil modeli; seslendirme yerel Piper.
const FAKE = process.env.SANTRALIO_AI_FAKE === "1";
const FAKE_SAY = (process.env.SANTRALIO_AI_FAKE_SAY ?? "").split("|").filter(Boolean);

const pool = new pg.Pool({ host: PG_HOST, database: PG_DATABASE, max: 4 });

function secret(name: string): string | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  try {
    return readFileSync(join(dir, name), "utf8").trim() || null;
  } catch {
    return null;
  }
}
const AZURE_KEY = secret("santralio-azure-speech-key");
const ANTHROPIC_KEY = secret("santralio-anthropic-api-key");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function amiCommand(cmd: string): Promise<string[]> {
  const ami = await Ami.open();
  try {
    return await ami.command(cmd);
  } finally {
    await ami.close();
  }
}

// AstDB değerleri yalnızca bu karakterlerden oluşur (komut satırına güvenle yazılabilsin).
const safe = (s: string) => /^[A-Za-z0-9:_.|+-]*$/.test(s);

async function context(uuid: string) {
  const out = await amiCommand(`database get santralio_ai ${uuid}`);
  const value = out.find((l) => l.startsWith("Value: "))?.slice(7).trim();
  if (!value) return null;
  const [prefix, flow, callid, did, caller] = value.split("|");
  return { prefix, flow, callid, did, caller };
}

async function finish(uuid: string, target: string) {
  if (!safe(target)) throw new Error(`güvensiz hedef: ${target}`);
  await amiCommand(`database put santralio_ai ${uuid}/route ${target || "default"}`);
}

async function handle(sock: Socket) {
  const parser = new Parser();
  let session: CallSession | null = null;
  let uuid: string | null = null;
  const pending: Buffer[] = [];
  const send = (frame: Buffer) => {
    if (!sock.destroyed) sock.write(encode(KIND.audio, frame));
  };

  const ready = new Promise<void>((resolve) => {
    sock.on("data", (chunk: Buffer) => {
      for (const m of parser.push(chunk)) {
        if (m.kind === KIND.uuid && !uuid) {
          uuid = uuidString(m.payload);
          resolve();
        } else if (m.kind === KIND.audio) {
          if (session) session.audio(Buffer.from(m.payload));
          else if (pending.length < 50) pending.push(Buffer.from(m.payload));
        } else if (m.kind === KIND.hangup || m.kind === KIND.error) {
          session?.close();
        }
      }
    });
  });
  sock.on("close", () => session?.close());
  sock.on("error", () => session?.close());

  await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]);
  if (!uuid) return sock.destroy();
  const id = uuid as string;

  let db: pg.PoolClient | null = null;
  let sessionId: number | null = null;
  let routes: Route[] = [];
  try {
    const ctx = await context(id);
    if (!ctx) throw new Error("çağrı bilgisi yok");
    db = await pool.connect();
    const t = (await db.query("SELECT id, name, ai_enabled FROM tenants WHERE prefix = $1", [ctx.prefix])).rows[0];
    const flow = t ? (await db.query("SELECT * FROM ai_flows WHERE tenant_id = $1 AND name = $2", [t.id, ctx.flow])).rows[0] : null;
    sessionId = t
      ? (
          await db.query("INSERT INTO ai_sessions (tenant_id, flow, callid, caller, did) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
            t.id,
            ctx.flow,
            ctx.callid,
            ctx.caller,
            ctx.did,
          ])
        ).rows[0].id
      : null;
    if (!t?.ai_enabled || !flow?.enabled) throw new Error("yapay zekâ bu kiracıda ya da akışta kapalı");
    routes = (flow.routes as Route[]).filter((r) => r && typeof r.target === "string");

    let stt: SpeechToText;
    let llm: LanguageModel;
    let tts: TextToSpeech;
    if (FAKE) {
      stt = new FakeStt([...FAKE_SAY]);
      llm = new FakeModel();
      tts = new PiperTts();
    } else {
      if (!AZURE_KEY || !ANTHROPIC_KEY) throw new Error("Azure Speech ya da Anthropic anahtarı tanımlı değil");
      stt = new AzureStt(AZURE_KEY, REGION);
      llm = new ClaudeModel(ANTHROPIC_KEY);
      tts = String(flow.voice).startsWith("azure:") ? new AzureTts(AZURE_KEY, REGION, CACHE) : new PiperTts();
    }
    session = new CallSession({ stt, tts, llm, send, voice: flow.voice });
    for (const f of pending.splice(0)) session.audio(f);
    const fc: FlowContext = { company: t.name, instructions: flow.instructions, routes, defaultTarget: flow.default_target, model: flow.model };
    const result = await session.run(fc, flow.greeting_text, flow.max_turns);
    // Model listede olmayan bir hedef seçerse varsayılan kullanılır.
    const target = result.target === "hangup" ? "hangup" : routes.some((r) => r.target === result.target) ? result.target! : "default";
    await save(db, sessionId, result, target, tts, stt);
    if (result.reason !== "hangup") await finish(id, target);
    log(`${ctx.prefix}/${ctx.flow} ${ctx.callid}: ${result.reason} -> ${target}${result.error ? ` (${result.error})` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`oturum ${id}: ${msg}; varsayılan hedefe`);
    if (db && sessionId) await db.query("UPDATE ai_sessions SET ended_at = now(), end_reason = 'error', error = $2, route_target = 'default' WHERE id = $1", [sessionId, msg]).catch(() => {});
    await finish(id, "default").catch(() => {});
  } finally {
    db?.release();
    sock.end();
  }
}

async function save(db: pg.PoolClient, id: number | null, r: Result, target: string, tts: TextToSpeech, stt: SpeechToText) {
  if (!id) return;
  await db.query(
    `UPDATE ai_sessions SET ended_at = now(), route_target = $2, summary = $3, transcript = $4, end_reason = $5,
            stt_seconds = $6, tts_chars = $7, llm_input_tokens = $8, llm_output_tokens = $9, error = $10 WHERE id = $1`,
    [
      id,
      target,
      r.summary,
      JSON.stringify(r.history),
      r.reason,
      Math.round(stt.seconds * 10) / 10,
      tts instanceof AzureTts ? tts.chars : 0,
      r.inputTokens,
      r.outputTokens,
      r.error ?? null,
    ],
  );
}

// Panel için anahtar durumu (anahtarların kendisi değil).
writeFileSync(
  process.env.SANTRALIO_AI_STATUS ?? "/var/lib/santralio/ai/status.json",
  JSON.stringify({ fake: FAKE, azure: !!AZURE_KEY, anthropic: !!ANTHROPIC_KEY, region: REGION, at: new Date().toISOString() }),
);

const server = createServer((sock) => void handle(sock).catch((e) => log("bağlantı hatası", e)));
server.listen(PORT, "127.0.0.1", () =>
  log(`Santralio AI tcp://127.0.0.1:${PORT} · ${FAKE ? "TEST (sahte sağlayıcılar)" : `Azure ${AZURE_KEY ? "var" : "YOK"} · Anthropic ${ANTHROPIC_KEY ? "var" : "YOK"} · bölge ${REGION}`}`),
);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
