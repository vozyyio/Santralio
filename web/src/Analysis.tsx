// Görüşme sonrası yapay zekâ analizi: ayar (Panel → Yapay zekâ) ve rapor (CRM → Yapay zekâ).

import { useEffect, useState } from "react";
import { api, ApiError, type AnalysisItem, type AnalysisOverview, type AnalysisSettings, type WeeklyReport } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const pct = (a: number, b: number) => (b ? `%${Math.round((a / b) * 100)}` : "–");

export function AnalysisSettingsCard({ prefix }: { prefix: string }) {
  const [s, setS] = useState<AnalysisSettings | null>(null);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [topics, setTopics] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.anSettings(prefix).then(
      (r) => {
        setS(r.settings);
        setModels(r.models);
        setTopics(r.settings.topics.join("\n"));
      },
      (e) => setMsg({ text: err(e), error: true }),
    );
  }, [prefix]);
  if (!s) return msg ? <div className="card"><p className="muted small">{msg.text}</p></div> : null;
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.anSave(prefix, { ...s, topics: topics.split("\n").map((x) => x.trim()).filter(Boolean) });
      setS(r);
      setTopics(r.topics.join("\n"));
      setMsg({ text: "Kaydedildi.", error: false });
    } catch (e) {
      setMsg({ text: err(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Görüşme sonrası analiz</h2>
      <p className="muted small">
        Yapay zekâ görüşmesi bittikten sonra döküm ayrı bir modelle incelenir: özet, konu, müşterinin genel hali, sonuç (asistan çözdü / aktarıldı /
        çözülmedi) ve takip edilecek iş. Görüşmeyi geciktirmez. Sonuçlar CRM → Yapay zekâ'da ve webhook'ta (call.analyzed). Uzun rakam dizileri
        (kart, IBAN) modele gitmeden maskelenir. Her görüşme için ayrıca model ücreti oluşur.
      </p>
      <label className="check">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
        Analizi aç
      </label>
      <div className="form-grid">
        <label>
          Model
          <select value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Konular (her satıra bir tane; listede olmayan “diğer” sayılır)
          <textarea rows={5} value={topics} onChange={(e) => setTopics(e.target.value)} placeholder={"Rezervasyon\nFiyat bilgisi\nŞikâyet\nİptal / değişiklik"} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.weeklyReport} onChange={(e) => setS({ ...s, weeklyReport: e.target.checked })} />
        Haftalık yapay zekâ raporu (her Pazartesi, geçen haftanın analizlerinden; en az 5 görüşme gerekir)
      </label>
      {s.weeklyReport && (
        <label>
          Rapor modeli (haftada bir çalışır; en güçlü model burada mantıklı)
          <select value={s.reportModel} onChange={(e) => setS({ ...s, reportModel: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="actions">
        <button disabled={busy} onClick={save}>
          Kaydet
        </button>
        {msg && <span className={msg.error ? "error small" : "ok small"}>{msg.text}</span>}
      </div>
    </div>
  );
}

const OUTCOME: Record<AnalysisItem["outcome"], [string, "ok" | "off" | ""]> = {
  ai_resolved: ["Asistan çözdü", "ok"],
  transferred: ["Aktarıldı", ""],
  unresolved: ["Çözülmedi", "off"],
  unknown: ["Belirsiz", ""],
};
const SENTIMENT: Record<AnalysisItem["sentiment"], string> = { positive: "Memnun", neutral: "Nötr", negative: "Olumsuz" };

export function AnalysisReport({ prefix }: { prefix: string }) {
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState<{ outcome?: string; sentiment?: string; followUp?: boolean }>({});
  const [data, setData] = useState<{ overview: AnalysisOverview; items: AnalysisItem[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.anReport(prefix, { days, ...filter }).then(setData, (e) => setError(err(e)));
  }, [prefix, days, filter]);
  if (error) return null; // modül yoksa ya da yetki yoksa bu kart görünmez
  if (!data) return null;
  const o = data.overview;
  if (o.total === 0 && !o.failed) return null;
  const pick = (f: typeof filter) => setFilter(JSON.stringify(f) === JSON.stringify(filter) ? {} : f);
  return (
    <div className="card">
      <div className="row spread">
        <h3>Görüşme analizi</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Son 7 gün</option>
          <option value={30}>Son 30 gün</option>
          <option value={90}>Son 90 gün</option>
        </select>
      </div>
      <div className="an-kpis">
        <button className={`an-kpi ${filter.outcome === "ai_resolved" ? "on" : ""}`} onClick={() => pick({ outcome: "ai_resolved" })}>
          <strong>{pct(o.aiResolved, o.total)}</strong>
          <span>Asistan çözdü · {o.aiResolved}</span>
        </button>
        <button className={`an-kpi ${filter.outcome === "transferred" ? "on" : ""}`} onClick={() => pick({ outcome: "transferred" })}>
          <strong>{pct(o.transferred, o.total)}</strong>
          <span>Aktarıldı · {o.transferred}</span>
        </button>
        <button className={`an-kpi ${filter.outcome === "unresolved" ? "on" : ""}`} onClick={() => pick({ outcome: "unresolved" })}>
          <strong>{pct(o.unresolved, o.total)}</strong>
          <span>Çözülmedi · {o.unresolved}</span>
        </button>
        <button className={`an-kpi ${filter.sentiment === "negative" ? "on" : ""}`} onClick={() => pick({ sentiment: "negative" })}>
          <strong>{o.negative}</strong>
          <span>Olumsuz geçen</span>
        </button>
        <button className={`an-kpi ${filter.followUp ? "on" : ""}`} onClick={() => pick({ followUp: true })}>
          <strong>{o.followUps}</strong>
          <span>Takip gerektiren</span>
        </button>
      </div>
      {o.topics.length > 0 && (
        <>
          <h4>Konular</h4>
          <ul className="an-topics">
            {o.topics.map((t) => (
              <li key={t.topic}>
                <span className="an-bar" style={{ width: `${Math.max(4, (t.n / o.topics[0].n) * 100)}%` }} />
                <span className="an-topic">{t.topic}</span>
                <span className="small muted">
                  {t.n} · asistan çözdü {pct(t.ai_resolved, t.n)}
                  {t.negative ? ` · ${t.negative} olumsuz` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">
        {o.total} görüşme analiz edildi{o.failed ? ` · ${o.failed} analiz yapılamadı` : ""} · {Math.round((o.inputTokens + o.outputTokens) / 1000)} bin token
      </p>
      <ul className="hook-list">
        {data.items.slice(0, 50).map((a) => (
          <li key={a.id}>
            <div className="hook-head">
              <span className="small">
                <span className="mono">{a.startedAt}</span> · <span className="mono">{a.caller || "gizli"}</span> · {a.topic}
              </span>
              <span className={`badge ${OUTCOME[a.outcome][1]}`}>{OUTCOME[a.outcome][0]}</span>
            </div>
            <div className="small">{a.summary}</div>
            <div className="small muted hook-meta">
              <span>{SENTIMENT[a.sentiment]}</span>
              {a.followUp && <span className="an-follow">Takip: {a.followUp}</span>}
            </div>
          </li>
        ))}
        {data.items.length === 0 && <li className="muted small">Bu filtrede görüşme yok.</li>}
      </ul>
    </div>
  );
}

export function WeeklyReportCard({ prefix }: { prefix: string }) {
  const [rows, setRows] = useState<WeeklyReport[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    api.anReports(prefix).then(setRows, () => setRows([]));
  }, [prefix]);
  if (!rows || rows.length === 0) return null;
  const r = rows[i];
  const st = r.stats;
  const section = (title: string, items: string[]) =>
    items.length > 0 && (
      <>
        <h4>{title}</h4>
        <ul className="report-list">
          {items.map((x, k) => (
            <li key={k}>{x}</li>
          ))}
        </ul>
      </>
    );
  return (
    <div className="card">
      <div className="row spread">
        <h3>Haftalık rapor</h3>
        <select value={i} onChange={(e) => setI(Number(e.target.value))}>
          {rows.map((x, k) => (
            <option key={x.id} value={k}>
              {x.periodStart} – {x.periodEnd}
            </option>
          ))}
        </select>
      </div>
      <p className="report-headline">{r.report.headline}</p>
      <p className="small muted">
        {st.total} görüşme (önceki hafta {st.previousTotal}) · asistan çözdü {pct(st.aiResolved, st.total)} · aktarıldı {pct(st.transferred, st.total)} · çözülmedi{" "}
        {pct(st.unresolved, st.total)} · {st.negative} olumsuz · {st.followUps} takip
      </p>
      <div className="report-cols">
        <div>{section("Öne çıkanlar", r.report.highlights)}</div>
        <div>{section("Sorunlar", r.report.problems)}</div>
        <div>{section("Bu hafta yapılabilecekler", r.report.suggestions)}</div>
      </div>
    </div>
  );
}
