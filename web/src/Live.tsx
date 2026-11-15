// Canlı durum: bekleyenler, süren görüşmeler, temsilci durumu, uyarılar. TV modu: #/tv/<önek>.
// Sunucu 2 sn önbellekli; ekran 3 sn'de bir sorar, süreler aradaki saniyelerde yerelde ilerler.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Live, type LiveSettings } from "./api";

const mmss = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

const AGENT: Record<Live["agents"][number]["state"], [string, string]> = {
  available: ["Müsait", "ok"],
  busy: ["Görüşmede", "busy"],
  ringing: ["Çalıyor", "ring"],
  paused: ["Molada", "pause"],
  offline: ["Çevrimdışı", "off"],
};
const STAGE: Record<Live["calls"][number]["stage"], string> = {
  queue: "Kuyrukta",
  ai: "Yapay zekâ",
  menu: "Menüde",
  ringing: "Çalıyor",
  talking: "Görüşmede",
  other: "Bağlanıyor",
};

function useLive(prefix: string) {
  const [data, setData] = useState<Live | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState("");
  const [, tick] = useState(0);
  const lastOk = useRef(Date.now());
  const loaded = useRef(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api.live(prefix).then(
        (d) => {
          if (stop) return;
          setData(d);
          loaded.current = true;
          setFetchedAt(Date.now());
          setError("");
          lastOk.current = Date.now();
        },
        (e) => {
          if (stop) return;
          // Kısa kopmalarda eski veri kalır; 10 sn'yi geçerse (ya da hiç veri gelmediyse) uyarı gösterilir.
          if (!loaded.current || Date.now() - lastOk.current > 10_000 || !(e instanceof ApiError && e.status >= 500))
            setError(e instanceof ApiError && e.status >= 500 ? "santrale ulaşılamıyor" : e instanceof ApiError ? e.message : "bağlantı yok");
        },
      );
    void load();
    const p = window.setInterval(load, 3000);
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      stop = true;
      window.clearInterval(p);
      window.clearInterval(t);
    };
  }, [prefix]);
  const age = fetchedAt ? Math.floor((Date.now() - fetchedAt) / 1000) : 0;
  return { data, error, age };
}

// Yeni uyarıda kısa bir bip (isteğe bağlı; tarayıcı ilk tıklamadan önce sese izin vermez).
function useAlertSound(alerts: Live["alerts"] | undefined, enabled: boolean) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!alerts) return;
    const keys = new Set(alerts.map((a) => `${a.kind}:${a.queue}`));
    const fresh = [...keys].some((k) => !seen.current.has(k));
    seen.current = keys;
    document.title = alerts.length ? `(${alerts.length}) Uyarı · Santralio` : "Santralio Panel";
    if (!fresh || !enabled) return;
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    } catch {
      /* ses yok */
    }
  }, [alerts, enabled]);
  useEffect(() => () => void (document.title = "Santralio Panel"), []);
}

function Kpis({ d, age, big }: { d: Live; age: number; big?: boolean }) {
  const avail = d.agents.filter((a) => a.state === "available").length;
  const longest = d.waiting ? d.longestWaitS + age : 0;
  return (
    <div className={`live-kpis ${big ? "big" : ""}`}>
      <div className={`live-kpi ${d.waiting ? "warn" : ""}`}>
        <strong>{d.waiting}</strong>
        <span>Bekleyen</span>
      </div>
      <div className={`live-kpi ${d.alerts.some((a) => a.kind === "wait") ? "bad" : ""}`}>
        <strong className="mono">{longest ? mmss(longest) : "—"}</strong>
        <span>En uzun bekleme</span>
      </div>
      <div className="live-kpi">
        <strong>{d.talking}</strong>
        <span>Görüşmede</span>
      </div>
      <div className="live-kpi">
        <strong>{d.ai}</strong>
        <span>Yapay zekâda</span>
      </div>
      <div className={`live-kpi ${avail === 0 && d.agents.some((a) => a.state !== "offline") ? "warn" : ""}`}>
        <strong>
          {avail}
          <small> / {d.agents.filter((a) => a.state !== "offline").length}</small>
        </strong>
        <span>Müsait temsilci</span>
      </div>
    </div>
  );
}

