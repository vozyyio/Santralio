// Santralio: Vozyy lisansları. Davet sayfası (ilk yönetici şifresini belirler) ve platform yöneticisinin lisans listesi.

import { useEffect, useState, type FormEvent } from "react";
import { api, type VozyyLicense } from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// #/davet/<token>: token adreste kalır (sunucuya giden istek gövdesindedir, günlüğe ve Referer'a düşmez).
export function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; name: string; company: string } | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.inviteCheck(token).then(setInfo).catch(() => setInfo(null));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("Şifreler aynı değil.");
    setBusy(true);
    setError("");
    try {
      await api.inviteAccept(token, password);
      await api.login(info!.email, password);
      location.hash = "#/";
      onDone();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };
  if (info === undefined) return <div className="center muted">Yükleniyor…</div>;
  if (info === null)
    return (
      <div className="center">
        <div className="card login">
          <h1>Davet</h1>
          <p className="error">Davet bağlantısı geçersiz, kullanılmış ya da süresi dolmuş. Yeni bağlantı için bize ulaşın.</p>
          <a href="#/">Giriş sayfası</a>
        </div>
      </div>
    );
  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Santralio'ya hoş geldiniz</h1>
        <p className="muted">
          {info.company} için yönetici hesabınız hazır. Şifrenizi belirleyin; sonra Panel, CRM ve Temsilci ekranlarına bu hesapla girersiniz.
        </p>
        <label>
          E-posta
          <input type="email" autoComplete="username" value={info.email} readOnly />
        </label>
        <label>
          Yeni şifre (en az 10 karakter)
          <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          Yeni şifre (tekrar)
          <input type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Kaydediliyor…" : "Şifreyi belirle ve giriş yap"}</button>
      </form>
    </div>
  );
}

const STATUS: Record<string, string> = { active: "Etkin", suspended: "Askıda", cancelled: "İptal" };
const INSTALL: Record<string, string> = { provisioned: "Kuruldu", awaiting_install: "Kurulum bekleniyor" };

export function VozyyLicenses() {
  const [data, setData] = useState<{ configured: boolean; licenses: VozyyLicense[] } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    api.vozyyLicenses().then(setData).catch((e) => setError(msg(e)));
  }, []);
  const copy = (id: string, link: string) =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(id),
      () => setCopied(null),
    );
  return (
    <div className="card wide">
      <h3>Vozyy lisansları</h3>
      {error && <p className="error">{error}</p>}
      {data && !data.configured && (
        <p className="muted small">
          Vozyy imza anahtarı tanımlı değil; olay ucu 503 döner. Sunucuda: <span className="mono">sudo infra/set-secret.sh vozyy-signing</span>
        </p>
      )}
      {data && data.licenses.length === 0 && <p className="muted">Henüz lisans yok.</p>}
      {data && data.licenses.length > 0 && (
        <ul className="list">
          {data.licenses.map((l) => (
            <li key={l.licenseId}>
              <div>
                <strong>{l.company || l.licenseId}</strong> {l.prefix && <a href={`#/t/${l.prefix}`} className="mono">{l.prefix}</a>}{" "}
                <span className={`badge ${l.status === "active" ? "ok" : "off"}`}>{STATUS[l.status] ?? l.status}</span>{" "}
                <span className="badge">{INSTALL[l.installStatus] ?? l.installStatus}</span>
              </div>
              <div className="small muted">
                <span className="mono">{l.licenseId}</span> · {l.plan} · {l.installMode === "hosted" ? "bizde" : `kendi sunucusu: ${l.panelDomain}`}
                {l.slug && ` · kısa ad: ${l.slug}`} · {l.maxExtensions} dahili / {l.maxChannels} kanal
                {l.validUntil && ` · bitiş ${new Date(l.validUntil).toLocaleDateString("tr-TR")}`} · {l.email}
                {l.checkError && <span className="error"> · doğrulama: {l.checkError}</span>}
              </div>
              {l.invite && (
                <div className="small">
                  Davet {l.invite.sent ? "e-postayla gönderildi" : "gönderilmedi (e-posta yapılandırılmadı); bağlantıyı müşteriye iletin"}:{" "}
                  <button className="ghost" onClick={() => copy(l.licenseId, l.invite!.link)}>
                    {copied === l.licenseId ? "Kopyalandı" : "Bağlantıyı kopyala"}
                  </button>{" "}
                  <span className="muted">(son gün {new Date(l.invite.expiresAt).toLocaleDateString("tr-TR")})</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
