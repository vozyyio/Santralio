// Santralio: tek uygulama, üç adres. Hangi ekranın açılacağı adresten anlaşılır:
//   panel.<alan> : ayarlar ve personel (patron, müdür)
//   crm.<alan>   : görüşmeler, kayıtlar, raporlar, işlem günlüğü
//   agent.<alan> : temsilci masası
// Oturum üç adreste ortaktır; üst menüden yeniden giriş yapmadan geçilir.
// Yönlendirme adres çubuğundaki # ile yapılır: #/ liste, #/t/<önek>/<sekme> kiracı sayfası.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AgentDesk } from "./AgentDesk";
import { Audit, Roles, Staff, SystemPage } from "./Admin";
import { Contacts, DispositionsCard, FollowUps } from "./Crm";
import { OutboundPolicyCard } from "./Outbound";
import { AiSessions, AiTab } from "./Ai";
import { InvitePage } from "./Vozyy";
import { Login } from "./Login";
import { Layout, type NavItem, type NavSection } from "./Layout";
import { Overview } from "./Overview";
import type { IconName } from "./Icons";
import { PbxCard, PromptsTab } from "./Prompts";
import { Calls, Reports } from "./Reports";
import { api, ApiError, type AppName, type Hours, type Me, type Sip, type Status, type Tenant, type TenantRow } from "./api";

const APP_LABEL: Record<AppName, string> = { panel: "Panel", crm: "CRM", agent: "Temsilci" };

// Adresin ilk parçası: panel / crm / agent. Geliştirme ortamında (localhost) panel.
export function currentApp(): AppName {
  const first = location.hostname.split(".")[0];
  return first === "crm" || first === "agent" ? first : "panel";
}

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((h: string) => {
    location.hash = h;
  }, []);
  return [hash, go];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const app = currentApp();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    document.title = `Santralio ${APP_LABEL[app]}`;
  }, [app]);

  const invite = /^#\/davet\/([A-Za-z0-9_-]{32})$/.exec(location.hash);
  if (invite && app === "panel") return <InvitePage token={invite[1]} onDone={load} />;
  if (me === undefined) return <div className="center muted">Yükleniyor…</div>;
  if (me === null) return <Login app={app} onDone={load} />;
  return <Shell app={app} me={me} onLogout={() => api.logout().finally(() => setMe(null))} />;
}

const TAB_ICON: Record<string, IconName> = {
  ozet: "dashboard",
  genel: "settings",
  menuler: "menu",
  anonslar: "megaphone",
  yapayzeka: "sparkles",
  saatler: "clock",
  kuyruklar: "queue",
  dahililer: "phone",
  personel: "users",
  roller: "shield",
  musteriler: "contact",
  geriarama: "callback",
  gorusmeler: "history",
  raporlar: "chart",
  gunluk: "log",
};

const allowedTabs = (me: Me, list: [string, string, string[]][]) => list.filter(([, , perms]) => can(me, ...perms));
const resolveTab = (tabs: [string, string, string[]][], requested: string) =>
  tabs.some(([id]) => id === requested) ? requested : (tabs[0]?.[0] ?? "");