function Agents({ d }: { d: Live }) {
  if (!d.agents.length) return <p className="muted small">Dahili yok.</p>;
  return (
    <div className="live-agents">
      {d.agents.map((a) => (
        <div key={a.number} className={`live-agent s-${AGENT[a.state][1]}`}>
          <span className="live-dot" />
          <span className="live-agent-name">
            <strong className="mono">{a.number}</strong> {a.name}
          </span>
          <span className="live-agent-state">
            {AGENT[a.state][0]}
            {a.pauseReason ? ` · ${a.pauseReason}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function Calls({ d, age }: { d: Live; age: number }) {
  if (!d.calls.length) return <p className="muted small">Şu an süren arama yok.</p>;
  return (
    <ul className="live-calls">
      {d.calls.map((c) => (
        <li key={c.id} className={`st-${c.stage}`}>
          <span className="mono live-caller">{c.direction === "internal" ? `Dahili ${c.caller}` : c.caller}</span>
          <span className="live-stage">
            {STAGE[c.stage]}
            {c.queue ? ` · ${c.queue}` : ""}
            {c.agent ? ` · ${c.agent}` : ""}
            {c.direction === "out" ? " · giden" : ""}
          </span>
          <span className="mono live-dur">{mmss((c.stage === "queue" && c.waitS !== null ? c.waitS : c.durationS) + age)}</span>
        </li>
      ))}
    </ul>
  );
}

export function LivePage({ prefix, canManage }: { prefix: string; canManage: boolean }) {
  const { data: d, error, age } = useLive(prefix);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem("santralio-live-sound") === "1";
    } catch {
      return false;
    }
  });
  useAlertSound(d?.alerts, sound);
  const toggleSound = () => {
    setSound(!sound);
    try {
      localStorage.setItem("santralio-live-sound", sound ? "0" : "1");
    } catch {
      /* yok */
    }
  };
  return (
    <>
      <div className="row spread live-head">
        <p className="muted small">
          {d ? `Canlı · ${new Date(d.at).toLocaleTimeString("tr-TR")}` : error ? "Canlı durum alınamadı" : "Yükleniyor…"}
          {error && <span className="error"> · {error}</span>}
        </p>
        <div className="row wrap-actions">
          <button className="ghost" onClick={toggleSound}>
            {sound ? "Uyarı sesi: açık" : "Uyarı sesi: kapalı"}
          </button>
          <a className="button ghost" href={`#/tv/${prefix}`} target="_blank" rel="noreferrer">
            TV ekranı
          </a>
        </div>
      </div>
      {d && (
        <>
          {d.alerts.length > 0 && (
            <div className="live-alerts">
              {d.alerts.map((a) => (
                <div key={`${a.kind}:${a.queue}`}>{a.message}</div>
              ))}
            </div>
          )}
          <Kpis d={d} age={age} />
          <div className="live-grid">
            <div className="card">
              <h3>Süren aramalar</h3>
              <Calls d={d} age={age} />
            </div>
            <div className="card">
              <h3>Temsilciler</h3>
              <Agents d={d} />
            </div>
          </div>
          {d.queues.length > 0 && (
            <div className="card">
              <h3>Kuyruklar</h3>
              <div className="live-queues">
                {d.queues.map((q) => (
                  <div key={q.name} className={`live-queue ${q.waiting ? "has-wait" : ""}`}>
                    <strong>{q.name}</strong>
                    <span>
                      {q.waiting} bekleyen{q.waiting ? ` · en uzun ${mmss(q.longestWaitS + age)}` : ""}
                    </span>
                    <span className="muted small">
                      {q.available} müsait · {q.busy} görüşmede · {q.paused} molada · {q.members} üye
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {canManage && <Thresholds prefix={prefix} />}
        </>
      )}
    </>
  );
}

function Thresholds({ prefix }: { prefix: string }) {
  const [s, setS] = useState<LiveSettings | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.liveSettings(prefix).then(setS, () => setS(null));
  }, [prefix]);
  const save = useCallback(() => {
    if (!s) return;
    api.liveSave(prefix, s).then(
      (r) => {
        setS(r);
        setMsg("Kaydedildi.");
      },
      (e) => setMsg(e instanceof ApiError ? e.message : "Kaydedilemedi"),
    );
  }, [prefix, s]);
  if (!s) return null;
  return (
    <div className="card">
      <h3>Uyarı eşikleri</h3>
      <div className="form-grid">
        <label>
          Bekleme uyarısı (saniye)
          <input type="number" min={10} max={1800} value={s.waitAlertS} onChange={(e) => setS({ ...s, waitAlertS: Number(e.target.value) })} />
        </label>
        <label>
          Bekleyen sayısı uyarısı
          <input type="number" min={1} max={100} value={s.waitingAlertN} onChange={(e) => setS({ ...s, waitingAlertN: Number(e.target.value) })} />
        </label>
      </div>
      <div className="actions">
        <button onClick={save}>Kaydet</button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
    </div>
  );
}

// Duvar ekranı: menü yok, büyük yazı, koyu zemin, saat.
export function LiveTv({ prefix, name }: { prefix: string; name: string }) {
  const { data: d, error, age } = useLive(prefix);
  useAlertSound(d?.alerts, false);
  useEffect(() => {
    document.documentElement.dataset.tv = "1";
    return () => void delete document.documentElement.dataset.tv;
  }, []);
  return (
    <div className="tv">
      <header className="tv-head">
        <span className="tv-brand">
          Santral<b>io</b> · {name}
        </span>
        <span className="mono tv-clock">{new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span>
      </header>
      {error && <div className="tv-error">Bağlantı yok: {error}</div>}
      {d && (
        <>
          {d.alerts.length > 0 && (
            <div className="live-alerts tv-alerts">
              {d.alerts.map((a) => (
                <div key={`${a.kind}:${a.queue}`}>{a.message}</div>
              ))}
            </div>
          )}
          <Kpis d={d} age={age} big />
          <div className="tv-grid">
            <section>
              <h2>Kuyruklar</h2>
              {d.queues.map((q) => (
                <div key={q.name} className={`tv-queue ${q.waiting ? "has-wait" : ""}`}>
                  <span>{q.name}</span>
                  <strong>{q.waiting}</strong>
                  <span className="mono">{q.waiting ? mmss(q.longestWaitS + age) : "—"}</span>
                </div>
              ))}
              {!d.queues.length && <p className="muted">Kuyruk yok.</p>}
            </section>
            <section>
              <h2>Temsilciler</h2>
              <Agents d={d} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
