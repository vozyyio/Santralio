// Giriş ekranı: panel, crm ve agent adreslerinde ortak. Her zaman koyu marka temasıyla açılır (site ile aynı dil).
// Kurallar: yalnızca e-posta + şifre (kiracı hesaptan belirlenir); altyapı bilgisi gösterilmez;
// hata mesajı hangi bilginin yanlış olduğunu söylemez; şifre sıfırlama yönetici üzerinden yapılır.

import { useEffect, useState, type FormEvent } from "react";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "./login.css";
import { api, ApiError, type AppName } from "./api";

type Lang = "tr" | "en";

const T = {
  tr: {
    title: { panel: "Panele giriş", crm: "CRM’e giriş", agent: "Temsilci masasına giriş" },
    console: { panel: "Yönetim paneli", crm: "CRM", agent: "Temsilci masası" },
    pitch: "Santralinizi ve yapay zekânızı tek ekrandan yönetin.",
    pitchSub: "Çağrılar, kuyruklar, ekibiniz ve görüşme özetleri tek yerde.",
    points: ["Her an temsilciye aktarma", "Görüşme özetleri hazır", "Tarayıcıdan çalışır"],
    lead: "Aynı hesapla Panel, CRM ve Temsilci ekranları arasında geçebilirsiniz.",
    email: "E-posta",
    emailPh: "adiniz@firmaniz.com",
    password: "Şifre",
    show: "Şifreyi göster",
    hide: "Şifreyi gizle",
    forgot: "Şifremi unuttum",
    forgotText:
      "Şifrenizi firmanızın panel yöneticisi sıfırlayabilir. Firmanızın yöneticisi sizseniz info@santralio.site adresine yazın.",
    submit: "Giriş yap",
    busy: "Giriş yapılıyor…",
    invite: "Davet e-postası mı aldınız? E-postadaki bağlantıyı açarak şifrenizi belirleyin.",
    bad: "E-posta veya şifre hatalı.",
    tooMany: "Çok fazla deneme yapıldı. 15 dakika sonra tekrar deneyin.",
    network: "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
    site: "santralio.site",
  },
  en: {
    title: { panel: "Log in to the panel", crm: "Log in to CRM", agent: "Log in to the agent desk" },
    console: { panel: "Admin panel", crm: "CRM", agent: "Agent desk" },
    pitch: "Manage your phone system and AI from one screen.",
    pitchSub: "Calls, queues, your team and call summaries in one place.",
    points: ["Hand over to an agent anytime", "Call summaries ready", "Works in the browser"],
    lead: "Use the same account to switch between Panel, CRM and Agent screens.",
    email: "Email",
    emailPh: "you@company.com",
    password: "Password",
    show: "Show password",
    hide: "Hide password",
    forgot: "Forgot password",
    forgotText:
      "Your company’s panel administrator can reset your password. If you are the administrator, write to info@santralio.site.",
    submit: "Log in",
    busy: "Logging in…",
    invite: "Got an invitation email? Open the link in it to set your password.",
    bad: "Incorrect email or password.",
    tooMany: "Too many attempts. Please try again in 15 minutes.",
    network: "Could not reach the server. Check your connection and try again.",
    site: "santralio.site",
  },
} as const;

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("santralio-lang");
    if (saved === "tr" || saved === "en") return saved;
  } catch {
    /* depolama kapalı olabilir */
  }
  return (navigator.language || "tr").toLowerCase().startsWith("tr") ? "tr" : "en";
}

function Wave() {
  return (
    <span className="auth-wave" aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

function Logo() {
  return (
    <span className="auth-logo">
      <span className="auth-mark" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M6 10v4M10 7v10M14 4v16M18 8v8" stroke="url(#authg)" strokeWidth="2.4" strokeLinecap="round" />
          <defs>
            <linearGradient id="authg" x1="6" y1="4" x2="18" y2="20" gradientUnits="userSpaceOnUse">
              <stop stopColor="#38BDF8" />
              <stop offset="1" stopColor="#2563EB" />
            </linearGradient>
          </defs>
        </svg>
      </span>
      <span className="auth-word">
        Santral<b>io</b>
      </span>
    </span>
  );
}

const Icon = {
  mail: <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  check: <path d="M5 12l5 5 9-10" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};
function Svg({ d, size = 18 }: { d: keyof typeof Icon; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {Icon[d]}
    </svg>
  );
}

export function Login({ app, onDone }: { app: AppName; onDone: () => void }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState<"" | "bad" | "tooMany" | "network">("");
  const [busy, setBusy] = useState(false);
  const t = T[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("santralio-lang", lang);
    } catch {
      /* yok say */
    }
  }, [lang]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(email, password);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError("tooMany");
      else if (err instanceof ApiError && err.status < 500) setError("bad");
      else setError("network");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-shell">
        <aside className="auth-brand">
          <div className="auth-brand-top">
            <Logo />
            <span className="auth-console">{t.console[app]}</span>
          </div>
          <div className="auth-pitch">
            <Wave />
            <p className="auth-pitch-h">{t.pitch}</p>
            <p className="auth-pitch-p">{t.pitchSub}</p>
            <ul className="auth-points">
              {t.points.map((p) => (
                <li key={p}>
                  <Svg d="check" size={16} />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="auth-form-wrap">
          <div className="auth-langs" role="group" aria-label="Dil / Language">
            {(["tr", "en"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          <form className="auth-form" onSubmit={submit} noValidate={false}>
            <h1>{t.title[app]}</h1>
            <p className="auth-lead">{t.lead}</p>

            <label className="auth-field">
              <span>{t.email}</span>
              <span className="auth-input">
                <Svg d="mail" />
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t.emailPh}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </span>
            </label>

            <label className="auth-field">
              <span>{t.password}</span>
              <span className="auth-input">
                <Svg d="lock" />
                <input
                  type={show ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="auth-eye"
                  aria-label={show ? t.hide : t.show}
                  aria-pressed={show}
                  onClick={() => setShow((s) => !s)}
                >
                  <Svg d={show ? "eyeOff" : "eye"} />
                </button>
              </span>
            </label>

            <div className="auth-row">
              <button type="button" className="auth-link" aria-expanded={forgot} onClick={() => setForgot((f) => !f)}>
                {t.forgot}
              </button>
            </div>
            {forgot && <p className="auth-note">{t.forgotText}</p>}

            <p className="auth-error" role="alert" aria-live="assertive">
              {error && t[error]}
            </p>

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? t.busy : t.submit}
              {!busy && <Svg d="arrow" />}
            </button>

            <p className="auth-invite">{t.invite}</p>
          </form>

          <footer className="auth-foot">
            <span>© 2026 Santralio</span>
            <a href="https://santralio.site">{t.site}</a>
          </footer>
        </section>
      </div>
    </div>
  );
}
