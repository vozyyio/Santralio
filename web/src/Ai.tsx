// Santralio: yapay zekâ karşılaması. Panel: kiracıda açma (platform), akış düzenleme, kullanım.
// CRM: görüşme dökümleri. Temsilci ekranı: aktarılan aramanın özeti.

import { useEffect, useState } from "react";
import { api, type AiFlow, type AiInfo, type Tenant } from "./api";
import { RangePicker } from "./Reports";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());

const NEW_FLOW: AiFlow = {
  name: "karsilama",
  enabled: true,
  greetingText: "Hoş geldiniz. Görüşmeniz yapay zekâ destekli asistanımız tarafından karşılanmaktadır. Size nasıl yardımcı olabilirim?",
  instructions: "",
  routes: [],
  defaultTarget: null,
  maxTurns: 4,
  voice: "azure:tr-TR-EmelNeural",
  model: "claude-haiku-5-5",
  languages: ["tr-TR"],
  greetings: {},
};

// Dil kodu -> bayrak ve ad (görüşme listesi ve temsilci özeti için; sunucudaki katalogla aynı).
const LANG: Record<string, [string, string]> = {
  "tr-TR": ["🇹🇷", "Türkçe"],
  "en-US": ["🇬🇧", "İngilizce"],
  "de-DE": ["🇩🇪", "Almanca"],
  "ru-RU": ["🇷🇺", "Rusça"],
  "ar-SA": ["🇸🇦", "Arapça"],
  "fr-FR": ["🇫🇷", "Fransızca"],
  "it-IT": ["🇮🇹", "İtalyanca"],
};

function targetOptions(t: Tenant) {
  return [
    ...t.queues.map((q) => [`queue:${q.name}`, `Kuyruk: ${q.name}`]),
    ...t.menus.map((m) => [`menu:${m.name}`, `Menü: ${m.name}`]),
    ...t.extensions.filter((e) => e.enabled).map((e) => [`ext:${e.number}`, `Dahili: ${e.number}${e.display_name ? ` · ${e.display_name}` : ""}`]),
  ] as [string, string][];
}

export function AiTab({ t, reload }: { t: Tenant; reload: () => void }) {
  const [info, setInfo] = useState<AiInfo | null>(null);
  const [error, setError] = useState("");
  const load = () => api.ai(t.prefix).then(setInfo).catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [t.prefix]);
  if (error) return <p className="error">{error}</p>;
  if (!info) return <p className="muted">Yükleniyor…</p>;
  const s = info.service;
  const ready = !!s && (s.fake || (s.azure && s.anthropic));
  const toggle = async () => {
    try {
      await api.setAiEnabled(t.prefix, !info.enabled);
      await load();
      reload();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <>
      <div className="card">
        <div className="row spread">
          <h3>
            Yapay zekâ karşılaması <span className={`badge ${info.enabled ? "ok" : "off"}`}>{info.enabled ? "Açık" : "Kapalı"}</span>
          </h3>
          {info.editable && (
            <button className={info.enabled ? "ghost" : ""} onClick={toggle}>
              {info.enabled ? "Bu müşteride kapat" : "Bu müşteride aç"}
            </button>
          )}
        </div>
        <p className="muted small">
          Arayanı bir asistan karşılar, derdini anlar, kısa soruları yanıtlar ve uygun yere özetle aktarır. Ses Azure Speech (AB bölgesi), dil modeli Claude.
          Arayanın sesi ve konuşma metni bu sağlayıcılara gider (KVKK: aydınlatma metninde belirtin). Hata, sessizlik ya da tur sınırında arama varsayılan yere
          aktarılır; düşmez.
          {!info.editable && " Açıp kapatmak için platform yöneticisine başvurun."}
        </p>
        {info.editable && (
          <p className="small">
            Servis:{" "}
            {!s ? (
              <span className="badge off">Çalışmıyor</span>
            ) : s.fake ? (
              <span className="badge off">Test modu</span>
            ) : (
              <>
                Azure <span className={`badge ${s.azure ? "ok" : "off"}`}>{s.azure ? "anahtar var" : "anahtar yok"}</span> · Anthropic{" "}
                <span className={`badge ${s.anthropic ? "ok" : "off"}`}>{s.anthropic ? "anahtar var" : "anahtar yok"}</span> · bölge {s.region}
              </>
            )}
            {!ready && <span className="muted"> — anahtarlar: sunucuda <span className="mono">sudo infra/set-secret.sh azure-speech</span> ve <span className="mono">anthropic</span></span>}
          </p>
        )}
        <p className="small muted">
          Son 30 gün: {info.usage.sessions} görüşme · {info.usage.transferred} aktarıldı · {info.usage.errors} hata · {Math.round(info.usage.sttSeconds / 60)} dk ses ·{" "}
          {info.usage.ttsChars} karakter seslendirme · {info.usage.inputTokens + info.usage.outputTokens} token
        </p>
      </div>
      {(info.flows.length ? info.flows : [NEW_FLOW]).map((f) => (
        <FlowEditor key={f.name} t={t} flow={f} info={info} onSaved={() => (load(), reload())} isNew={!info.flows.length} />
      ))}
    </>
  );
}