function Shell({ app, me, onLogout }: { app: AppName; me: Me; onLogout: () => void }) {
  const [hash, go] = useHash();
  const m = /^#\/t\/([^/]+)(?:\/([a-z]+))?(?:\/(\d+))?/.exec(hash);
  const allowed = me.apps.includes(app);
  const scoped = me.role !== "tenant_user";
  const isSystem = app === "panel" && hash.startsWith("#/sistem") && me.role === "platform_admin";

  // Platform/bayi yöneticisi için önek → firma adı (kenar menüde gösterilir).
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!scoped) return;
    api
      .tenants()
      .then((rows) => setNames(Object.fromEntries(rows.map((r) => [r.prefix, r.name]))))
      .catch(() => {});
  }, [scoped]);

  const prefix = m?.[1] ?? null;
  const panelTabs = allowedTabs(me, PANEL_TABS);
  const crmTabs = allowedTabs(me, CRM_TABS);
  const tab = prefix ? resolveTab(app === "crm" ? crmTabs : panelTabs, m?.[2] ?? "") : "";

  const sections: NavSection[] = [];
  if (scoped && app !== "agent") {
    const items: NavItem[] = [{ href: "#/", label: "Müşteriler", icon: "building", active: !prefix && !isSystem }];
    if (me.role === "platform_admin" && app === "panel") items.push({ href: "#/sistem", label: "Sistem", icon: "server", active: isSystem });
    sections.push({ title: me.role === "platform_admin" ? "Platform" : "Bayi", items });
  }
  if (prefix && app !== "agent") {
    const list = app === "crm" ? crmTabs : panelTabs;
    sections.push({
      title: scoped ? "Firma" : undefined,
      items: list.map(([id, label]) => ({ href: `#/t/${prefix}/${id}`, label, icon: TAB_ICON[id] ?? "settings", active: tab === id })),
    });
  }
  if (app === "agent") sections.push({ items: [{ href: "#/", label: "Temsilci masası", icon: "headset", active: true }] });

  const tenantName = prefix ? (me.tenant?.prefix === prefix ? me.tenant.name : (names[prefix] ?? prefix)) : (me.tenant?.name ?? null);
  const context = scoped
    ? prefix
      ? { label: tenantName ?? prefix, back: { href: "#/", label: "Tüm müşteriler" } }
      : null
    : me.tenant
      ? { label: me.tenant.name }
      : null;

  const tabLabel = [...PANEL_TABS, ...CRM_TABS].find(([id]) => id === tab)?.[1];
  const title = !allowed
    ? "Erişim yok"
    : app === "agent"
      ? "Temsilci masası"
      : isSystem
        ? "Sistem"
        : prefix
          ? (tabLabel ?? "")
          : scoped
            ? "Müşteriler"
            : "";

  return (
    <Layout app={app} me={me} sections={sections} context={context} title={title} onLogout={onLogout}>
      {!allowed ? (
        <div className="card">
          <h2>Bu ekrana erişiminiz yok</h2>
          {me.apps.length ? (
            <p>
              Hesabınızla açabileceğiniz ekranlar:{" "}
              {me.apps.map((a, i) => (
                <span key={a}>
                  {i > 0 && ", "}
                  <a href={me.origins[a] + "/"}>{APP_LABEL[a]}</a>
                </span>
              ))}
              .
            </p>
          ) : (
            <p className="muted">Rolünüzde açık bir yetki yok. Yöneticinizle görüşün.</p>
          )}
        </div>
      ) : app === "agent" ? (
        <AgentDesk />
      ) : isSystem ? (
        <SystemPage />
      ) : prefix ? (
        app === "crm" ? (
          <CrmPage me={me} prefix={prefix} tab={tab} id={m?.[3] ? Number(m[3]) : null} />
        ) : tab === "ozet" ? (
          <Overview me={me} prefix={prefix} />
        ) : (
          <TenantPage me={me} prefix={prefix} tab={tab} />
        )
      ) : scoped ? (
        <TenantList go={go} />
      ) : (
        <OwnTenant me={me} go={go} />
      )}
    </Layout>
  );
}

// Kiracı kullanıcısı liste görmez; kendi kiracısının sayfasına gider.
function OwnTenant({ me, go }: { me: Me; go: (h: string) => void }) {
  useEffect(() => {
    if (me.tenant) go(`#/t/${me.tenant.prefix}`);
  }, [me.tenant, go]);
  return <p className="muted">Yükleniyor…</p>;
}

