// Santralio: personel, işlem günlüğü ve sistem durumu ekranları.

import { useEffect, useState } from "react";
import { api, type AuditRow, type Me, type RoleRow, type StaffRow, type SystemStatus, type Tenant } from "./api";
import { RangePicker } from "./Reports";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(today()) - n * 86_400_000).toISOString().slice(0, 10);

// Bir kez gösterilen geçici şifre.
function Secret({ title, email, password, login, onClose }: { title: string; email: string; password: string; login: string; onClose: () => void }) {
  return (
    <div className="notice">
      <strong>{title} — şifre yalnızca şimdi gösteriliyor, kişiye güvenli bir yoldan iletin.</strong>
      <dl>
        <dt>Giriş</dt>
        <dd className="mono">{login}</dd>
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

export function Staff({ t, me, reload }: { t: Tenant; me: Me; reload: () => void }) {
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<{ title: string; email: string; password: string } | null>(null);
  const [form, setForm] = useState({ email: "", name: "", roleId: 0, extension: "" });
  const [busy, setBusy] = useState(false);
  const load = () =>
    Promise.all([api.users(t.prefix), api.roles(t.prefix)])
      .then(([u, r]) => {
        setRows(u);
        setRoles(r);
        setForm((f) => (f.roleId ? f : { ...f, roleId: r.find((x) => x.name === "Temsilci")?.id ?? r[0]?.id ?? 0 }));
      })
      .catch((e) => setError(msg(e)));
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
  // Atanabilir dahili: tanımlı, en az bir kuyrukta ve açık bir hesaba bağlı değil.
  const inQueue = new Set(t.queues.flatMap((q) => q.members));
  const freeFor = (email: string | null) =>
    t.extensions.filter((e) => e.enabled && inQueue.has(e.number) && !rows?.some((r) => r.extension === e.number && !r.disabled && r.email !== email));
  const notInQueue = t.extensions.filter((e) => e.enabled && !inQueue.has(e.number)).map((e) => e.number);
  const needsExt = (roleId: number) => roles.find((r) => r.id === roleId)?.permissions.includes("agent.desk") ?? false;
  const free = freeFor(null);

  return (
    <div className="card">
      <h3>Personel</h3>
      {error && <p className="error">{error}</p>}
      {shown && <Secret {...shown} login={`${me.origins.agent} · ${me.origins.crm} · ${me.origins.panel}`} onClose={() => setShown(null)} />}
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
              {rows.map((u) => {
                const self = u.email === me.email;
                return (
                  <tr key={u.email} className={u.disabled ? "muted" : ""}>
                    <td className="mono small">{u.email}</td>
                    <td>{u.name}</td>
                    <td>
                      <select value={u.roleId} disabled={busy || self} onChange={(e) => act(() => api.updateUser(t.prefix, u.email, { roleId: Number(e.target.value) }))}>
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={u.extension ?? ""}
                        disabled={busy}
                        onChange={(e) => act(() => api.updateUser(t.prefix, u.email, { extension: e.target.value || null }))}
                      >
                        <option value="">Yok</option>
                        {u.extension && !freeFor(u.email).some((e) => e.number === u.extension) && <option value={u.extension}>{u.extension}</option>}
                        {freeFor(u.email).map((e) => (
                          <option key={e.number} value={e.number}>
                            {e.number}
                            {e.display_name ? ` · ${e.display_name}` : ""}
                          </option>
                        ))}
                      </select>
                    </td>
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
                      {!self && (
                        <button className="ghost" disabled={busy} onClick={() => act(() => api.updateUser(t.prefix, u.email, { disabled: !u.disabled }))}>
                          {u.disabled ? "Aç" : "Kapat"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <h4>Yeni personel</h4>
      <div className="row">
        <input placeholder="E-posta" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="Ad Soyad" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
        <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: Number(e.target.value) })}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select value={form.extension} onChange={(e) => setForm({ ...form, extension: e.target.value })}>
          <option value="">{needsExt(form.roleId) ? "Dahili seçin" : "Dahili yok"}</option>
          {free.map((e) => (
            <option key={e.number} value={e.number}>
              {e.number}
              {e.display_name ? ` · ${e.display_name}` : ""}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !form.email || !form.roleId || (needsExt(form.roleId) && !form.extension)}
          onClick={() =>
            act(async () => {
              const r = await api.addUser(t.prefix, { email: form.email, name: form.name, roleId: form.roleId, extension: form.extension || null });
              setShown({ title: "Personel açıldı", email: r.email, password: r.temporaryPassword });
              setForm({ ...form, email: "", name: "", extension: "" });
            })
          }
        >
          Ekle
        </button>
      </div>
      <p className="muted small">
        Yetkiler rolden gelir; rolleri “Roller” sekmesinden siz tanımlarsınız. Temsilci masasını kullanan bir rol için dahili gerekir: dahili önce
        “Dahililer” sekmesinden açılır, “Kuyruklar” sekmesinden bir kuyruğa eklenir, sonra burada atanır.
      </p>
      {notInQueue.length > 0 && <p className="muted small">Hiçbir kuyrukta olmadığı için listede görünmeyen dahililer: {notInQueue.join(", ")}.</p>}
    </div>
  );
}

export function Roles({ prefix, me }: { prefix: string; me: Me }) {
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [catalog, setCatalog] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const load = () =>
    Promise.all([api.roles(prefix), api.permissions()])
      .then(([r, c]) => {
        setRoles(r);
        setCatalog(c);
      })
      .catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [prefix]);
  return (
    <>
      {error && <p className="error">{error}</p>}
      {roles?.map((r) => <RoleEditor key={r.id} prefix={prefix} role={r} catalog={catalog} me={me} onSaved={load} />)}
      <div className="card">
        <h3>Yeni rol</h3>
        <div className="row">
          <input placeholder="Rol adı (ör. Hasta Danışmanı)" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={50} />
          <button
            disabled={!newName.trim()}
            onClick={() =>
              api
                .addRole(prefix, newName.trim(), [])
                .then(() => {
                  setNewName("");
                  return load();
                })
                .catch((e) => setError(msg(e)))
            }
          >
            Ekle
          </button>
        </div>
        <p className="muted small">Rol yetkisiz açılır; aşağıda kartında yetkilerini işaretleyip kaydedin.</p>
      </div>
    </>
  );
}

function RoleEditor({ prefix, role, catalog, me, onSaved }: { prefix: string; role: RoleRow; catalog: { id: string; label: string }[]; me: Me; onSaved: () => void }) {
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const own = me.roleName === role.name && me.role === "tenant_user";
  const changed = name !== role.name || [...perms].sort().join() !== [...role.permissions].sort().join();
  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn()
      .then(() => {
        setState({ msg: ok, error: false });
        onSaved();
      })
      .catch((e) => setState({ msg: msg(e), error: true }));
  return (
    <div className="card">
      <div className="row spread">
        <input className="role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} aria-label="Rol adı" />
        <span className="muted small">
          {role.users} personel{own ? " · sizin rolünüz" : ""}
        </span>
      </div>
      <div className="perms">
        {catalog.map((c) => (
          <label key={c.id} className="check">
            <input
              type="checkbox"
              checked={perms.includes(c.id)}
              disabled={own && c.id === "staff.manage"}
              onChange={() => setPerms(perms.includes(c.id) ? perms.filter((p) => p !== c.id) : [...perms, c.id])}
            />
            {c.label}
          </label>
        ))}
      </div>
      <div className="actions">
        <button disabled={!changed} onClick={() => run(() => api.saveRole(prefix, role.id, name, perms), "Kaydedildi.")}>
          Kaydet
        </button>
        {role.users === 0 && (
          <button className="ghost" onClick={() => run(() => api.deleteRole(prefix, role.id), "Silindi.")}>
            Rolü sil
          </button>
        )}
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
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
  "user.role": "Personelin rolü değişti",
  "user.extension": "Personelin dahilisi değişti",
  "role.add": "Rol eklendi",
  "role.update": "Rol değişti",
  "role.delete": "Rol silindi",
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
  ["role.", "Roller"],
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
