// Operasyon konsolu (Özet): gönderilen tasarıma göre. Yalnızca gerçek veri:
// bugünkü göstergeler ve çağrılar (raporlardan), dahili durumu (santralden), arama akışı ve lisans (ayarlardan).
// Anlık kuyruk/çağrı durumu için arka uç henüz yok; ilgili alanlar bunu açıkça söyler.

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./Icons";
import type { TenantInfo } from "./App";
import { operatorName, regLabel } from "./labels";
import { mmss, queueLabel } from "./Reports";
import { api, type CallRow, type Me, type Outcome, type Summary, type Tenant } from "./api";

const TZ = "Europe/Istanbul";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString("tr-TR");
const pct = (x: number | null) => (x === null ? "–" : `%${Math.round(x * 100)}`);
const can = (me: Me, ...p: string[]) => p.some((x) => me.permissions.includes(x));
const dayName = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("tr-TR", { weekday: "short", timeZone: "UTC" });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

function dur(s: number) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}sa ${String(m % 60).padStart(2, "0")}dk`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const OUTCOME: Record<Outcome, [string, "ok" | "warn" | "bad" | "info"]> = {
  answered: ["Cevaplandı", "ok"],
  open: ["Sürüyor", "info"],
  abandoned: ["Arayan kapattı", "bad"],
  timeout: ["Süre doldu", "warn"],
  no_agent: ["Temsilci yok", "warn"],
};

function flowSteps(t: Tenant, target: string | null): { kind: string; label: string }[] {
  if (!target) return [{ kind: "end", label: "Kapat" }];
  const [kind, name] = target.split(":");
  if (kind === "schedule") {
    const sc = t.schedules.find((x) => x.name === name);
    return [{ kind, label: `Çalışma saati · ${name}` }, ...(sc ? flowSteps(t, sc.open_target) : [])];
  }
  if (kind === "menu") {
    const mn = t.menus.find((x) => x.name === name);
    return [{ kind, label: `Menü · ${name}` }, ...(mn?.default_target && !mn.default_target.startsWith("menu:") ? flowSteps(t, mn.default_target) : [])];
  }
  if (kind === "ai") return [{ kind, label: `Yapay zekâ · ${name}` }];
  if (kind === "queue") return [{ kind, label: `Kuyruk · ${name}` }];
  if (kind === "ext") {
    const e = t.extensions.find((x) => x.number === name);
    return [{ kind, label: `Dahili ${name}${e?.display_name ? ` · ${e.display_name}` : ""}` }];
  }
  return [{ kind, label: target }];
}
const STEP_ICON: Record<string, IconName> = { schedule: "clock", menu: "menu", ai: "sparkles", queue: "queue", ext: "phone", end: "close" };

function Kpi({ label, value, note, icon, tone, noteTone }: { label: string; value: string; note: string; icon: IconName; tone: string; noteTone?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <span>{label}</span>
        <Icon name={icon} size={18} className={`c-${tone}`} />
      </div>
      <div className={`kpi-value c-${tone === "white" ? "white" : tone}`}>{value}</div>
      <div className={`kpi-note ${noteTone ? `c-${noteTone}` : ""}`}>{note}</div>
    </div>
  );
}

function Panel({ title, icon, dot, meta, children, className }: { title: string; icon?: IconName; dot?: boolean; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`pnl ${className ?? ""}`}>
      <header className="pnl-head">
        <h2>
          {dot && <span className="pnl-dot" />}
          {icon && <Icon name={icon} size={18} />}
          {title}
        </h2>
        {meta && <div className="pnl-meta">{meta}</div>}
      </header>
      {children}
    </section>
  );
}

export function Overview({ me, prefix, info }: { me: Me; prefix: string; info: TenantInfo }) {
  const { t, status } = info;
  const showReports = can(me, "reports.view");
  const showCalls = can(me, "calls.all");
  const showSettings = can(me, "settings.manage");

  const [day, setDay] = useState<Summary | null | "error">(null);
  const [week, setWeek] = useState<Summary | null | "error">(null);
  const [calls, setCalls] = useState<CallRow[] | null | "error">(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    const d = today();
    if (showReports) {
      api.summary(prefix, d, d).then(setDay).catch(() => setDay("error"));
      api.summary(prefix, shift(d, -6), d).then(setWeek).catch(() => setWeek("error"));
    }
    if (showCalls) api.calls(prefix, d, d).then(setCalls).catch(() => setCalls("error"));
    setUpdated(new Date());
  }, [prefix, showReports, showCalls]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const tot = day && day !== "error" ? day.totals : null;
  const missed = tot ? tot.abandoned + tot.timeout + tot.noAgent : 0;
  const online = status ? new Set(status.onlineExtensions) : null;
  const exts = t?.extensions.filter((e) => e.enabled) ?? [];
  const onlineCount = online ? exts.filter((e) => online.has(e.number)).length : null;
  const reg = status ? regLabel(status.registration) : null;

  const lic = t?.license;
  const daysLeft = lic?.valid_until ? Math.ceil((Date.parse(lic.valid_until) - Date.now()) / 86_400_000) : null;

  // Üstteki bilgi şeridi: yalnızca dikkat gerektiren bir durum varsa.
  const banner =
    reg && reg[1] === "bad"
      ? { tone: "bad", title: "Operatör hattı bağlı değil", text: "Dışarıdan gelen aramalar santrale ulaşmıyor. Operatör bilgilerini ve hesabınızı kontrol edin." }
      : lic && !lic.active
        ? { tone: "bad", title: "Lisans pasif", text: "Santral yapılandırması üretilmiyor. Lisansınızı Vozyy üzerinden yenileyin." }
        : daysLeft !== null && daysLeft <= 30
          ? { tone: "warn", title: `Lisansın bitmesine ${daysLeft} gün kaldı`, text: "Kesinti yaşamamak için lisansınızı Vozyy üzerinden yenileyin." }
          : null;

  const days: { day: string; offered: number; answered: number }[] = [];
  if (week && week !== "error") {
    for (let i = 6; i >= 0; i--) {
      const d = shift(today(), -i);
      const row = week.byDay.find((x) => x.day.slice(0, 10) === d);
      days.push({ day: d, offered: row?.offered ?? 0, answered: row?.answered ?? 0 });
    }
  }
  const peak = Math.max(1, ...days.map((d) => d.offered));
  const memberOf = (n: string) => t?.queues.filter((q) => q.members.includes(n)).map((q) => q.name) ?? [];
  const recent = calls && calls !== "error" ? [...calls].sort((a, b) => b.started.localeCompare(a.started)).slice(0, 8) : [];

  return (
    <div className="ov">
      {banner && (
        <div className={`ov-banner t-${banner.tone}`} role="status">
          <span className="ov-banner-icon">
            <Icon name="shield" size={18} />
          </span>
          <div>
            <strong>{banner.title}</strong>
            <p>{banner.text}</p>
          </div>
          {lic?.valid_until && <span className="ov-banner-tag">Lisans bitiş: {new Date(lic.valid_until).toLocaleDateString("tr-TR")}</span>}
        </div>
      )}

      {(showReports || showSettings) && (
        <div className="kpis">
          {showReports && (tot ? (
            <>
              <Kpi label="Bugünkü çağrı" value={num(tot.offered)} note={tot.offered ? `${pct(tot.answerRate)} cevaplama oranı` : "Henüz çağrı yok"} noteTone={tot.offered ? "ok" : undefined} icon="phone" tone="white" />
              <Kpi label="Cevaplanan" value={num(tot.answered)} note={tot.answered ? `Ort. bekleme ${dur(tot.avgWaitS)}` : "—"} icon="check" tone={tot.answered ? "ok" : "white"} />
              <Kpi label="Kaçan çağrı" value={num(missed)} note={tot.closedHours ? `Mesai dışı: ${num(tot.closedHours)} çağrı` : "Mesai dışı çağrı yok"} icon="callback" tone={missed ? "bad" : "white"} />
            </>
          ) : day === "error" ? (
            <p className="error">İstatistikler yüklenemedi.</p>
          ) : (
            <p className="muted">Yükleniyor…</p>
          ))}
          {showSettings && (
            <Kpi
              label="Çevrimiçi dahili"
              value={onlineCount === null ? "–" : `${onlineCount} / ${exts.length}`}
              note={onlineCount === null ? "Santral durumu bekleniyor" : `${exts.length - onlineCount} dahili çevrimdışı`}
              icon="users"
              tone={onlineCount ? "cyan" : "white"}
            />
          )}
          {showReports && tot && (
            <>
              <Kpi label="En uzun bekleme" value={dur(tot.maxWaitS)} note={tot.offered ? `Ortalama ${dur(tot.avgWaitS)}` : "—"} icon="clock" tone={tot.maxWaitS ? "warn" : "white"} />
              <Kpi label="Ort. konuşma" value={dur(tot.avgTalkS)} note={tot.answered ? `Toplam ${dur(tot.totalTalkS)}` : "—"} icon="headset" tone={tot.avgTalkS ? "violet" : "white"} />
            </>
          )}
        </div>
      )}

      <div className="ov-cols">
        <div className="ov-col">
          {showCalls && (
          <Panel
           
            title="Bugünün çağrıları"
            dot
            meta={
              <>
                {t?.trunk && <span className="mono">Operatör: {operatorName(t.trunk.operator)}</span>}
                <button type="button" className="icon-btn" aria-label="Yenile" title="Yenile" onClick={refresh}>
                  <Icon name="history" size={16} />
                </button>
              </>
            }
          >
            {calls === "error" ? (
              <p className="error">Çağrılar yüklenemedi.</p>
            ) : !calls ? (
              <p className="muted">Yükleniyor…</p>
            ) : recent.length === 0 ? (
              <div className="empty">
                <Icon name="phone" size={22} />
                <span>Bugün henüz çağrı yok.</span>
              </div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl stack">
                  <thead>
                    <tr>
                      <th>Arayan numara</th>
                      <th>Hedef / kuyruk</th>
                      <th>Durum</th>
                      <th>Süre</th>
                      <th>Temsilci</th>
                      <th className="r">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((c) => (
                      <tr key={c.callid}>
                        <td>
                          <span className="tbl-num">
                            <Icon name="phone" size={15} className="c-cyan" />
                            {c.caller || "Gizli numara"}
                          </span>
                          <span className="tbl-sub">{hhmm(c.started)}</span>
                        </td>
                        <td>
                          <span className="tag">{queueLabel(c.queue)}</span>
                        </td>
                        <td>
                          <span className={`pill t-${OUTCOME[c.outcome][1]}`}>
                            <span className="lay-dot" />
                            {OUTCOME[c.outcome][0]}
                          </span>
                        </td>
                        <td className="mono">{c.outcome === "answered" || c.outcome === "open" ? mmss(c.talk_s) : mmss(c.wait_s)}</td>
                        <td>{c.agent ?? <span className="muted">—</span>}</td>
                        <td className="r">
                          {c.recording ? (
                            <button type="button" className="btn-sm" onClick={() => setPlaying(playing === c.callid ? null : c.callid)}>
                              {playing === c.callid ? "Kapat" : "Dinle"}
                            </button>
                          ) : (
                            <span className="muted mono small">Kayıt yok</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {playing && <audio className="ov-audio" controls autoPlay src={api.recordingUrl(prefix, playing)} />}
            <footer className="pnl-foot">
              <span>
                <Icon name="shield" size={14} className="c-ok" /> Anlık kuyruk görünümü yakında
              </span>
              <a href={`${me.origins.crm}/#/t/${prefix}/gorusmeler`} className="mono">
                Tüm görüşmeler →
              </a>
            </footer>
          </Panel>
        )}
          {showSettings && t && (
          <Panel title="Arama akışı" icon="route" meta={<span className="mono">{t.entryPoints.length} numara</span>}>
            {t.entryPoints.length === 0 ? (
              <p className="muted">Henüz numara bağlanmamış.</p>
            ) : (
              <ul className="flows">
                {t.entryPoints.map((e) => (
                  <li key={e.channel + e.address} className={e.enabled ? "" : "off"}>
                    <div className="flow-head">
                      <span className="tbl-num">
                        <Icon name="phone" size={15} className="c-cyan" />
                        {e.address}
                      </span>
                      <span className="mono small muted">{e.enabled ? (t.trunk ? operatorName(t.trunk.operator) : "") : "Kapalı"}</span>
                    </div>
                    <div className="flow-steps">
                      {flowSteps(t, e.flow).map((s, i) => (
                        <span key={i} className="flow-step">
                          {i > 0 && <Icon name="arrow" size={14} className="flow-arrow" />}
                          <span className={`tag tag-${s.kind}`}>
                            <Icon name={STEP_ICON[s.kind] ?? "route"} size={13} />
                            {s.label}
                          </span>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <a className="pnl-link" href={`#/t/${prefix}/genel`}>
              Akışı düzenle →
            </a>
          </Panel>
        )}
          {showReports && (
          <Panel title="Son 7 gün" icon="chart" meta={updated ? <span className="mono">Güncelleme {updated.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span> : null}>
            {week === "error" ? (
              <p className="error">Yüklenemedi.</p>
            ) : !days.length ? (
              <p className="muted">Yükleniyor…</p>
            ) : days.every((d) => d.offered === 0) ? (
              <div className="empty">
                <Icon name="chart" size={22} />
                <span>Son 7 günde çağrı yok. İlk çağrılar geldiğinde grafik burada görünecek.</span>
              </div>
            ) : (
              <>
                <div className="bars" role="img" aria-label={`Son 7 günde ${num(days.reduce((a, d) => a + d.offered, 0))} çağrı`}>
                  {days.map((d) => (
                    <div key={d.day} className="bar-col" title={`${d.day}: ${d.offered} çağrı, ${d.answered} cevaplandı`}>
                      <span className="bar-num mono">{d.offered || ""}</span>
                      <div className="bar-track">
                        <div className="bar bar-all" style={{ height: `${(d.offered / peak) * 100}%` }} />
                        <div className="bar bar-ans" style={{ height: `${(d.answered / peak) * 100}%` }} />
                      </div>
                      <span className="bar-day">{dayName(d.day)}</span>
                    </div>
                  ))}
                </div>
                <p className="legend">
                  <span className="sw sw-all" /> Gelen <span className="sw sw-ans" /> Cevaplanan
                </p>
              </>
            )}
          </Panel>
        )}
          {showReports && day && day !== "error" && day.byQueue.length > 0 && (
          <Panel title="Bugün kuyruklar" icon="queue">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Kuyruk</th>
                    <th className="r">Gelen</th>
                    <th className="r">Cevap</th>
                    <th className="r">Oran</th>
                    <th className="r">Ort. bekleme</th>
                  </tr>
                </thead>
                <tbody>
                  {day.byQueue.map((q) => (
                    <tr key={q.queue}>
                      <td>
                        <span className="tag">{queueLabel(q.queue)}</span>
                      </td>
                      <td className="r mono">{num(q.offered)}</td>
                      <td className="r mono">{num(q.answered)}</td>
                      <td className="r mono">{pct(q.answerRate)}</td>
                      <td className="r mono">{mmss(Math.round(q.avgWaitS))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        </div>
        <div className="ov-col ov-col-side">
          {showSettings && (
          <Panel title="Temsilci durumları" icon="users" meta={<span className="mono">{exts.length} kayıtlı dahili</span>}>
            {!t || !online ? (
              <p className="muted">Yükleniyor…</p>
            ) : (
              <ul className="agents">
                {exts.map((e) => {
                  const on = online.has(e.number);
                  const qs = memberOf(e.number);
                  return (
                    <li key={e.number} className={on ? "on" : ""}>
                      <span className="agent-no">
                        {e.number}
                        <span className="agent-dot" />
                      </span>
                      <span className="agent-main">
                        <strong>{e.display_name || `Dahili ${e.number}`}</strong>
                        <small>{on ? "Çevrimiçi" : "Çevrimdışı"}</small>
                        {qs.length > 0 && (
                          <span className="agent-queues">
                            {qs.map((q) => (
                              <span key={q} className="tag">
                                {q}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
                {exts.length === 0 && <li className="muted">Henüz dahili yok.</li>}
              </ul>
            )}
            <a className="btn-ghost-wide" href={`#/t/${prefix}/dahililer`}>
              <Icon name="phone" size={16} /> Yeni dahili hat tanımla
            </a>
          </Panel>
        )}
          {t && lic !== undefined && (
          <Panel title="Vozyy lisansı" icon="license" meta={lic ? <span className={`pill t-${lic.active ? "ok" : "bad"}`}><span className="lay-dot" />{lic.active ? "Etkin" : "Pasif"}</span> : null}>
            {!lic ? (
              <p className="muted">Lisans bulunamadı.</p>
            ) : (
              <div className="lic lic-v">
                <div className="lic-box">
                  <span className="lic-label">Dahili</span>
                  <span className="lic-value mono">
                    {t.extensions.length} / {lic.max_extensions}
                  </span>
                  <span className="usage">
                    <span className={`usage-fill ${t.extensions.length >= lic.max_extensions ? "full" : ""}`} style={{ width: `${Math.min(100, (t.extensions.length / Math.max(1, lic.max_extensions)) * 100)}%` }} />
                  </span>
                </div>
                <div className="lic-box">
                  <span className="lic-label">Eş zamanlı çağrı</span>
                  <span className="lic-value mono">{lic.max_channels} kanal</span>
                </div>
                <div className="lic-row">
                  <span>Bitiş tarihi</span>
                  <strong className="mono">{lic.valid_until ? new Date(lic.valid_until).toLocaleDateString("tr-TR") : "Süresiz"}</strong>
                </div>
              </div>
            )}
          </Panel>
        )}
        </div>
      </div>
    </div>
  );
}
