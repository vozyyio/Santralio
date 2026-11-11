// Panel iskeleti (Operasyon Konsolu tasarımı): sol menü + üst bar.
// 1024px altında sol menü, hamburger ile açılan çekmeceye dönüşür.
// Menü öğeleri ve üst bar bilgileri App.tsx'te kullanıcının yetkisine göre hesaplanır.

import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";
import type { AppName, Me } from "./api";

export type NavItem = { href: string; label: string; icon: IconName; active: boolean; badge?: string };
export type NavSection = { title?: string; items: NavItem[] };
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

function initials(me: Me) {
  const parts = (me.name || me.email).trim().split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toLocaleUpperCase("tr-TR") || "?";
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
  const [open, setOpen] = useState(false);
  const scoped = me.role !== "tenant_user";

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
          <a href="#/" className="lay-brand" aria-label="Santralio">
            <span className="lay-mark" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
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
          <div className="lay-tenant">
            {context.back && (
              <a href={context.back.href} className="lay-back">
                <Icon name="back" size={14} />
                {context.back.label}
              </a>
            )}
            <div className="lay-tenant-top">
              <span className="lay-tenant-label">Aktif firma</span>
              {context.code && <span className="lay-code">{context.code}</span>}
            </div>
            <div className="lay-tenant-name" title={context.label}>
              {context.label}
            </div>
            {context.line && (
              <div className={`lay-tenant-line t-${context.line.tone}`}>
                <span className="lay-dot" />
                {context.line.text}
              </div>
            )}
          </div>
        )}

        <nav className="lay-nav" aria-label="Sayfalar">
          {sections.map((s, i) => (
            <div key={s.title ?? i} className="lay-section">
              {s.title && <div className="lay-section-title">{s.title}</div>}
              {s.items.map((it) => (
                <a key={it.href} href={it.href} className={it.active ? "active" : ""} aria-current={it.active ? "page" : undefined}>
                  <Icon name={it.icon} size={18} />
                  <span className="lay-nav-label">{it.label}</span>
                  {it.badge && <span className="lay-badge">{it.badge}</span>}
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
            <strong>{me.name || (scoped ? SCOPE_LABEL[me.role] : me.email)}</strong>
            <small>{me.email}</small>
          </span>
          <button type="button" className="lay-icon-btn lay-icon-btn-plain" aria-label="Çıkış yap" title="Çıkış yap" onClick={onLogout}>
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
          <div className="lay-crumb">
            <h1>{title}</h1>
            {context && (
              <>
                <span className="lay-slash" aria-hidden="true">
                  /
                </span>
                <span className="lay-crumb-code">{context.label}</span>
              </>
            )}
          </div>
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
          {action && <div className="lay-action">{action}</div>}
        </header>
        <main className="lay-main">{children}</main>
      </div>
    </div>
  );
}