function TenantList({ go }: { go: (h: string) => void }) {
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .tenants()
      .then(setRows)
      .catch((e) => setError(message(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">Yükleniyor…</p>;
  return (
    <div className="card">
      <h2>Müşteriler</h2>
      <table>
        <thead>
          <tr>
            <th>Önek</th>
            <th>Ad</th>
            <th>Durum</th>
            <th>Lisans</th>
            <th>Dahili / kanal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.prefix} className="link" onClick={() => go(`#/t/${r.prefix}`)}>
              <td className="mono">{r.prefix}</td>
              <td>{r.name}</td>
              <td>
                <Badge ok={r.status === "active"}>{r.status === "active" ? "Aktif" : "Askıda"}</Badge>
              </td>
              <td>
                <Badge ok={!!r.licensed}>{r.licensed ? `Açık${r.valid_until ? ` · ${r.valid_until.slice(0, 10)}` : ""}` : "Kapalı"}</Badge>
              </td>
              <td>
                {r.max_extensions ?? "–"} / {r.max_channels ?? "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const can = (me: Me, ...perms: string[]) => perms.some((p) => me.permissions.includes(p));

// Panel sekmeleri ve gereken yetki.
const PANEL_TABS: [string, string, string[]][] = [
  ["ozet", "Özet", ["settings.manage", "staff.manage", "reports.view"]],
  ["genel", "Genel", ["settings.manage"]],
  ["menuler", "Menüler", ["settings.manage"]],
  ["anonslar", "Anonslar", ["settings.manage"]],
  ["yapayzeka", "Yapay zekâ", ["settings.manage"]],
  ["saatler", "Çalışma saatleri", ["settings.manage"]],
  ["kuyruklar", "Kuyruklar", ["settings.manage"]],
  ["dahililer", "Dahililer", ["settings.manage"]],
  ["personel", "Personel", ["staff.manage"]],
  ["roller", "Roller", ["staff.manage"]],
];

function TenantPage({ me, prefix, tab: requested }: { me: Me; prefix: string; tab: string }) {
  const tabs = PANEL_TABS.filter(([, , perms]) => can(me, ...perms)).map(([id, label]) => [id, label] as [string, string]);
  const tab = tabs.some(([id]) => id === requested) ? requested : (tabs[0]?.[0] ?? "");
  const [t, setT] = useState<Tenant | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api
      .tenant(prefix)
      .then(setT)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "Müşteri bulunamadı." : message(e)));
  }, [prefix]);
  useEffect(reload, [reload]);
  if (error) return <p className="error">{error}</p>;
  if (!t) return <p className="muted">Yükleniyor…</p>;
  return (
    <>
      {tab === "genel" && <General t={t} reload={reload} />}
      {tab === "anonslar" && <PromptsTab t={t} reload={reload} />}
      {tab === "yapayzeka" && <AiTab t={t} reload={reload} />}
      {tab === "menuler" && t.menus.map((m) => <MenuEditor key={m.name} t={t} menu={m} reload={reload} />)}
      {tab === "menuler" && t.menus.length === 0 && <p className="muted">Bu müşteride henüz menü yok.</p>}
      {tab === "saatler" && t.schedules.map((s) => <ScheduleEditor key={s.name} t={t} sc={s} reload={reload} />)}
      {tab === "saatler" && t.schedules.length === 0 && <p className="muted">Bu müşteride henüz çalışma saati tanımı yok.</p>}
      {tab === "kuyruklar" && t.queues.map((q) => <QueueEditor key={q.name} t={t} q={q} reload={reload} />)}
      {tab === "dahililer" && <Extensions t={t} reload={reload} />}
      {tab === "personel" && <Staff t={t} me={me} reload={reload} />}
      {tab === "roller" && <Roles prefix={t.prefix} me={me} />}
    </>
  );
}

// CRM sekmeleri ve gereken yetki.
const CRM_TABS: [string, string, string[]][] = [
  ["musteriler", "Müşteriler", ["crm.use"]],
  ["geriarama", "Geri aramalar", ["crm.use"]],
  ["gorusmeler", "Görüşmeler", ["calls.all", "calls.own"]],
  ["raporlar", "Raporlar", ["reports.view"]],
  ["yapayzeka", "Yapay zekâ", ["calls.all"]],
  ["gunluk", "İşlem günlüğü", ["audit.view"]],
];

function CrmPage({ me, prefix, tab: requested, id }: { me: Me; prefix: string; tab: string; id: number | null }) {
  const tabs = CRM_TABS.filter(([, , perms]) => can(me, ...perms)).map(([id, label]) => [id, label] as [string, string]);
  const tab = tabs.some(([id]) => id === requested) ? requested : (tabs[0]?.[0] ?? "");
  return (
    <>
      {tab === "musteriler" && <Contacts prefix={prefix} contactId={id} />}
      {tab === "geriarama" && <FollowUps prefix={prefix} />}
      {tab === "gorusmeler" && <Calls prefix={prefix} own={!can(me, "calls.all")} />}
      {tab === "raporlar" && <Reports prefix={prefix} />}
      {tab === "yapayzeka" && <AiSessions prefix={prefix} />}
      {tab === "gunluk" && <Audit prefix={prefix} />}
      {tabs.length === 0 && <p className="muted">Rolünüzde CRM'de açık bir sekme yok.</p>}
    </>
  );
}

// --- Ortak parçalar ---

function Badge({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={`badge ${ok ? "ok" : "off"}`}>{children}</span>;
}

// Bir kaydetme işlemini yürütür; sonucu düğmenin yanında gösterir.
function useSave(reload: () => void) {
  const [state, setState] = useState<{ busy: boolean; msg: string; error: boolean }>({ busy: false, msg: "", error: false });
  const run = async (fn: () => Promise<unknown>, okMsg = "Kaydedildi ve santrale uygulandı.") => {
    setState({ busy: true, msg: "", error: false });
    try {
      await fn();
      setState({ busy: false, msg: okMsg, error: false });
      reload();
    } catch (e) {
      setState({ busy: false, msg: message(e), error: true });
    }
  };
  const view = state.msg ? <span className={state.error ? "error small" : "ok small"}>{state.msg}</span> : null;
  return { busy: state.busy, run, view };
}

function targetLabel(t: Tenant, target: string | null): string {
  if (!target) return "Kapat";
  const [kind, name] = target.split(":");
  if (kind === "ai") return `Yapay zekâ: ${name}`;
  if (kind === "ext") {
    const e = t.extensions.find((x) => x.number === name);
    return `Dahili: ${name}${e?.display_name ? ` · ${e.display_name}` : ""}`;
  }
  return `${{ queue: "Kuyruk", menu: "Menü", schedule: "Çalışma saati" }[kind] ?? kind}: ${name}`;
}

function TargetSelect({ t, value, onChange, allowNone }: { t: Tenant; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  const options = [
    ...t.queues.map((q) => `queue:${q.name}`),
    ...t.menus.map((m) => `menu:${m.name}`),
    ...t.schedules.map((s) => `schedule:${s.name}`),
    ...t.extensions.filter((e) => e.enabled).map((e) => `ext:${e.number}`),
    ...t.aiFlows.map((f) => `ai:${f}`),
  ];
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">Kapat</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {targetLabel(t, o)}
        </option>
      ))}
    </select>
  );
}

