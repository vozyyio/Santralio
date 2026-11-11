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


// Santral çizimi: gelen çağrı → santral merkezi → yapay zekâ ve temsilciler. Yalnızca süs (aria-hidden).
const PHONE =
  "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z";
const HEADSET = "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3";
const SPARK = "M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z";

function Glyph({ d, x, y, size = 24, color, fill = false }: { d: string; x: number; y: number; size?: number; color: string; fill?: boolean }) {
  const k = size / 24;
  return (
    <path
      d={d}
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${k})`}
      fill={fill ? color : "none"}
      stroke={color}
      strokeWidth={2 / k > 2.6 ? 2.6 : 2 / k}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function PbxArt() {
  const agents = [
    { x: 300, y: 54, on: true },
    { x: 316, y: 124, on: false },
    { x: 300, y: 194, on: false },
  ];
  return (
    <svg className="auth-art" viewBox="0 0 360 250" aria-hidden="true">
      <defs>
        <linearGradient id="artHub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563EB" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
        <linearGradient id="artBars" x1="164" y1="100" x2="194" y2="148" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
        <radialGradient id="artGlow">
          <stop offset="0" stopColor="#22D3EE" stopOpacity="0.35" />
          <stop offset="1" stopColor="#22D3EE" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* bağlantılar */}
      <path className="auth-art-flow" d="M70 124 H136" />
      <path className="auth-art-line" d="M180 124 L118 52" />
      {agents.map((a) => (
        <path key={a.y} className={a.on ? "auth-art-flow auth-art-flow-on" : "auth-art-line"} d={`M224 124 Q262 ${a.y} ${a.x - 22} ${a.y}`} />
      ))}

      {/* gelen çağrı */}
      <circle cx="46" cy="124" r="24" className="auth-art-node" />
      <Glyph d={PHONE} x={46} y={124} size={20} color="#38BDF8" />
      <g className="auth-art-bars">
        <rect x="80" y="104" width="3" height="10" rx="1.5" />
        <rect x="86" y="100" width="3" height="18" rx="1.5" />
        <rect x="92" y="106" width="3" height="6" rx="1.5" />
        <rect x="98" y="102" width="3" height="14" rx="1.5" />
      </g>

      {/* yapay zekâ */}
      <circle cx="110" cy="44" r="20" className="auth-art-node" />
      <Glyph d={SPARK} x={110} y={44} size={20} color="#22D3EE" fill />

      {/* santral merkezi */}
      <circle cx="180" cy="124" r="70" fill="url(#artGlow)" />
      <circle cx="180" cy="124" r="52" className="auth-art-ring" />
      <circle cx="180" cy="124" r="44" fill="#080D19" stroke="url(#artHub)" strokeWidth="2.5" />
      <g className="auth-art-hub-bars" stroke="url(#artBars)" strokeWidth="5" strokeLinecap="round">
        <line x1="164" y1="116" x2="164" y2="132" />
        <line x1="174" y1="106" x2="174" y2="142" />
        <line x1="184" y1="100" x2="184" y2="148" />
        <line x1="194" y1="110" x2="194" y2="138" />
      </g>

      {/* temsilciler */}
      {agents.map((a) => (
        <g key={a.y}>
          <circle cx={a.x} cy={a.y} r="22" className={a.on ? "auth-art-node auth-art-node-on" : "auth-art-node"} />
          <Glyph d={HEADSET} x={a.x} y={a.y} size={20} color={a.on ? "#34D399" : "#7C8CA3"} />
          {a.on && <circle cx={a.x + 16} cy={a.y - 16} r="5" fill="#34D399" stroke="#0C1426" strokeWidth="2.5" />}
        </g>
      ))}
    </svg>
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
          <PbxArt />
          <div className="auth-pitch">
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
