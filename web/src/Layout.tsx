// Panel iskeleti: masaüstünde sabit kenar menü, tablet/telefonda açılır menü (çekmece).
// Menü öğeleri App.tsx'te kullanıcının yetkilerine göre hesaplanır; burada yalnızca gösterilir.

import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";
import type { AppName, Me } from "./api";

export type NavItem = { href: string; label: string; icon: IconName; active: boolean; soon?: boolean };
export type NavSection = { title?: string; items: NavItem[] };

const APP_LABEL: Record<AppName, string> = { panel: "Panel", crm: "CRM", agent: "Temsilci" };
const SCOPE_LABEL: Record<string, string> = { platform_admin: "Platform yöneticisi", reseller_admin: "Bayi yöneticisi" };

function Brand() {
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
      <span className="lay-word">
        Santral<b>io</b>
      </span>
    </a>
  );
}

function initials(me: Me) {
  const src = (me.name || me.email).trim();
  const parts = src.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toLocaleUpperCase("tr-TR") || "?";
}

export function Layout({
  app,
  me,
  sections,
  context,
  title,
  onLogout,
  children,
}: {
  app: AppName;
  me: Me;
  sections: NavSection[];
  context?: { label: string; back?: { href: string; label: string } } | null;
  title: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const scoped = me.role !== "tenant_user";

  // Menüden bir yere gidilince ya da Esc'e basılınca çekmece kapanır.
  useEffect(() => {
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("hashchange", close);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("hashchange", close);
      removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("lay-lock", open);
    return () => document.body.classList.remove("lay-lock");
  }, [open]);

  return (
    <div className={`lay ${open ? "lay-open" : ""}`}>
      <aside className="lay-side" id="lay-side" aria-label="Menü">
        <div className="lay-side-head">
          <Brand />
          <button type="button" className="lay-icon-btn lay-only-mobile" aria-label="Menüyü kapat" onClick={() => setOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        {me.apps.length > 1 && (
          <nav className="lay-apps" aria-label="Ekranlar">
            {me.apps.map((a) => (
              <a key={a} href={me.origins[a] + "/"} className={a === app ? "active" : ""} aria-current={a === app ? "page" : undefined}>
                {APP_LABEL[a]}
              </a>
            ))}
          </nav>
        )}

        {context && (
          <div className="lay-context">
            {context.back && (
              <a href={context.back.href} className="lay-back">
                <Icon name="back" size={16} />
                {context.back.label}
              </a>
            )}
            <div className="lay-context-name" title={context.label}>
              {context.label}
            </div>
          </div>
        )}

        <nav className="lay-nav" aria-label="Sayfalar">
          {sections.map((s, i) => (
            <div key={s.title ?? i} className="lay-section">
              {s.title && <div className="lay-section-title">{s.title}</div>}
              {s.items.map((it) => (
                <a key={it.href} href={it.href} className={it.active ? "active" : ""} aria-current={it.active ? "page" : undefined}>
                  <Icon name={it.icon} size={18} />
                  <span>{it.label}</span>
                  {it.soon && <em className="lay-soon">Yakında</em>}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="lay-user">
          <span className="lay-avatar" aria-hidden="true">
            {initials(me)}
          </span>
          <span className="lay-user-text">
            <strong>{me.name || me.email}</strong>
            <small>{scoped ? SCOPE_LABEL[me.role] : (me.roleName ?? "")}</small>
          </span>
          <button type="button" className="lay-icon-btn" aria-label="Çıkış yap" title="Çıkış yap" onClick={onLogout}>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>

      <button type="button" className="lay-scrim" aria-label="Menüyü kapat" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)} />

      <div className="lay-body">
        <header className="lay-top">
          <button
            type="button"
            className="lay-icon-btn lay-only-mobile"
            aria-label="Menüyü aç"
            aria-controls="lay-side"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <Icon name="burger" />
          </button>
          <div className="lay-top-title">
            <span className="lay-top-app">{context?.label ?? APP_LABEL[app]}</span>
            <h1>{title}</h1>
          </div>
        </header>
        <main className="lay-main">{children}</main>
      </div>
    </div>
  );
}