// Metin değişince ses de yeniden üretildiği için adrese metnin özetinden bir sürüm eklenir (tarayıcı önbelleği).
function textVersion(s: string): string {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

function Prompt({ t, name, version }: { t: Tenant; name: string; version: string }) {
  return <audio controls preload="none" src={`${api.promptUrl(t.prefix, name)}?v=${textVersion(version)}`} />;
}

// --- Sekmeler ---

function General({ t, reload }: { t: Tenant; reload: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api.status(t.prefix).then(setStatus).catch(() => setStatus(null));
  }, [t.prefix]);
  return (
    <div className="grid">
      <PbxCard t={t} reload={reload} />
      <div className="card">
        <h3>Lisans</h3>
        {t.license ? (
          <dl>
            <dt>Durum</dt>
            <dd>
              <Badge ok={t.license.active}>{t.license.active ? "Açık" : "Kapalı"}</Badge> <span className="muted small">({t.license.source})</span>
            </dd>
            <dt>Bitiş</dt>
            <dd>{t.license.valid_until?.slice(0, 10) ?? "Süresiz"}</dd>
            <dt>Dahili sınırı</dt>
            <dd>
              {t.extensions.length} / {t.license.max_extensions}
            </dd>
            <dt>Eş zamanlı arama</dt>
            <dd>{t.license.max_channels}</dd>
          </dl>
        ) : (
          <p className="muted">Lisans kaydı yok.</p>
        )}
      </div>
      <div className="card">
        <h3>Operatör hattı</h3>
        {t.trunk ? (
          <dl>
            <dt>Operatör</dt>
            <dd>{t.trunk.operator}</dd>
            <dt>Kullanıcı</dt>
            <dd className="mono">{t.trunk.username}</dd>
            <dt>Kayıt</dt>
            <dd>{status ? <Badge ok={status.registration === "Registered"}>{status.registration}</Badge> : "…"}</dd>
            <dt>Bağlı dahililer</dt>
            <dd>{status ? (status.onlineExtensions.length ? status.onlineExtensions.join(", ") : "Yok") : "…"}</dd>
          </dl>
        ) : (
          <p className="muted">Operatör hattı tanımlı değil.</p>
        )}
      </div>
      <RecordingSettings t={t} reload={reload} />
      <OutboundPolicyCard prefix={t.prefix} />
      <DispositionsCard prefix={t.prefix} />
      <div className="card wide">
        <h3>Numaralar</h3>
        {t.entryPoints.length === 0 && <p className="muted">Numara yok.</p>}
        {t.entryPoints.map((e) => (
          <EntryPoint key={e.address} t={t} address={e.address} flow={e.flow} reload={reload} />
        ))}
      </div>
    </div>
  );
}

