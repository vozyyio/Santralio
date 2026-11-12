// Panel iskeleti: üstte iki satır (marka + işlemler, altında sayfa menüsü), içerik ekranın tamamına yayılır.
// 1024px altında sayfa menüsü soldan açılan çekmeceye taşınır.
// Tema: açık (varsayılan) ya da yumuşak koyu; seçim tarayıcıda hatırlanır.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";
import type { AppName, Me } from "./api";

export type NavItem = { href: string; label: string; icon: IconName; active: boolean; badge?: string };
export type NavSection = { title?: string; items: NavItem[]; bar?: boolean };
export type Tone = "ok" | "warn" | "bad" | "idle" | "info";
export type Chip = { label: string; value: string; tone?: Tone };
export type LayoutContext = {
  label: string;
  code?: string;
  line?: { text: string; tone: Tone };
  back?: { href: string; label: string };
};

const APP_LABEL: Record<AppName, string> = { panel: "Panel", crm: "CRM", agent: "Temsilci" };
const APP_SUB: Record<AppName, string> = { panel: "Yönetim paneli", crm: "Müşteri ilişkileri", agent: "Temsilci masası" };
const SCOPE_LABEL: Record<string, string> = { platform_admin: "Platform yöneticisi", reseller_admin: "Bayi yöneticisi" };

