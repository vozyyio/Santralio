// Panel → Kaçan çağrılar: otomatik yapay zekâ geri araması ayarları, son işler, aranmak istemeyenler.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type CallbackJob, type CallbackOptout, type CallbackSettings } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const REASON: Record<CallbackJob["reason"], string> = { abandoned: "Beklerken kapattı", timeout: "Bekleme süresi doldu", no_agent: "Müsait temsilci yoktu" };
export const CB_STATUS: Record<CallbackJob["status"], [string, "ok" | "off" | ""]> = {
  pending: ["Sırada", ""],
  dialing: ["Aranıyor", ""],
  answered: ["Görüşüldü", "ok"],
  resolved: ["Başka görüşmede ulaşıldı", "ok"],
  no_answer: ["Açılmadı", "off"],
  skipped: ["Aranmadı", "off"],
  cancelled: ["İptal", "off"],
  failed: ["Hata", "off"],
};

export function CallbacksPage({ prefix }: { prefix: string }) {
  const [data, setData] = useState<{ settings: CallbackSettings; flows: { name: string; enabled: boolean }[]; defaults: { greetingTr: string; greetingEn: string } } | null>(null);
  const [jobs, setJobs] = useState<CallbackJob[] | null>(null);
  const [optout, setOptout] = useState<CallbackOptout[] | null>(null);
  const [error, setError] = useState("");
  const loadLists = useCallback(() => {
    api.cbJobs(prefix).then(setJobs).catch(() => setJobs([]));
    api.cbOptout(prefix).then(setOptout).catch(() => setOptout([]));
  }, [prefix]);
  useEffect(() => {
    api.cbSettings(prefix).then(setData).catch((e) => setError(err(e)));
    loadLists();
    const id = window.setInterval(loadLists, 15_000);
    return () => window.clearInterval(id);
  }, [prefix, loadLists]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Yükleniyor…</p>;
  return (
    <>
      <SettingsCard prefix={prefix} data={data} onSaved={(s) => setData({ ...data, settings: s })} />
      <JobsCard prefix={prefix} jobs={jobs} onChange={loadLists} />
      <OptoutCard prefix={prefix} list={optout} onChange={loadLists} />
    </>
  );
}

function SettingsCard({
  prefix,
  data,
  onSaved,
}: {
  prefix: string;
  data: { settings: CallbackSettings; flows: { name: string; enabled: boolean }[]; defaults: { greetingTr: string; greetingEn: string } };
  onSaved: (s: CallbackSettings) => void;
}) {
  const [s, setS] = useState<CallbackSettings>({ ...data.settings, aiFlow: data.settings.aiFlow || data.flows.find((f) => f.enabled)?.name || "" });
  const [msg, setMsg] = useState("");
  const set = <K extends keyof CallbackSettings>(k: K, v: CallbackSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      onSaved(await api.cbSave(prefix, s));
      setMsg("Kaydedildi.");
    } catch (e2) {
      setMsg(err(e2));
    }
  };
  const flows = data.flows.filter((f) => f.enabled);
  return (
    <form className="card" onSubmit={save}>
      <h2>Kaçan çağrıya otomatik geri arama</h2>
      <p className="muted">
        Arayan kuyrukta beklerken kapatırsa, bekleme süresi dolarsa ya da müsait temsilci yoksa; birkaç saniye içinde yapay zekâ asistanınız onu sizin hattınızdan geri arar,
        kendini yapay zekâ olarak tanıtır ve yardımcı olur. Gerekirse temsilciye aktarır.
      </p>
      {!flows.length && <p className="error small">Önce Yapay zekâ sayfasından açık bir yapay zekâ akışı oluşturun.</p>}
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={!flows.length} onChange={(e) => set("enabled", e.target.checked)} /> Açık
      </label>
      <div className="grid">
        <label>
          Yapay zekâ akışı
          <select value={s.aiFlow} onChange={(e) => set("aiFlow", e.target.value)}>
            {flows.map((f) => (
              <option key={f.name}>{f.name}</option>
            ))}
          </select>
        </label>
        <label>
          Kaç saniye sonra aransın
          <input type="number" min={5} max={3600} value={s.delayS} onChange={(e) => set("delayS", Number(e.target.value))} />
        </label>
        <label>
          En fazla deneme
          <input type="number" min={1} max={5} value={s.maxAttempts} onChange={(e) => set("maxAttempts", Number(e.target.value))} />
        </label>
        <label>
          Açılmazsa kaç dakika sonra tekrar
          <input type="number" min={2} max={240} value={s.retryMinutes} onChange={(e) => set("retryMinutes", Number(e.target.value))} />
        </label>
        <label>
          Aynı numara en fazla kaç saatte bir
          <input type="number" min={1} max={168} value={s.cooldownHours} onChange={(e) => set("cooldownHours", Number(e.target.value))} />
        </label>
        <label>
          Kaç dakikadan eski kaçanlar aranmasın
          <input type="number" min={5} max={1440} value={s.maxAgeMinutes} onChange={(e) => set("maxAgeMinutes", Number(e.target.value))} />
        </label>
        <label>
          Aynı anda en fazla geri arama
          <input type="number" min={1} max={10} value={s.maxConcurrent} onChange={(e) => set("maxConcurrent", Number(e.target.value))} />
        </label>
        <label>
          Arama saatleri
          <span className="row" style={{ margin: 0 }}>
            <input type="time" value={s.windowStart} onChange={(e) => set("windowStart", e.target.value)} />
            <span>–</span>
            <input type="time" value={s.windowEnd} onChange={(e) => set("windowEnd", e.target.value)} />
          </span>
        </label>
      </div>
      <div className="row">
        {DAYS.map((d, i) => (
          <label key={d} className="check">
            <input
              type="checkbox"
              checked={s.weekdays.includes(i + 1)}
              onChange={(e) => set("weekdays", e.target.checked ? [...s.weekdays, i + 1].sort() : s.weekdays.filter((x) => x !== i + 1))}
            />{" "}
            {d}
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={s.international} onChange={(e) => set("international", e.target.checked)} /> Yurt dışı numaraları da ara (operatör ücreti yüksek olabilir)
      </label>
      <label>
        Türkçe karşılama (boşsa hazır metin)
        <textarea rows={2} maxLength={500} value={s.greetingTr} placeholder={data.defaults.greetingTr} onChange={(e) => set("greetingTr", e.target.value)} />
      </label>
      <label>
        Diğer diller için karşılama (İngilizce; boşsa hazır metin)
        <textarea rows={2} maxLength={500} value={s.greetingEn} placeholder={data.defaults.greetingEn} onChange={(e) => set("greetingEn", e.target.value)} />
      </label>
      <p className="muted small">
        Karşılama, aramanın yapay zekâ tarafından yapıldığını mutlaka söylemeli. {"{firma}"} yerine işletme adınız yazılır. Gizli numaralar, 0850/444/0900 numaraları ve "aranmak
        istemeyenler" listesindekiler aranmaz; arayan bu arada başka bir görüşmede ulaşıldıysa geri arama yapılmaz.
      </p>
      <div className="row">
        <button>Kaydet</button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </form>
  );
}

function JobsCard({ prefix, jobs, onChange }: { prefix: string; jobs: CallbackJob[] | null; onChange: () => void }) {
  return (
    <div className="card">
      <h2>Son geri aramalar</h2>
      {!jobs ? (
        <p className="muted">Yükleniyor…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">Henüz kaçan çağrı yok.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kaçtı</th>
              <th>Numara</th>
              <th>Neden</th>
              <th>Durum</th>
              <th>Deneme</th>
              <th>Sonuç</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="small">{when(j.missedAt)}</td>
                <td className="mono small">{j.phone}</td>
                <td className="small">{REASON[j.reason]}</td>
                <td>
                  <span className={`badge ${CB_STATUS[j.status][1]}`}>{CB_STATUS[j.status][0]}</span>
                  {j.note && <div className="small muted">{j.note}</div>}
                </td>
                <td className="small">{j.attempts}</td>
                <td className="small">{j.aiSummary ?? "—"}</td>
                <td>
                  {j.status === "pending" && (
                    <button className="ghost" onClick={() => api.cbCancel(prefix, j.id).then(onChange)}>
                      İptal
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OptoutCard({ prefix, list, onChange }: { prefix: string; list: CallbackOptout[] | null; onChange: () => void }) {
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState("");
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      await api.cbOptoutAdd(prefix, phone, "panel");
      setPhone("");
      onChange();
    } catch (e2) {
      setMsg(err(e2));
    }
  };
  return (
    <div className="card">
      <h2>Aranmak istemeyenler</h2>
      <form className="row" onSubmit={add}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0532 123 45 67" inputMode="tel" required />
        <button>Ekle</button>
        {msg && <span className="small error">{msg}</span>}
      </form>
      {list && list.length > 0 ? (
        <table>
          <tbody>
            {list.map((o) => (
              <tr key={o.phone}>
                <td className="mono small">{o.phone}</td>
                <td className="small muted">{when(o.createdAt)}</td>
                <td>
                  <button className="ghost" onClick={() => api.cbOptoutRemove(prefix, o.phone).then(onChange)}>
                    Kaldır
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Liste boş.</p>
      )}
    </div>
  );
}