function RecordingSettings({ t, reload }: { t: Tenant; reload: () => void }) {
  const [enabled, setEnabled] = useState(t.recording.enabled);
  const [days, setDays] = useState(t.recording.retentionDays);
  const [notice, setNotice] = useState(t.recording.noticeText);
  const save = useSave(reload);
  const changed = enabled !== t.recording.enabled || days !== t.recording.retentionDays || notice !== t.recording.noticeText;
  return (
    <div className="card wide">
      <h3>Arama kaydı</h3>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Görüşmeleri kaydet
      </label>
      <p className="muted small">
        Kayıt, temsilci aramayı açtığında başlar; bekleme müziği kaydedilmez. Kayıt açıkken arayan önce aşağıdaki bilgilendirme anonsunu duyar.
        Kayıtları dinleyen her erişim denetim kaydına yazılır.
      </p>
      <label>
        Bilgilendirme anonsu (KVKK)
        <textarea rows={2} value={notice} onChange={(e) => setNotice(e.target.value)} maxLength={500} />
      </label>
      <Prompt t={t} name="recording-notice" version={t.recording.noticeText} />
      <div className="row">
        <label className="inline">
          Saklama süresi (gün)
          <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <span className="muted small">Süresi dolan kayıtlar her gece kalıcı olarak silinir.</span>
      </div>
      <div className="actions">
        <button disabled={save.busy || !changed} onClick={() => save.run(() => api.saveRecording(t.prefix, { enabled, retentionDays: days, noticeText: notice }))}>
          Kaydet
        </button>
        {save.view}
      </div>
    </div>
  );
}

