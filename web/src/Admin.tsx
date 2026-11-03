// Santralio: personel, işlem günlüğü ve sistem durumu ekranları.

import { useEffect, useState } from "react";
import { api, type AuditRow, type StaffRow, type SystemStatus, type Tenant } from "./api";
import { RangePicker } from "./Reports";

const ROLE_LABEL: Record<string, string> = { tenant_admin: "Yönetici", agent: "Temsilci", reseller_admin: "Bayi yöneticisi", platform_admin: "Platform" };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(today()) - n * 86_400_000).toISOString().slice(0, 10);

// Bir kez gösterilen geçici şifre.
function Secret({ title, email, password, onClose }: { title: string; email: string; password: string; onClose: () => void }) {
  return (
    <div className="notice">
      <strong>{title} — şifre yalnızca şimdi gösteriliyor, kişiye güvenli bir yoldan iletin.</strong>
      <dl>
        <dt>Giriş</dt>
        <dd className="mono">https://panel.santralio.site</dd>
        <dt>E-posta</dt>
        <dd className="mono">{email}</dd>
        <dt>Geçici şifre</dt>
        <dd className="mono">{password}</dd>
      </dl>
      <button className="ghost" onClick={onClose}>
        İlettim, gizle
      </button>
    </div>
  );
}

