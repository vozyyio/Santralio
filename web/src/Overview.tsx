// Özet ekranı: firmanın bugünkü çağrı tablosu, son 7 gün, hat ve dahili durumu, arama akışı, lisans.
// Yalnızca gerçek verileri gösterir; kullanıcının yetkisi olmayan kartlar hiç yüklenmez.
// Canlı kuyruk (şu an bekleyen/konuşan çağrılar) için arka uç henüz yok; o kart "yakında" olarak durur.

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./Icons";
import { mmss, queueLabel } from "./Reports";
import { api, type Me, type Status, type Summary, type Tenant } from "./api";

const TZ = "Europe/Istanbul";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString("tr-TR");
const pct = (x: number | null) => (x === null ? "–" : `%${Math.round(x * 100)}`);
const can = (me: Me, ...p: string[]) => p.some((x) => me.permissions.includes(x));
const dayName = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("tr-TR", { weekday: "short", timeZone: "UTC" });
const longDate = () => new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

function dur(s: number) {
  if (!s) return "0 sn";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} dk ${r ? `${r} sn` : ""}`.trim() : `${r} sn`;
}

const REG: Record<string, [string, "ok" | "warn" | "bad" | "idle"]> = {
  Registered: ["Bağlı", "ok"],
  Retrying: ["Bağlanıyor", "warn"],
  Unregistered: ["Bağlı değil", "bad"],
  Rejected: ["Reddedildi", "bad"],
  Stopped: ["Durduruldu", "bad"],
  none: ["Hat tanımlı değil", "idle"],
  unknown: ["Bilinmiyor", "warn"],
};

const OPERATORS: Record<string, string> = { netgsm: "Netgsm", verimor: "Verimor", turktelekom: "Türk Telekom", turkcell: "Turkcell", vodafone: "Vodafone" };
const operatorName = (o: string) => OPERATORS[o.toLowerCase()] ?? o.charAt(0).toLocaleUpperCase("tr-TR") + o.slice(1);

function flowLabel(t: Tenant, target: string | null): string {
  if (!target) return "Kapat";
  const [kind, name] = target.split(":");
  if (kind === "ai") return `Yapay zekâ karşılaması: ${name}`;
  if (kind === "ext") {
    const e = t.extensions.find((x) => x.number === name);
    return `Dahili ${name}${e?.display_name ? ` · ${e.display_name}` : ""}`;
  }
  return `${{ queue: "Kuyruk", menu: "Menü", schedule: "Çalışma saatine göre" }[kind] ?? kind}: ${name}`;
}

function Kpi({ icon, label, value, note, tone }: { icon: IconName; label: string; value: string; note?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className={`ov-kpi ${tone ? `ov-${tone}` : ""}`}>
      <span className="ov-kpi-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="ov-kpi-label">{label}</span>
      <span className="ov-kpi-value">{value}</span>
      {note && <span className="ov-kpi-note">{note}</span>}
    </div>
  );
}

function Card({ title, icon, children, action }: { title: string; icon: IconName; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="ov-card">
      <header className="ov-card-head">
        <h2>
          <Icon name={icon} size={18} />
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Overview({ me, prefix }: { me: Me; prefix: string }) {
  const showReports = can(me, "reports.view");
  const showSettings = can(me, "settings.manage");
  const showTenant = can(me, "settings.manage", "staff.manage");

  const [t, setT] = useState<Tenant | null>(null);
  const [status, setStatus] = useState<Status | null | "error">(null);
  const [day, setDay] = useState<Summary | null | "error">(null);
  const [week, setWeek] = useState<Summary | null | "error">(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    const d = today();
    if (showSettings) api.status(prefix).then(setStatus).catch(() => setStatus("error"));
    if (showReports) {
      api.summary(prefix, d, d).then(setDay).catch(() => setDay("error"));
      api.summary(prefix, shift(d, -6), d).then(setWeek).catch(() => setWeek("error"));
    }
    setUpdated(new Date());
  }, [prefix, showReports, showSettings]);

  useEffect(() => {
    if (showTenant) api.tenant(prefix).then(setT).catch(() => setT(null));
  }, [prefix, showTenant]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const tot = day && day !== "error" ? day.totals : null;
  const missed = tot ? tot.abandoned + tot.timeout + tot.noAgent : 0;

  // Son 7 gün: eksik günler 0 ile doldurulur.
  const days: { day: string; offered: number; answered: number }[] = [];
  if (week && week !== "error") {
    const d0 = today();
    for (let i = 6; i >= 0; i--) {
      const d = shift(d0, -i);
      const row = week.byDay.find((x) => x.day.slice(0, 10) === d);
      days.push({ day: d, offered: row?.offered ?? 0, answered: row?.answered ?? 0 });
    }
  }
  const peak = Math.max(1, ...days.map((d) => d.offered));

  const reg = status && status !== "error" ? (REG[status.registration] ?? REG.unknown) : null;
  const online = status && status !== "error" ? new Set(status.onlineExtensions) : null;
  const exts = t?.extensions.filter((e) => e.enabled) ?? [];

  return (
    <div className="ov">
      <div className="ov-intro">
        <p className="ov-date">{longDate()}</p>
        {updated && (
          <p className="ov-updated">
            Son güncelleme {updated.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} · her dakika yenilenir
          </p>
        )}
      </div>

      {showReports && (
        <div className="ov-kpis">
          {day === "error" ? (
            <p className="error">Bugünün istatistikleri yüklenemedi.</p>
          ) : !tot ? (
            <p className="muted">Yükleniyor…</p>
          ) : (
            <>
              <Kpi icon="phone" label="Bugünkü çağrı" value={num(tot.offered)} note={tot.closedHours ? `${num(tot.closedHours)} mesai dışı` : undefined} />
              <Kpi icon="check" label="Cevaplanan" value={num(tot.answered)} note={`Cevaplama ${pct(tot.answerRate)}`} tone="ok" />
              <Kpi icon="callback" label="Kaçan" value={num(missed)} note={missed ? "Geri arama listesine bakın" : "Kaçan çağrı yok"} tone={missed ? "bad" : undefined} />
              <Kpi icon="clock" label="Ort. bekleme" value={dur(tot.avgWaitS)} note={`En uzun ${dur(tot.maxWaitS)}`} />
              <Kpi icon="headset" label="Ort. konuşma" value={dur(tot.avgTalkS)} note={`Toplam ${dur(tot.totalTalkS)}`} />
            </>
          )}
        </div>
      )}

      <div className="ov-grid">
        {showReports && (
          <Card title="Son 7 gün" icon="chart">
            {week === "error" ? (
              <p className="error">Yüklenemedi.</p>
            ) : !days.length ? (
              <p className="muted">Yükleniyor…</p>
            ) : (
              <>
                <div className="ov-bars" role="img" aria-label={`Son 7 günde ${num(days.reduce((a, d) => a + d.offered, 0))} çağrı`}>
                  {days.map((d) => (
                    <div key={d.day} className="ov-bar-col" title={`${d.day}: ${d.offered} çağrı, ${d.answered} cevaplandı`}>
                      <span className="ov-bar-num">{d.offered || ""}</span>
                      <div className="ov-bar-track">
                        <div className="ov-bar ov-bar-all" style={{ height: `${(d.offered / peak) * 100}%` }} />
                        <div className="ov-bar ov-bar-ans" style={{ height: `${(d.answered / peak) * 100}%` }} />
                      </div>
                      <span className="ov-bar-day">{dayName(d.day)}</span>
                    </div>
                  ))}
                </div>
                <p className="ov-legend">
                  <span className="ov-dot ov-dot-all" /> Gelen <span className="ov-dot ov-dot-ans" /> Cevaplanan
                </p>
              </>
            )}
          </Card>
        )}

        {showSettings && (
          <Card title="Hat ve dahililer" icon="phone">
            {status === "error" ? (
              <p className="error">Santral durumu alınamadı.</p>
            ) : !reg || !t ? (
              <p className="muted">Yükleniyor…</p>
            ) : (
              <>
                <div className="ov-trunk">
                  <span className={`ov-pill ov-${reg[1]}`}>
                    <span className="ov-pill-dot" />
                    {reg[0]}
                  </span>
                  <span className="muted">{t.trunk ? `Operatör hattı · ${operatorName(t.trunk.operator)}` : "Operatör hattı"}</span>
                </div>
                <p className="ov-ext-sum">
                  <strong>{online ? exts.filter((e) => online.has(e.number)).length : 0}</strong> / {exts.length} dahili çevrimiçi
                </p>
                <ul className="ov-exts">
                  {exts.map((e) => {
                    const on = online?.has(e.number);
                    return (
                      <li key={e.number} className={on ? "on" : ""}>
                        <span className="ov-ext-dot" aria-hidden="true" />
                        <span className="ov-ext-no">{e.number}</span>
                        <span className="ov-ext-name">{e.display_name || "—"}</span>
                        <span className="ov-ext-state">{on ? "Çevrimiçi" : "Çevrimdışı"}</span>
                      </li>
                    );
                  })}
                  {exts.length === 0 && <li className="muted">Henüz dahili yok.</li>}
                </ul>
                <a className="ov-link" href={`#/t/${prefix}/dahililer`}>
                  Dahilileri yönet <Icon name="arrow" size={14} />
                </a>
              </>
            )}
          </Card>
        )}

        {showSettings && t && (
          <Card title="Arama akışı" icon="route">
            {t.entryPoints.length === 0 ? (
              <p className="muted">Henüz numara bağlanmamış.</p>
            ) : (
              <ul className="ov-flows">
                {t.entryPoints.map((e) => (
                  <li key={e.channel + e.address} className={e.enabled ? "" : "off"}>
                    <span className="ov-flow-from">
                      <Icon name="phone" size={16} />
                      {e.address}
                    </span>
                    <Icon name="arrow" size={16} className="ov-flow-arrow" />
                    <span className="ov-flow-to">{flowLabel(t, e.flow)}</span>
                    {!e.enabled && <span className="ov-pill ov-idle">Kapalı</span>}
                  </li>
                ))}
              </ul>
            )}
            <a className="ov-link" href={`#/t/${prefix}/genel`}>
              Akışı düzenle <Icon name="arrow" size={14} />
            </a>
          </Card>
        )}

        {showReports && day && day !== "error" && day.byQueue.length > 0 && (
          <Card title="Bugün kuyruklar" icon="queue">
            <div className="scroll">
              <table className="ov-table">
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
                      <td>{queueLabel(q.queue)}</td>
                      <td className="r">{num(q.offered)}</td>
                      <td className="r">{num(q.answered)}</td>
                      <td className="r">{pct(q.answerRate)}</td>
                      <td className="r">{mmss(Math.round(q.avgWaitS))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {showTenant && t && (
          <Card title="Lisans" icon="license">
            {!t.license ? (
              <p className="muted">Lisans bulunamadı. Hizmet açılmadan önce lisans gerekir.</p>
            ) : (
              <>
                <span className={`ov-pill ${t.license.active ? "ov-ok" : "ov-bad"}`}>
                  <span className="ov-pill-dot" />
                  {t.license.active ? "Etkin" : "Pasif"}
                </span>
                <dl className="ov-dl">
                  <dt>Bitiş</dt>
                  <dd>{t.license.valid_until ? new Date(t.license.valid_until).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" }) : "Süresiz"}</dd>
                  <dt>Dahili</dt>
                  <dd>
                    <Usage used={t.extensions.length} max={t.license.max_extensions} />
                  </dd>
                  <dt>Eş zamanlı çağrı</dt>
                  <dd>{t.license.max_channels}</dd>
                </dl>
              </>
            )}
          </Card>
        )}

        <Card title="Canlı kuyruk" icon="users" action={<span className="ov-pill ov-soon">Yakında</span>}>
          <p className="muted">Şu an bekleyen ve görüşmedeki çağrılar ile temsilcilerin anlık durumu burada görünecek.</p>
        </Card>
      </div>
    </div>
  );
}

function Usage({ used, max }: { used: number; max: number }) {
  const ratio = max ? Math.min(1, used / max) : 0;
  return (
    <span className="ov-usage">
      <span className="ov-usage-text">
        {used} / {max}
      </span>
      <span className="ov-usage-track" aria-hidden="true">
        <span className={`ov-usage-fill ${ratio >= 1 ? "full" : ""}`} style={{ width: `${ratio * 100}%` }} />
      </span>
    </span>
  );
}