function EntryPoint({ t, address, flow, reload }: { t: Tenant; address: string; flow: string; reload: () => void }) {
  const [value, setValue] = useState(flow);
  const save = useSave(reload);
  return (
    <div className="row">
      <span className="mono">+{address}</span>
      <span className="muted">→</span>
      <TargetSelect t={t} value={value} onChange={(v) => setValue(v ?? flow)} />
      <button disabled={save.busy || value === flow} onClick={() => save.run(() => api.setFlow(t.prefix, address, value))}>
        Kaydet
      </button>
      {save.view}
    </div>
  );
}

function MenuEditor({ t, menu, reload }: { t: Tenant; menu: Tenant["menus"][number]; reload: () => void }) {
  const [text, setText] = useState(menu.prompt_text);
  const [invalid, setInvalid] = useState(menu.invalid_text);
  const [timeout, setTimeout_] = useState(menu.timeout_s);
  const [tries, setTries] = useState(menu.max_tries);
  const [fallback, setFallback] = useState(menu.default_target);
  const [options, setOptions] = useState<[string, string][]>(Object.entries(menu.options).sort());
  const save = useSave(reload);
  const free = "1234567890*#".split("").filter((d) => !options.some(([k]) => k === d));
  const submit = () =>
    save.run(() =>
      api.saveMenu(t.prefix, menu.name, {
        text,
        invalidText: invalid,
        timeoutS: timeout,
        maxTries: tries,
        defaultTarget: fallback,
        options: Object.fromEntries(options),
      }),
    );
  return (
    <div className="card">
      <h3>
        Menü: <span className="mono">{menu.name}</span>
      </h3>
      <label>
        Karşılama anonsu
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      </label>
      <Prompt t={t} name={`menu-${menu.name}`} version={menu.prompt_text} />
      <h4>Tuşlar</h4>
      {options.map(([digit, target], i) => (
        <div className="row" key={digit}>
          <span className="key">{digit}</span>
          <TargetSelect t={t} value={target} onChange={(v) => setOptions(options.map((o, j) => (j === i ? [digit, v ?? target] : o)))} />
          <button className="ghost" onClick={() => setOptions(options.filter((_, j) => j !== i))}>
            Kaldır
          </button>
        </div>
      ))}
      {free.length > 0 && t.queues.length > 0 && (
        <button className="ghost" onClick={() => setOptions([...options, [free[0], `queue:${t.queues[0].name}`] as [string, string]].sort())}>
          + Tuş ekle ({free[0]})
        </button>
      )}
      <h4>Tuşlanmazsa</h4>
      <div className="row">
        <label className="inline">
          Bekleme (sn)
          <input type="number" min={1} max={30} value={timeout} onChange={(e) => setTimeout_(Number(e.target.value))} />
        </label>
        <label className="inline">
          Tekrar
          <input type="number" min={1} max={10} value={tries} onChange={(e) => setTries(Number(e.target.value))} />
        </label>
        <label className="inline">
          Sonra
          <TargetSelect t={t} value={fallback} onChange={setFallback} allowNone />
        </label>
      </div>
      <label>
        Geçersiz tuş anonsu
        <input value={invalid} onChange={(e) => setInvalid(e.target.value)} maxLength={500} />
      </label>
      <div className="actions">
        <button disabled={save.busy} onClick={submit}>
          {save.busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
        {save.view}
      </div>
    </div>
  );
}

const DAYS: [string, string][] = [
  ["mon-fri", "Hafta içi"],
  ["mon-sat", "Pazartesi–Cumartesi"],
  ["sat-sun", "Hafta sonu"],
  ["mon", "Pazartesi"],
  ["tue", "Salı"],
  ["wed", "Çarşamba"],
  ["thu", "Perşembe"],
  ["fri", "Cuma"],
  ["sat", "Cumartesi"],
  ["sun", "Pazar"],
];

function ScheduleEditor({ t, sc, reload }: { t: Tenant; sc: Tenant["schedules"][number]; reload: () => void }) {
  const [open, setOpen] = useState(sc.open_target);
  const [closedText, setClosedText] = useState(sc.closed_text);
  const [closedTarget, setClosedTarget] = useState(sc.closed_target);
  const [hours, setHours] = useState<Hours[]>(sc.hours);
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const save = useSave(reload);
  const holiday = useSave(reload);
  const setH = (i: number, h: Partial<Hours>) => setHours(hours.map((x, j) => (j === i ? { ...x, ...h } : x)));
  return (
    <div className="card">
      <h3>
        Çalışma saati: <span className="mono">{sc.name}</span> <span className="muted small">({sc.timezone})</span>
      </h3>
      <h4>Açık olduğu saatler</h4>
      {hours.map((h, i) => (
        <div className="row" key={i}>
          <select value={h.weekdays} onChange={(e) => setH(i, { weekdays: e.target.value })}>
            {DAYS.some(([v]) => v === h.weekdays) ? null : <option value={h.weekdays}>{h.weekdays}</option>}
            {DAYS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input type="time" value={h.opens} onChange={(e) => setH(i, { opens: e.target.value })} />
          <span className="muted">–</span>
          <input type="time" value={h.closes} onChange={(e) => setH(i, { closes: e.target.value })} />
          <button className="ghost" onClick={() => setHours(hours.filter((_, j) => j !== i))}>
            Kaldır
          </button>
        </div>
      ))}
      <button className="ghost" onClick={() => setHours([...hours, { weekdays: "mon-fri", opens: "09:00", closes: "18:00" }])}>
        + Aralık ekle
      </button>
      <div className="row">
        <label className="inline">
          Açıkken
          <TargetSelect t={t} value={open} onChange={(v) => setOpen(v ?? open)} />
        </label>
        <label className="inline">
          Kapalıyken, anonstan sonra
          <TargetSelect t={t} value={closedTarget} onChange={setClosedTarget} allowNone />
        </label>
      </div>
      <label>
        Mesai dışı anonsu
        <textarea rows={3} value={closedText} onChange={(e) => setClosedText(e.target.value)} maxLength={1000} />
      </label>
      <Prompt t={t} name={`schedule-${sc.name}-closed`} version={sc.closed_text} />
      <div className="actions">
        <button
          disabled={save.busy}
          onClick={() => save.run(() => api.saveSchedule(t.prefix, sc.name, { openTarget: open, closedText, closedTarget, timezone: sc.timezone, hours }))}
        >
          {save.busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
        {save.view}
      </div>
      <h4>Tatiller (tam gün kapalı)</h4>
      <ul className="list">
        {sc.holidays.map((h) => (
          <li key={h.day}>
            <span className="mono">{h.day}</span> {h.note}
          </li>
        ))}
        {sc.holidays.length === 0 && <li className="muted">Tanımlı tatil yok.</li>}
      </ul>
      <div className="row">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <input placeholder="Açıklama (ör. Ramazan Bayramı)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} />
        <button disabled={!day || holiday.busy} onClick={() => holiday.run(() => api.addHoliday(t.prefix, sc.name, day, note), "Tatil eklendi.")}>
          Ekle
        </button>
        {holiday.view}
      </div>
    </div>
  );
}

function QueueEditor({ t, q, reload }: { t: Tenant; q: Tenant["queues"][number]; reload: () => void }) {
  const [text, setText] = useState(q.unavailable_text);
  const [members, setMembers] = useState<string[]>(q.members);
  const [number, setNumber] = useState(q.number ?? "");
  const save = useSave(reload);
  const saveMembers = useSave(reload);
  const saveNumber = useSave(reload);
  const toggle = (n: string) => setMembers(members.includes(n) ? members.filter((x) => x !== n) : [...members, n].sort());
  return (
    <div className="card">
      <h3>
        Kuyruk: <span className="mono">{q.name}</span>
        {q.number && <span className="muted small"> · iç numara {q.number}</span>}
      </h3>
      <p className="small">
        Temsilciler: {q.members.length ? q.members.join(", ") : <span className="muted">yok</span>} · Strateji: {q.strategy} · Çalma {q.ring_s} sn · En
        fazla bekleme {q.max_wait_s} sn
      </p>
      <h4>Temsilciler</h4>
      <div className="row">
        {t.extensions.map((e) => (
          <label key={e.number} className="check chip">
            <input type="checkbox" checked={members.includes(e.number)} onChange={() => toggle(e.number)} />
            {e.number}
            {e.display_name ? ` · ${e.display_name}` : ""}
          </label>
        ))}
        <button
          disabled={saveMembers.busy || members.join() === [...q.members].sort().join()}
          onClick={() => saveMembers.run(() => api.setQueueMembers(t.prefix, q.name, members))}
        >
          Kaydet
        </button>
        {saveMembers.view}
      </div>
      <div className="row">
        <label className="inline">
          İç numara (dahililerden aranır, ör. 8001)
          <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))} maxLength={6} />
        </label>
        <button disabled={saveNumber.busy || number === (q.number ?? "")} onClick={() => saveNumber.run(() => api.setQueueNumber(t.prefix, q.name, number || null))}>
          Kaydet
        </button>
        {saveNumber.view}
      </div>
      <label>
        Müsait temsilci yokken anons
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </label>
      <Prompt t={t} name={`queue-${q.name}-unavailable`} version={q.unavailable_text} />
      <div className="actions">
        <button disabled={save.busy || text === q.unavailable_text} onClick={() => save.run(() => api.saveUnavailable(t.prefix, q.name, text))}>
          Kaydet
        </button>
        {save.view}
      </div>
    </div>
  );
}

