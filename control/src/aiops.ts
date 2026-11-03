// Santralio: yapay zekâ akışlarının kaydı ve doğrulaması (CLI ve API ortak kullanır).

import { audit, type Db } from "./db.ts";
import { assertTarget, UserError, type Tenant } from "./ops.ts";
import { listVoices } from "./voices.ts";

// Yapay zekâ karşılamasında kullanılabilecek sesler: Azure'un doğal Türkçe sesleri ve yerel Piper sesleri.
export const AZURE_VOICES = [
  { id: "azure:tr-TR-EmelNeural", label: "Emel · kadın · doğal (Azure)" },
  { id: "azure:tr-TR-AhmetNeural", label: "Ahmet · erkek · doğal (Azure)" },
];
export const AI_MODELS = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 · hızlı, düşük maliyet (önerilen)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 · daha güçlü" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 · en güçlü, en yavaş" },
];
export const aiVoices = () => [...AZURE_VOICES, ...listVoices().filter((v) => v.engine === "piper").map((v) => ({ id: v.id, label: `${v.label} · yerel` }))];

export type FlowInput = {
  enabled: boolean;
  greetingText: string;
  instructions: string;
  routes: { target: string; description: string }[];
  defaultTarget: string | null;
  maxTurns: number;
  voice: string;
  model: string;
};

export async function saveFlow(db: Db, t: Tenant, name: string, f: FlowInput, actor?: string) {
  if (!/^[a-z0-9_]{1,32}$/.test(name)) throw new UserError("akış adı küçük harf, rakam ve _ olmalı");
  if (typeof f.enabled !== "boolean") throw new UserError("enabled true/false olmalı");
  if (!f.greetingText?.trim() || f.greetingText.length > 500) throw new UserError("karşılama 1–500 karakter olmalı");
  if ((f.instructions ?? "").length > 8000) throw new UserError("yönergeler en fazla 8000 karakter");
  if (!Array.isArray(f.routes) || f.routes.length > 12) throw new UserError("en fazla 12 yönlendirme");
  const seen = new Set<string>();
  for (const r of f.routes) {
    if (typeof r?.target !== "string" || typeof r?.description !== "string") throw new UserError("yönlendirme { target, description } olmalı");
    if (r.target.startsWith("ai:")) throw new UserError("yapay zekâ akışı başka bir akışa yönlendiremez");
    if (!r.description.trim() || r.description.length > 200) throw new UserError("yönlendirme açıklaması 1–200 karakter olmalı");
    if (seen.has(r.target)) throw new UserError(`aynı hedef iki kez: ${r.target}`);
    seen.add(r.target);
    await assertTarget(db, t, r.target);
  }
  if (f.defaultTarget) {
    if (f.defaultTarget.startsWith("ai:")) throw new UserError("varsayılan hedef bir yapay zekâ akışı olamaz");
    await assertTarget(db, t, f.defaultTarget);
  }
  if (!Number.isInteger(f.maxTurns) || f.maxTurns < 1 || f.maxTurns > 10) throw new UserError("tur sınırı 1–10 olmalı");
  if (!aiVoices().some((v) => v.id === f.voice)) throw new UserError("ses bulunamadı");
  if (!AI_MODELS.some((m) => m.id === f.model)) throw new UserError("model bulunamadı");
  await db.query(
    `INSERT INTO ai_flows (tenant_id, name, enabled, greeting_text, instructions, routes, default_target, max_turns, voice, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, name) DO UPDATE SET enabled = $3, greeting_text = $4, instructions = $5, routes = $6,
       default_target = $7, max_turns = $8, voice = $9, model = $10, updated_at = now()`,
    [t.id, name, f.enabled, f.greetingText.trim(), f.instructions ?? "", JSON.stringify(f.routes), f.defaultTarget, f.maxTurns, f.voice, f.model],
  );
  await audit(db, "ai.flow", t.id, { name, enabled: f.enabled, routes: f.routes.map((r) => r.target), model: f.model, voice: f.voice }, actor);
}