export function Staff({ t, reload }: { t: Tenant; reload: () => void }) {
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<{ title: string; email: string; password: string } | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "agent", extension: "" });
  const [busy, setBusy] = useState(false);
  const load = () => api.users(t.prefix).then(setRows).catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [t.prefix]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      reload();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const free = t.extensions.map((e) => e.number).filter((n) => !rows?.some((r) => r.extension === n && !r.disabled));

  return (
    <div className="card">
      <h3>Personel</h3>
      {error && <p className="error">{error}</p>}
      {shown && <Secret {...shown} onClose={() => setShown(null)} />}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>E-posta</th>
                <th>Ad</th>
                <th>Rol</th>
                <th>Dahili</th>
                <th>Son giriş</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.email} className={u.disabled ? "muted" : ""}>
                  <td className="mono small">{u.email}</td>
                  <td>{u.name}</td>
                  <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td className="mono">{u.extension ?? "–"}</td>
                  <td className="small">{u.last_seen ? new Date(u.last_seen).toLocaleString("tr-TR") : "–"}</td>
                  <td className="row">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const r = await api.resetPassword(t.prefix, u.email);
                          setShown({ title: "Şifre sıfırlandı", email: u.email, password: r.temporaryPassword });
                        })
                      }
                    >
                      Şifre sıfırla
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => act(() => api.setUserDisabled(t.prefix, u.email, !u.disabled))}>
                      {u.disabled ? "Aç" : "Kapat"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>Yeni personel</h4>
      <div className="row">
        <input placeholder="E-posta" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="Ad Soyad" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="agent">Temsilci</option>
          <option value="tenant_admin">Yönetici</option>
        </select>
        {form.role === "agent" && (
          <input
            placeholder="Dahili (ör. 1003)"
            list="free-ext"
            value={form.extension}
            onChange={(e) => setForm({ ...form, extension: e.target.value.replace(/\D/g, "") })}
            maxLength={6}
          />
        )}
        <datalist id="free-ext">
          {free.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          disabled={busy || !form.email || (form.role === "agent" && form.extension.length < 2)}
          onClick={() =>
            act(async () => {
              const r = await api.addUser(t.prefix, { ...form, extension: form.role === "agent" ? form.extension : null });
              setShown({ title: r.extensionCreated ? `Personel ve ${form.extension} dahilisi açıldı` : "Personel açıldı", email: r.email, password: r.temporaryPassword });
              setForm({ email: "", name: "", role: "agent", extension: "" });
            })
          }
        >
          Ekle
        </button>
      </div>
      <p className="muted small">
        Temsilci, panele girip “Mesaiye başla” ile tarayıcıdan arama alır. Dahili yoksa otomatik açılır (lisanstaki dahili sınırı içinde). Kuyruklara
        atamak için “Kuyruklar” sekmesi.
      </p>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "user.login": "Giriş",
  "user.logout": "Çıkış",
  "user.add": "Personel eklendi",
  "user.disable": "Hesap kapatıldı",
  "user.enable": "Hesap açıldı",
  "user.password_reset": "Şifre sıfırlandı",
  "user.password": "Şifre değişti",
  "recording.listen": "Kayıt dinlendi",
  "recording.settings": "Kayıt ayarı",
  "recordings.purge": "Eski kayıtlar silindi",
  "agent.pause": "Molaya çıktı",
  "agent.unpause": "Müsait oldu",
  "agent.sip_credentials": "Temsilci masasına bağlandı",
  "menu.set": "Menü değişti",
  "menu.option": "Menü tuşu",
  "menu.options_replace": "Menü tuşları",
  "schedule.set": "Çalışma saati",
  "schedule.hours_replace": "Çalışma saatleri",
  "schedule.holiday": "Tatil eklendi",
  "queue.members": "Kuyruk temsilcileri",
  "queue.number": "Kuyruk numarası",
  "queue.unavailable_text": "Kuyruk anonsu",
  "entry.flow": "Numara yönlendirmesi",
  "ext.add": "Dahili eklendi",
  "ext.secret_view": "SIP bilgisi görüntülendi",
  "trunk.set": "Operatör hattı",
  "license.set_manual": "Lisans",
  "tenant.create": "Müşteri açıldı",
};

const FILTERS: [string, string][] = [
  ["", "Tümü"],
  ["user.", "Hesap işlemleri"],
  ["recording", "Kayıt"],
  ["agent.", "Temsilci"],
  ["menu.", "Menü"],
  ["schedule.", "Çalışma saati"],
  ["queue.", "Kuyruk"],
];

function detailText(d: Record<string, unknown>) {
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export function Audit({ prefix }: { prefix: string | null }) {
  const [range, setRange] = useState<[string, string]>([daysAgo(6), today()]);
  const [action, setAction] = useState("");
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(null);
    api.audit(prefix, range[0], range[1], action).then(setRows).catch((e) => setError(msg(e)));
  }, [prefix, range, action]);
  return (
    <div className="card">
      <h3>İşlem günlüğü</h3>
      <RangePicker from={range[0]} to={range[1]} onChange={(f, e) => setRange([f, e])} />
      <div className="row filters">
        {FILTERS.map(([v, l]) => (
          <button key={v} className={action === v ? "" : "ghost"} onClick={() => setAction(v)}>
            {l}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Bu aralıkta kayıt yok.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Kim</th>
                {!prefix && <th>Müşteri</th>}
                <th>İşlem</th>
                <th>Ayrıntı</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.at}</td>
                  <td className="small">{r.actor.replace(/^api:/, "")}</td>
                  {!prefix && <td className="mono">{r.tenant ?? "–"}</td>}
                  <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="small muted">{detailText(r.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function bytes(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function SystemPage() {
  const [s, setS] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.system().then(setS).catch((e) => setError(msg(e)));
  }, []);
  return (
    <>
      <div className="title">
        <h2>Sistem</h2>
      </div>
      {error && <p className="error">{error}</p>}
      {s && (
        <div className="grid">
          <div className="card">
            <h3>Santral</h3>
            <dl>
              <dt>Çalışma süresi</dt>
              <dd>{Math.floor(s.asterisk.uptimeS / 3600)} sa {Math.floor((s.asterisk.uptimeS % 3600) / 60)} dk</dd>
              <dt>Süren arama</dt>
              <dd>{s.asterisk.activeCalls}</dd>
              <dt>Müşteri / aktif kullanıcı</dt>
              <dd>
                {s.tenants} / {s.users}
              </dd>
              <dt>Disk (boş)</dt>
              <dd>
                {bytes(s.disk.freeBytes)} / {bytes(s.disk.totalBytes)}
              </dd>
            </dl>
          </div>
          <div className="card">
            <h3>Operatör hatları</h3>
            <ul className="list">
              {s.asterisk.registrations.map((r) => (
                <li key={r.name}>
                  <span className="mono">{r.name.replace(/_trunk_reg$/, "")}</span>{" "}
                  <span className={`badge ${r.status === "Registered" ? "ok" : "off"}`}>{r.status}</span>
                </li>
              ))}
              {s.asterisk.registrations.length === 0 && <li className="muted">Hat yok.</li>}
            </ul>
          </div>
          <div className="card wide">
            <h3>Son santral uyarıları</h3>
            {s.recentProblems.length === 0 ? (
              <p className="muted">Uyarı yok.</p>
            ) : (
              <pre className="log">{s.recentProblems.join("\n")}</pre>
            )}
          </div>
        </div>
      )}
      <Audit prefix={null} />
    </>
  );
}