function Extensions({ t, reload }: { t: Tenant; reload: () => void }) {
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Sip | null>(null);
  const save = useSave(reload);
  const full = !!t.license && t.extensions.length >= t.license.max_extensions;
  return (
    <div className="card">
      <h3>Dahililer</h3>
      <table>
        <thead>
          <tr>
            <th>Dahili</th>
            <th>Ad</th>
            <th>SIP kullanıcı</th>
          </tr>
        </thead>
        <tbody>
          {t.extensions.map((e) => (
            <tr key={e.number}>
              <td className="mono">{e.number}</td>
              <td>{e.display_name}</td>
              <td className="mono muted">
                {t.prefix}_{e.number}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Yeni dahili</h4>
      {full ? (
        <p className="muted">Lisanstaki dahili sınırı dolu ({t.license!.max_extensions}).</p>
      ) : (
        <div className="row">
          <input placeholder="Numara (ör. 1003)" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))} maxLength={6} />
          <input placeholder="Ad" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <button
            disabled={save.busy || number.length < 2}
            onClick={() =>
              save.run(async () => {
                const r = await api.addExtension(t.prefix, number, name);
                setCreated(r.sip);
                setNumber("");
                setName("");
              }, "Dahili açıldı.")
            }
          >
            Ekle
          </button>
          {save.view}
        </div>
      )}
      {created && (
        <div className="notice">
          <strong>SIP bilgileri — şifre yalnızca şimdi gösteriliyor, bir yere kaydedin.</strong>
          <dl>
            <dt>Sunucu</dt>
            <dd className="mono">{created.server}</dd>
            <dt>Port</dt>
            <dd className="mono">
              {created.port} ({created.transport.toUpperCase()})
            </dd>
            <dt>Kullanıcı</dt>
            <dd className="mono">{created.username}</dd>
            <dt>Şifre</dt>
            <dd className="mono">{created.password}</dd>
          </dl>
          <button className="ghost" onClick={() => setCreated(null)}>
            Kaydettim, gizle
          </button>
        </div>
      )}
    </div>
  );
}
