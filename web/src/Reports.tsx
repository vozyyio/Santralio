// Santralio: görüşme listesi ve raporlar (kuyruk olaylarından).

import { useEffect, useState } from "react";
import { api, type CallRow, type Outcome, type Summary, type Tenant } from "./api";

const TZ = "Europe/Istanbul";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);

export function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const pct = (x: number | null) => (x === null ? "–" : `%${Math.round(x * 100)}`);
const num = (n: number) => n.toLocaleString("tr-TR");

const OUTCOME: Record<Outcome, [string, boolean]> = {
  answered: ["Cevaplandı", true],
  abandoned: ["Arayan kapattı", false],
  timeout: ["Bekleme süresi doldu", false],
  no_agent: ["Müsait temsilci yok", false],
  open: ["Sürüyor", true],
};

export function RangePicker({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const t = today();
  const presets: [string, string, string][] = [
    ["Bugün", t, t],
    ["Dün", shift(t, -1), shift(t, -1)],
    ["Son 7 gün", shift(t, -6), t],
    ["Bu ay", `${t.slice(0, 8)}01`, t],
  ];
  return (
    <div className="row filters">
      {presets.map(([label, f, e]) => (
        <button key={label} className={from === f && to === e ? "" : "ghost"} onClick={() => onChange(f, e)}>
          {label}
        </button>
      ))}
      <input type="date" value={from} max={to} onChange={(e) => e.target.value && onChange(e.target.value, to)} aria-label="Başlangıç" />
      <span className="muted">–</span>
      <input type="date" value={to} min={from} onChange={(e) => e.target.value && onChange(from, e.target.value)} aria-label="Bitiş" />
    </div>
  );
}

function useRange(): [string, string, (f: string, t: string) => void] {
  const [range, setRange] = useState<[string, string]>([today(), today()]);
  return [range[0], range[1], (f, t) => setRange([f, t])];
}

export function Calls({ t }: { t: Tenant }) {
  const [from, to, setRange] = useRange();
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api.calls(t.prefix, from, to).then(setRows).catch((e) => setError(String(e.message ?? e)));
  }, [t.prefix, from, to]);
  return (
    <div className="card">
      <h3>Görüşmeler</h3>
      <RangePicker from={from} to={to} onChange={setRange} />
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Bu aralıkta görüşme yok.</p>
      ) : (
        <div className="scroll">
          <table className="numeric">
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Arayan</th>
                <th>Kuyruk</th>
                <th>Temsilci</th>
                <th className="r">Bekleme</th>
                <th className="r">Konuşma</th>
                <th>Sonuç</th>
                <th>Kayıt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={`${c.callid}-${c.queue}`}>
                  <td className="mono small">{c.started.slice(5, 16).replace("-", ".").replace(" ", " · ")}</td>
                  <td className="mono">{c.caller || <span className="muted">gizli</span>}</td>
                  <td>{c.queue}</td>
                  <td>{c.agent ?? <span className="muted">–</span>}</td>
                  <td className="r">{mmss(c.wait_s)}</td>
                  <td className="r">{c.outcome === "answered" ? mmss(c.talk_s) : "–"}</td>
                  <td>
                    <span className={`badge ${OUTCOME[c.outcome][1] ? "ok" : "off"}`}>{OUTCOME[c.outcome][0]}</span>
                  </td>
                  <td>
                    {c.recording ? (
                      playing === c.callid ? (
                        <audio controls autoPlay src={api.recordingUrl(t.prefix, c.callid)} />
                      ) : (
                        <button className="ghost" onClick={() => setPlaying(c.callid)}>
                          Dinle
                        </button>
                      )
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length >= 500 && <p className="muted small">İlk 500 görüşme gösteriliyor; aralığı daraltın.</p>}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

export function Reports({ t }: { t: Tenant }) {
  const [from, to, setRange] = useRange();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setS(null);
    api.summary(t.prefix, from, to).then(setS).catch((e) => setError(String(e.message ?? e)));
  }, [t.prefix, from, to]);
  const missed = s ? s.totals.abandoned + s.totals.timeout + s.totals.noAgent : 0;
  return (
    <>
      <div className="card">
        <h3>Raporlar</h3>
        <RangePicker from={from} to={to} onChange={setRange} />
        {error && <p className="error">{error}</p>}
        {!s ? (
          <p className="muted">Yükleniyor…</p>
        ) : (
          <div className="tiles">
            <Tile label="Gelen çağrı" value={num(s.totals.offered)} note="kuyruğa giren" />
            <Tile label="Cevaplanan" value={num(s.totals.answered)} note={pct(s.totals.answerRate)} />
            <Tile
              label="Kaçan"
              value={num(missed)}
              note={`${s.totals.abandoned} kapattı · ${s.totals.timeout} süre doldu · ${s.totals.noAgent} temsilci yok`}
            />
            <Tile label="Hizmet seviyesi" value={pct(s.totals.serviceLevel)} note={`${s.slaSeconds} sn içinde cevaplanan`} />
            <Tile label="Ortalama bekleme" value={mmss(s.totals.avgWaitS)} note={`en uzun ${mmss(s.totals.maxWaitS)}`} />
            <Tile label="Ortalama konuşma" value={mmss(s.totals.avgTalkS)} note={`toplam ${mmss(s.totals.totalTalkS)}`} />
            <Tile label="Mesai dışı arama" value={num(s.totals.closedHours)} note="kapalı anonsu çalınan" />
          </div>
        )}
      </div>
      {s && s.totals.offered > 0 && (
        <>
          <div className="card">
            <h3>Kuyruklara göre</h3>
            <div className="scroll">
              <table className="numeric">
                <thead>
                  <tr>
                    <th>Kuyruk</th>
                    <th className="r">Gelen</th>
                    <th className="r">Cevaplanan</th>
                    <th className="r">Kaçan</th>
                    <th className="r">Cevaplanma</th>
                    <th className="r">Ort. bekleme</th>
                    <th className="r">Ort. konuşma</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byQueue.map((q) => (
                    <tr key={q.queue}>
                      <td>{q.queue}</td>
                      <td className="r">{num(q.offered)}</td>
                      <td className="r">{num(q.answered)}</td>
                      <td className="r">{num(q.abandoned + q.timeout + q.noAgent)}</td>
                      <td className="r">{pct(q.answerRate)}</td>
                      <td className="r">{mmss(q.avgWaitS)}</td>
                      <td className="r">{mmss(q.avgTalkS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h3>Temsilcilere göre</h3>
            <div className="scroll">
              <table className="numeric">
                <thead>
                  <tr>
                    <th>Temsilci</th>
                    <th className="r">Cevapladığı</th>
                    <th className="r">Toplam konuşma</th>
                    <th className="r">Ort. konuşma</th>
                    <th className="r">Cevapsız çalma</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byAgent.map((a) => (
                    <tr key={a.agent}>
                      <td>{a.agent}</td>
                      <td className="r">{num(a.answered)}</td>
                      <td className="r">{mmss(a.totalTalkS)}</td>
                      <td className="r">{mmss(a.avgTalkS)}</td>
                      <td className="r">{num(a.missedRings)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {s.byDay.length > 1 && (
            <div className="card">
              <h3>Günlere göre</h3>
              <div className="scroll">
                <table className="numeric">
                  <thead>
                    <tr>
                      <th>Gün</th>
                      <th className="r">Gelen</th>
                      <th className="r">Cevaplanan</th>
                      <th className="r">Kaçan</th>
                      <th className="r">Hizmet seviyesi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byDay.map((d) => (
                      <tr key={d.day}>
                        <td className="mono">{d.day}</td>
                        <td className="r">{num(d.offered)}</td>
                        <td className="r">{num(d.answered)}</td>
                        <td className="r">{num(d.abandoned + d.timeout + d.noAgent)}</td>
                        <td className="r">{pct(d.serviceLevel)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