type Theme = "light" | "dark";
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem("santralio-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("santralio-theme", theme);
    } catch {
      /* depolama kapalı olabilir */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

function initials(me: Me) {
  const parts = (me.name || me.email).trim().split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toLocaleUpperCase("tr-TR") || "?";
}

function Brand({ app }: { app: AppName }) {
  return (
    <a href="#/" className="lay-brand" aria-label="Santralio">
      <span className="lay-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M6 10v4M10 7v10M14 4v16M18 8v8" stroke="url(#layg)" strokeWidth="2.4" strokeLinecap="round" />
          <defs>
            <linearGradient id="layg" x1="6" y1="4" x2="18" y2="20" gradientUnits="userSpaceOnUse">
              <stop stopColor="#38BDF8" />
              <stop offset="1" stopColor="#2563EB" />
            </linearGradient>
          </defs>
        </svg>
      </span>
      <span className="lay-brand-text">
        <span className="lay-word">
          Santral<b>io</b>
        </span>
        <span className="lay-sub">{APP_SUB[app]}</span>
      </span>
    </a>
  );
}

function Apps({ me, app }: { me: Me; app: AppName }) {
  if (me.apps.length < 2) return null;
  return (
    <nav className="lay-apps" aria-label="Ekranlar">
      {me.apps.map((a) => (
        <a key={a} href={me.origins[a] + "/"} className={a === app ? "active" : ""} aria-current={a === app ? "page" : undefined}>
          {APP_LABEL[a]}
        </a>
      ))}
    </nav>
  );
}

function TenantPill({ context }: { context: LayoutContext }) {
  return (
    <div className="lay-tenant">
      {context.back && (
        <a href={context.back.href} className="lay-back" title={context.back.label} aria-label={context.back.label}>
          <Icon name="back" size={16} />
        </a>
      )}
      <span className="lay-tenant-text">
        <span className="lay-tenant-name" title={context.label}>
          {context.label}
          {context.code && <span className="lay-code">{context.code}</span>}
        </span>
        {context.line && (
          <span className={`lay-tenant-line t-${context.line.tone}`}>
            <span className="lay-dot" />
            {context.line.text}
          </span>
        )}
      </span>
    </div>
  );
}

function NavLinks({ sections, vertical }: { sections: NavSection[]; vertical?: boolean }) {
  return (
    <>
      {sections.map((s, i) => (
        <div key={s.title ?? i} className="lay-group" role="group" aria-label={s.title}>
          {vertical && s.title && <div className="lay-group-title">{s.title}</div>}
          {s.items.map((it) => (
            <a key={it.href} href={it.href} className={it.active ? "active" : ""} aria-current={it.active ? "page" : undefined}>
              <Icon name={it.icon} size={17} />
              <span>{it.label}</span>
              {it.badge && <span className="lay-badge">{it.badge}</span>}
            </a>
          ))}
        </div>
      ))}
    </>
  );
}

function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", off);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", off);
      removeEventListener("keydown", key);
    };
  }, [open]);
  const scoped = me.role !== "tenant_user";
  return (
    <div className="lay-user" ref={ref}>
      <button type="button" className="lay-user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="lay-avatar" aria-hidden="true">
          {initials(me)}
        </span>
        <span className="lay-user-name">{me.name || me.email}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="lay-user-menu" role="menu">
          <div className="lay-user-info">
            <strong>{me.name || me.email}</strong>
            <small>{me.email}</small>
            <small>{scoped ? SCOPE_LABEL[me.role] : (me.roleName ?? "")}</small>
          </div>
          <button type="button" role="menuitem" className="lay-menu-item" onClick={onLogout}>
            <Icon name="logout" size={16} /> Çıkış yap
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout({
  app,
  me,
  sections,
  context,
  title,
  chips,
  action,
  onLogout,
  children,
}: {
  app: AppName;
  me: Me;
  sections: NavSection[];
  context?: LayoutContext | null;
  title: string;
  chips?: Chip[];
  action?: ReactNode;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const close = () => setDrawer(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    addEventListener("hashchange", close);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("hashchange", close);
      removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("lay-lock", drawer);
    return () => document.body.classList.remove("lay-lock");
  }, [drawer]);

  const hasNav = sections.some((s) => s.items.length > 0);
  const barSections = sections.filter((s) => s.bar);
  const tabSections = sections.filter((s) => !s.bar);
  const hasTabs = tabSections.some((s) => s.items.length > 0);

  return (
    <div className={`lay ${drawer ? "lay-drawer-open" : ""}`}>
      <header className="lay-head">
        <div className="lay-bar">
          {hasNav && (
            <button
              type="button"
              className="lay-icon-btn lay-mobile"
              aria-label="Menüyü aç"
              aria-controls="lay-drawer"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <Icon name="burger" />
            </button>
          )}
          <Brand app={app} />
          <div className="lay-desktop lay-bar-left">
            <Apps me={me} app={app} />
            {barSections.map((sec) => (
              <nav key={sec.title} className="lay-scope" aria-label={sec.title}>
                {sec.items.map((it) => (
                  <a key={it.href} href={it.href} className={it.active ? "active" : ""} aria-current={it.active ? "page" : undefined}>
                    <Icon name={it.icon} size={16} />
                    {it.label}
                  </a>
                ))}
              </nav>
            ))}
          </div>
          <span className="lay-spacer" />
          {chips && chips.length > 0 && (
            <div className="lay-chips">
              {chips.map((c) => (
                <span key={c.label} className={`lay-chip t-${c.tone ?? "info"}`}>
                  <span className="lay-dot" />
                  <span className="lay-chip-label">{c.label}:</span>
                  <strong>{c.value}</strong>
                </span>
              ))}
            </div>
          )}
          {action}
          <button
            type="button"
            className="lay-icon-btn"
            aria-label={theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç"}
            title={theme === "dark" ? "Açık tema" : "Koyu tema"}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
          <UserMenu me={me} onLogout={onLogout} />
        </div>

        {(hasTabs || context) && (
          <div className="lay-navrow lay-desktop-flex">
            {context && <TenantPill context={context} />}
            {hasTabs && (
              <nav className="lay-tabs" aria-label="Sayfalar">
                <NavLinks sections={tabSections} />
              </nav>
            )}
          </div>
        )}
      </header>

      {/* Tablet/telefon çekmecesi */}
      <aside className="lay-drawer" id="lay-drawer" aria-label="Menü" aria-hidden={!drawer}>
        <div className="lay-drawer-head">
          <Brand app={app} />
          <button type="button" className="lay-icon-btn" aria-label="Menüyü kapat" onClick={() => setDrawer(false)}>
            <Icon name="close" />
          </button>
        </div>
        <Apps me={me} app={app} />
        {context && <TenantPill context={context} />}
        <nav className="lay-vnav" aria-label="Sayfalar">
          <NavLinks sections={sections} vertical />
        </nav>
      </aside>
      <button type="button" className="lay-scrim" aria-label="Menüyü kapat" tabIndex={drawer ? 0 : -1} onClick={() => setDrawer(false)} />

      <main className="lay-main">
        <div className="lay-pagehead">
          <h1>{title}</h1>
          {context && <span className="lay-pagehead-sub">{context.label}</span>}
        </div>
        {children}
      </main>
    </div>
  );
}