function FlowEditor({ t, flow, info, onSaved, isNew }: { t: Tenant; flow: AiFlow; info: AiInfo; onSaved: () => void; isNew: boolean }) {
  const [f, setF] = useState<AiFlow>(flow);
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const options = targetOptions(t);
  const set = (patch: Partial<AiFlow>) => setF({ ...f, ...patch });
  const save = async () => {
    try {
      await api.saveAiFlow(t.prefix, f.name, f);
      setState({ msg: "Kaydedildi ve santrale uygulandı.", error: false });
      onSaved();
    } catch (e) {
      setState({ msg: msg(e), error: true });
    }
  };
  return (
    <div className="card">
      <div className="row spread">
        <h3>
          Akış: <span className="mono">{f.name}</span> {isNew && <span className="muted small">(yeni)</span>}
        </h3>
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Akış açık
        </label>
      </div>
      <p className="muted small">
        Bir numarayı, menü tuşunu ya da çalışma saatini bu akışa bağlamak için hedef olarak “Yapay zekâ: {f.name}” seçin (Genel, Menüler, Çalışma saatleri).
      </p>
      <label>
        Karşılama (arayana ilk okunan cümle)
        <textarea rows={2} value={f.greetingText} onChange={(e) => set({ greetingText: e.target.value })} maxLength={500} />
      </label>
      <label>
        Asistanın bilmesi gerekenler (şirket, hizmetler, sık sorular, çalışma şekli; arayana okunmaz)
        <textarea rows={6} value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} maxLength={8000} />
      </label>
      <h4>Diller</h4>
      <p className="muted small">
        Türkçe her zaman açık. Karşılama arayanın numarasının ülkesine göre o dilde okunur (bilinmeyen yabancı numarada İngilizce, açıksa); arayan hangi
        dilde konuşursa asistan o dilde ve o dilin doğal sesiyle devam eder (seçtiğiniz sesin cinsiyetinde). Temsilci özeti her zaman Türkçe görür.
        Yalnızca gerçekten gereken dilleri açın: aday dil sayısı arttıkça tanıma yanılabilir.
      </p>
      <div className="row wrap">
        {info.languages.map((l) => (
          <label className="check" key={l.code}>
            <input
              type="checkbox"
              disabled={l.code === "tr-TR"}
              checked={l.code === "tr-TR" || f.languages.includes(l.code)}
              onChange={(e) =>
                set({ languages: e.target.checked ? [...f.languages, l.code] : f.languages.filter((c) => c !== l.code) })
              }
            />
            {l.flag} {l.label}
          </label>
        ))}
      </div>
      {info.languages
        .filter((l) => l.code !== "tr-TR" && f.languages.includes(l.code))
        .map((l) => (
          <label key={l.code}>
            {l.flag} {l.label} karşılama (boş bırakılırsa hazır metin)
            <textarea
              rows={2}
              dir={l.code.startsWith("ar") ? "rtl" : undefined}
              placeholder={l.defaultGreeting}
              value={f.greetings[l.code] ?? ""}
              onChange={(e) => set({ greetings: { ...f.greetings, [l.code]: e.target.value } })}
              maxLength={500}
            />
          </label>
        ))}
      <p className="muted small">
        Dile göre aktarmak için bir yer ekleyip açıklamasına dili yazın, ör. “Almanca konuşan misafirler”. O dilde temsilci yoksa kuyruğun “müsait temsilci
        yoksa” ayarı geçerlidir.
      </p>
      <h4>Aktarılabilecek yerler</h4>
      {f.routes.map((r, i) => (
        <div className="row" key={i}>
          <select value={r.target} onChange={(e) => set({ routes: f.routes.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })}>
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input
            placeholder="Ne zaman? (ör. fatura, ödeme, borç)"
            value={r.description}
            onChange={(e) => set({ routes: f.routes.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
            maxLength={200}
          />
          <button className="ghost" onClick={() => set({ routes: f.routes.filter((_, j) => j !== i) })}>
            Kaldır
          </button>
        </div>
      ))}
      {options.length > 0 && f.routes.length < 12 && (
        <button className="ghost" onClick={() => set({ routes: [...f.routes, { target: options[0][0], description: "" }] })}>
          + Yer ekle
        </button>
      )}
      <div className="row">
        <label className="inline">
          Anlaşılamazsa / hata olursa
          <select value={f.defaultTarget ?? ""} onChange={(e) => set({ defaultTarget: e.target.value || null })}>
            <option value="">Kapat</option>
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          En fazla tur
          <input type="number" min={1} max={10} value={f.maxTurns} onChange={(e) => set({ maxTurns: Number(e.target.value) })} />
        </label>
        <label className="inline">
          Ses
          <select value={f.voice} onChange={(e) => set({ voice: e.target.value })}>
            {info.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Model
          <select value={f.model} onChange={(e) => set({ model: e.target.value })}>
            {info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button onClick={save}>Kaydet</button>
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
    </div>
  );
}

export function AiSessions({ prefix }: { prefix: string }) {
  const [range, setRange] = useState<[string, string]>([today(), today()]);
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(null);
    api.aiSessions(prefix, range[0], range[1]).then(setRows).catch((e) => setError(msg(e)));
  }, [prefix, range]);
  const REASON: Record<string, string> = {
    transfer: "Aktarıldı",
    end: "Görüşme bitti",
    max_turns: "Tur sınırı",
    silence: "Sessizlik",
    error: "Hata",
    hangup: "Arayan kapattı",
    timeout: "Süre doldu",
  };
  return (
    <div className="card">
      <h3>Yapay zekâ görüşmeleri</h3>
      <RangePicker from={range[0]} to={range[1]} onChange={(f, t) => setRange([f, t])} />
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Bu aralıkta görüşme yok.</p>
      ) : (
        <ul className="notes">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="row spread">
                <span className="small">
                  <span className="mono">{r.started}</span> · <span className="mono">{r.caller || "gizli"}</span> ·{" "}
                  {r.language && r.language !== "tr-TR" ? `${LANG[r.language]?.[0] ?? ""} ${LANG[r.language]?.[1] ?? r.language} · ` : ""} {REASON[r.reason] ?? r.reason ?? "sürüyor"}
                  {r.target && r.target !== "default" ? ` → ${r.target}` : r.target === "default" ? " → varsayılan" : ""} · {r.durationS ?? "–"} sn
                </span>
                <button className="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Gizle" : "Döküm"}
                </button>
              </div>
              {r.summary && <div className="small">Özet: {r.summary}</div>}
              {r.error && <div className="small error">{r.error}</div>}
              {open === r.id && (
                <div className="transcript">
                  {(r.transcript as { role: string; text: string }[]).map((x, i) => (
                    <p key={i} className={x.role === "caller" ? "caller-line" : "assistant-line"}>
                      <strong>{x.role === "caller" ? "Arayan" : "Asistan"}:</strong> {x.text}
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiSummary({ prefix, callid }: { prefix: string; callid: string }) {
  const [s, setS] = useState<{ summary: string | null; transcript: { role: string; text: string }[]; language: string | null } | null>(null);
  useEffect(() => {
    api.aiSummary(prefix, callid).then(setS).catch(() => setS(null));
  }, [prefix, callid]);
  if (!s || (!s.summary && !s.transcript?.length)) return null;
  const said = s.transcript.filter((x) => x.role === "caller").map((x) => x.text);
  return (
    <div className="ai-summary">
      <strong>Arayanın derdi (yapay zekâ özeti)</strong>
      {s.language && s.language !== "tr-TR" && (
        <p className="lang-note">
          {LANG[s.language]?.[0]} {LANG[s.language]?.[1] ?? s.language} konuşuyor
        </p>
      )}
      {s.summary && <p>{s.summary}</p>}
      {said.length > 0 && <p className="small muted">Söyledikleri: “{said.join(" … ")}”</p>}
    </div>
  );
}
