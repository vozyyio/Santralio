// Ödeme modülü ekranları:
// - PaymentsPage (Panel → Ödeme): banka/ödeme kuruluşu bağlama, SMS, ödeme profilleri, son ödemeler.
// - PaymentRequestBox (Temsilci masası): görüşme sırasında arayandan ödeme isteme ve canlı durum.
// Kimlik bilgileri bir kez girilir; sunucu bunları bir daha göndermez (gizli alanlar yalnızca "girildi" olarak görünür).

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type PayCatalogEntry, type PayProfile, type PayProfileLite, type PayProvider, type PayRequest, type PaySms } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const money = (amount: string, currency: string) =>
  `${Number(amount).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "TRY" ? "TL" : currency}`;
const when = (iso: string) => new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const PAY_STATUS: Record<PayRequest["status"], [string, "ok" | "off" | ""]> = {
  created: ["Oluşturuldu", ""],
  sent: ["Gönderildi", ""],
  paid: ["Ödendi", "ok"],
  failed: ["Başarısız", "off"],
  expired: ["Süresi doldu", "off"],
  cancelled: ["İptal", "off"],
};
const KIND: Record<PayCatalogEntry["kind"], string> = { psp: "Ödeme kuruluşları", bank: "Banka sanal POS", international: "Yurt dışı", test: "Deneme" };

export function PaymentsPage({ prefix }: { prefix: string }) {
  const [catalog, setCatalog] = useState<PayCatalogEntry[] | null>(null);
  const [data, setData] = useState<{ providers: PayProvider[]; profiles: PayProfile[]; sms: PaySms } | null>(null);
  const [requests, setRequests] = useState<PayRequest[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api.paySettings(prefix).then(setData).catch((e) => setError(err(e)));
    api.payRequests(prefix, { limit: 30 }).then(setRequests).catch(() => setRequests([]));
  }, [prefix]);
  useEffect(() => {
    api.payCatalog().then(setCatalog).catch((e) => setError(err(e)));
    load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!catalog || !data) return <p className="muted">Yükleniyor…</p>;
  return (
    <>
      <div className="card">
        <h2>Ödeme alma</h2>
        <p className="muted">
          Arayanlardan görüşme sırasında ödeme alabilirsiniz. Ödeme sizin bankanızın ya da ödeme kuruluşunuzun güvenli sayfasında yapılır; para doğrudan sizin hesabınıza geçer,
          kart bilgisi Santralio'ya gelmez. Önce kullandığınız kuruluşu bağlayın, sonra ödeme profillerini tanımlayın.
        </p>
      </div>
      <Providers prefix={prefix} catalog={catalog} providers={data.providers} onChange={load} />
      <SmsCard prefix={prefix} sms={data.sms} providers={data.providers} catalog={catalog} onChange={load} />
      <Profiles prefix={prefix} profiles={data.profiles} providers={data.providers} onChange={load} />
      <RequestsCard prefix={prefix} requests={requests} onChange={load} />
    </>
  );
}

function Providers({ prefix, catalog, providers, onChange }: { prefix: string; catalog: PayCatalogEntry[]; providers: PayProvider[]; onChange: () => void }) {
  const [adding, setAdding] = useState<PayCatalogEntry | null>(null);
  const [editing, setEditing] = useState<PayProvider | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<Record<number, string>>({});
  const test = async (p: PayProvider) => {
    setBusy(p.id);
    try {
      const r = await api.payTestProvider(prefix, p.id);
      setMsg((m) => ({ ...m, [p.id]: r.ok ? "Bağlantı başarılı." : `Bağlantı kurulamadı: ${r.error}` }));
      onChange();
    } catch (e) {
      setMsg((m) => ({ ...m, [p.id]: err(e) }));
    } finally {
      setBusy(null);
    }
  };
  const groups = (["psp", "bank", "international", "test"] as const).map((k) => [k, catalog.filter((c) => c.kind === k)] as const);
  return (
    <div className="card">
      <h2>Banka ve ödeme kuruluşları</h2>
      {providers.length === 0 && <p className="muted">Henüz bağlı bir kuruluş yok.</p>}
      {providers.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Kuruluş</th>
              <th>Mod</th>
              <th>Durum</th>
              <th>Son test</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.label}</strong> <span className="muted small">{p.name}</span> {p.isDefault && <span className="badge ok">Varsayılan</span>}
                  {msg[p.id] && <div className="small">{msg[p.id]}</div>}
                </td>
                <td>{p.mode === "live" ? <span className="badge ok">Canlı</span> : <span className="badge off">Test</span>}</td>
                <td>{p.enabled ? "Açık" : "Kapalı"}</td>
                <td className="small">{p.lastTest ? `${p.lastTest.ok ? "Başarılı" : "Başarısız"} · ${when(p.lastTest.at)}` : "—"}</td>
                <td>
                  <div className="row">
                    <button className="ghost" disabled={busy === p.id} onClick={() => test(p)}>
                      {busy === p.id ? "Deneniyor…" : "Bağlantıyı test et"}
                    </button>
                    <button className="ghost" onClick={() => setEditing(p)}>
                      Düzenle
                    </button>
                    {!p.isDefault && p.enabled && (
                      <button className="ghost" onClick={() => api.payUpdateProvider(prefix, p.id, { isDefault: true }).then(onChange)}>
                        Varsayılan yap
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <ProviderForm
          prefix={prefix}
          entry={catalog.find((c) => c.id === editing.provider)!}
          existing={editing}
          onDone={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}
      {!adding && !editing && (
        <>
          <h3 style={{ marginTop: 18 }}>Kuruluş ekle</h3>
          {groups.map(([k, list]) =>
            list.length ? (
              <div key={k} style={{ marginBottom: 10 }}>
                <h4>{KIND[k]}</h4>
                <div className="row">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      className="ghost"
                      disabled={c.status !== "available"}
                      title={c.banks?.length ? `Bu altyapıyı kullanan bankalar: ${c.banks.join(", ")}` : undefined}
                      onClick={() => setAdding(c)}
                    >
                      {c.name}
                      {c.status !== "available" && " · yakında"}
                    </button>
                  ))}
                </div>
              </div>
            ) : null,
          )}
          <p className="muted small">Bankanızın hangi altyapıyı kullandığını bilmiyorsanız bankanızın sanal POS birimine sorun. Bankalar zamanla altyapı değiştirebilir.</p>
        </>
      )}
      {adding && (
        <ProviderForm
          prefix={prefix}
          entry={adding}
          onDone={() => {
            setAdding(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function ProviderForm({ prefix, entry, existing, onDone }: { prefix: string; entry: PayCatalogEntry; existing?: PayProvider; onDone: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? entry.name);
  const [mode, setMode] = useState<"test" | "live">(existing?.mode ?? "test");
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.fields.map((f) => [f.key, !f.secret && typeof existing?.fields[f.key] === "string" ? String(existing.fields[f.key]) : ""])),
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (existing) await api.payUpdateProvider(prefix, existing.id, { label, mode, credentials: vals, enabled });
      else await api.payAddProvider(prefix, { provider: entry.id, label, mode, credentials: vals });
      onDone();
    } catch (e2) {
      setError(err(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="tile" style={{ marginTop: 14, padding: 16 }} onSubmit={submit}>
      <h3>
        {entry.name} {existing ? "ayarları" : "bağla"}
      </h3>
      {entry.docs && (
        <p className="muted small">
          Bilgileri kuruluşun mağaza / üye işyeri panelinden alabilirsiniz.{" "}
          <a href={entry.docs} target="_blank" rel="noreferrer">
            Belgeler
          </a>
        </p>
      )}
      <label>
        Görünen ad
        <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} />
      </label>
      {entry.kind !== "test" && (
        <label>
          Mod
          <select value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
            <option value="test">Test (gerçek para hareketi yok)</option>
            <option value="live">Canlı</option>
          </select>
        </label>
      )}
      {entry.fields.map((f) => (
        <label key={f.key}>
          {f.label}
          <input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={vals[f.key] ?? ""}
            placeholder={f.secret && existing?.fields[f.key] === true ? "Girildi · değiştirmek için yazın" : ""}
            onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      {existing && (
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Açık
        </label>
      )}
      {mode === "live" && <p className="small">Canlıya almadan önce test modunda bir deneme ödemesi yapmanızı öneririz.</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={busy}>{busy ? "Kaydediliyor…" : "Kaydet"}</button>
        <button type="button" className="ghost" onClick={onDone}>
          Vazgeç
        </button>
        {existing && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!confirm(`${existing.label} kaldırılsın mı? Geçmiş ödemeler korunur.`)) return;
              await api.payDeleteProvider(prefix, existing.id).catch((e2) => setError(err(e2)));
              onDone();
            }}
          >
            Kaldır
          </button>
        )}
      </div>
    </form>
  );
}

function SmsCard({ prefix, sms, providers, catalog, onChange }: { prefix: string; sms: PaySms; providers: PayProvider[]; catalog: PayCatalogEntry[]; onChange: () => void }) {
  const [sender, setSender] = useState(sms.sender);
  const [vals, setVals] = useState({ usercode: String(sms.fields.usercode ?? ""), password: "", msgheader: String(sms.fields.msgheader ?? "") });
  const [msg, setMsg] = useState("");
  const def = providers.find((p) => p.isDefault);
  const providerSms = def ? catalog.find((c) => c.id === def.provider)?.features.providerSms : false;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      await api.paySaveSms(prefix, { sender, credentials: sender === "netgsm" ? vals : undefined });
      setMsg("Kaydedildi.");
      onChange();
    } catch (e2) {
      setMsg(err(e2));
    }
  };
  return (
    <form className="card" onSubmit={save}>
      <h2>Ödeme bağlantısı SMS'i</h2>
      <label>
        Bağlantı nasıl gönderilsin?
        <select value={sender} onChange={(e) => setSender(e.target.value as PaySms["sender"])}>
          <option value="provider">Ödeme kuruluşunun kendi SMS'i{def && !providerSms ? " (varsayılan kuruluş desteklemiyor)" : ""}</option>
          <option value="netgsm">Kendi Netgsm SMS hesabım</option>
          <option value="none">SMS gönderme (bağlantıyı temsilci iletir)</option>
        </select>
      </label>
      {sender === "netgsm" && (
        <div className="grid">
          <label>
            Netgsm kullanıcı kodu
            <input value={vals.usercode} onChange={(e) => setVals({ ...vals, usercode: e.target.value })} inputMode="numeric" />
          </label>
          <label>
            API şifresi
            <input type="password" autoComplete="off" value={vals.password} placeholder={sms.fields.password ? "Girildi · değiştirmek için yazın" : ""} onChange={(e) => setVals({ ...vals, password: e.target.value })} />
          </label>
          <label>
            SMS başlığı (onaylı gönderici adı)
            <input value={vals.msgheader} maxLength={11} onChange={(e) => setVals({ ...vals, msgheader: e.target.value })} />
          </label>
        </div>
      )}
      <p className="muted small">Bu SMS bir işlem bildirimidir (ticari ileti değildir); yalnızca ödeme bilgisini ve bağlantıyı içerir.</p>
      <div className="row">
        <button>Kaydet</button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </form>
  );
}

const EMPTY_PROFILE: PayProfile = {
  name: "",
  title: "",
  providerId: null,
  amountSource: "agent",
  fixedAmount: null,
  maxAmount: "5000.00",
  currency: "TRY",
  lookupUrl: null,
  methods: "link",
  maxInstallment: 1,
  expiresMinutes: 60,
  askText: "",
  smsText: "",
  successText: "",
  enabled: true,
};
const SOURCE: Record<PayProfile["amountSource"], string> = { fixed: "Sabit tutar", agent: "Temsilci girer", lookup: "Kendi sistemimden sorgulanır" };

function Profiles({ prefix, profiles, providers, onChange }: { prefix: string; profiles: PayProfile[]; providers: PayProvider[]; onChange: () => void }) {
  const [edit, setEdit] = useState<PayProfile | null>(null);
  return (
    <div className="card">
      <h2>Ödeme profilleri</h2>
      <p className="muted small">
        Örnek: "Rezervasyon kaporası" (sabit 1.500 TL), "Fatura tahsilatı" (tutar kendi sisteminizden). Yapay zekâ ve sesli menü yalnızca sabit ya da sorgulanan tutarları kullanabilir.
      </p>
      {profiles.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Profil</th>
              <th>Tutar</th>
              <th>Üst sınır</th>
              <th>Yöntem</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.name} className={p.enabled ? "" : "muted"}>
                <td>
                  <strong>{p.title}</strong> <span className="mono small muted">{p.name}</span>
                </td>
                <td>{p.amountSource === "fixed" && p.fixedAmount ? money(p.fixedAmount, p.currency) : SOURCE[p.amountSource]}</td>
                <td>{money(p.maxAmount, p.currency)}</td>
                <td>{p.methods === "link" ? "Bağlantı" : p.methods === "dtmf" ? "Tuşlama" : "Bağlantı veya tuşlama"}</td>
                <td>
                  <button className="ghost" onClick={() => setEdit(p)}>
                    Düzenle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!edit && (
        <button className="ghost" disabled={!providers.length} onClick={() => setEdit({ ...EMPTY_PROFILE })}>
          Profil ekle
        </button>
      )}
      {!providers.length && <p className="muted small">Profil eklemek için önce bir kuruluş bağlayın.</p>}
      {edit && (
        <ProfileForm
          prefix={prefix}
          profile={edit}
          providers={providers}
          onDone={() => {
            setEdit(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function ProfileForm({ prefix, profile, providers, onDone }: { prefix: string; profile: PayProfile; providers: PayProvider[]; onDone: () => void }) {
  const [p, setP] = useState<PayProfile>(profile);
  const [error, setError] = useState("");
  const isNew = !profile.name;
  const set = <K extends keyof PayProfile>(k: K, v: PayProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.paySaveProfile(prefix, p.name, p);
      onDone();
    } catch (e2) {
      setError(err(e2));
    }
  };
  return (
    <form className="tile" style={{ marginTop: 14, padding: 16 }} onSubmit={submit}>
      <div className="grid">
        <label>
          Başlık (müşteriye görünür)
          <input value={p.title} onChange={(e) => set("title", e.target.value)} required minLength={4} maxLength={120} />
        </label>
        <label>
          Kısa ad
          <input value={p.name} disabled={!isNew} onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} required pattern="[a-z0-9_]{1,32}" />
        </label>
        <label>
          Tutar
          <select value={p.amountSource} onChange={(e) => set("amountSource", e.target.value as PayProfile["amountSource"])}>
            {Object.entries(SOURCE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {p.amountSource === "fixed" && (
          <label>
            Sabit tutar
            <input value={p.fixedAmount ?? ""} onChange={(e) => set("fixedAmount", e.target.value)} inputMode="decimal" placeholder="1500.00" required />
          </label>
        )}
        {p.amountSource === "lookup" && (
          <label>
            Sorgu adresi (https)
            <input value={p.lookupUrl ?? ""} onChange={(e) => set("lookupUrl", e.target.value)} placeholder="https://sisteminiz.com/santralio/borc" required />
          </label>
        )}
        <label>
          Üst sınır
          <input value={p.maxAmount} onChange={(e) => set("maxAmount", e.target.value)} inputMode="decimal" required />
        </label>
        <label>
          Para birimi
          <select value={p.currency} onChange={(e) => set("currency", e.target.value)}>
            {["TRY", "EUR", "USD", "GBP"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Kuruluş
          <select value={p.providerId ?? ""} onChange={(e) => set("providerId", e.target.value ? Number(e.target.value) : null)}>
            <option value="">Varsayılan</option>
            {providers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          En fazla taksit
          <input type="number" min={1} max={12} value={p.maxInstallment} onChange={(e) => set("maxInstallment", Number(e.target.value))} />
        </label>
        <label>
          Bağlantı geçerliliği (dakika)
          <input type="number" min={5} max={10080} value={p.expiresMinutes} onChange={(e) => set("expiresMinutes", Number(e.target.value))} />
        </label>
        <label>
          Yöntem
          <select value={p.methods} onChange={(e) => set("methods", e.target.value as PayProfile["methods"])}>
            <option value="link">Ödeme bağlantısı</option>
            <option value="both">Arayana sor: bağlantı ya da tuşlama</option>
            <option value="dtmf">Yalnızca tuşlama</option>
          </select>
        </label>
      </div>
      {p.methods !== "link" && (
        <p className="small">
          Tuşlamayla ödeme yalnızca güvenli tuşlama hizmeti sunan kuruluşlarda ve bankanızdan MOTO (3D'siz) yetkisi aldıktan sonra açılabilir. Henüz hiçbir kuruluşta açık değil; o zamana kadar bu profil
          talep oluşturamaz, "Ödeme bağlantısı" seçin.
        </p>
      )}
      {p.amountSource === "lookup" && (
        <p className="muted small">
          Santralio bu adrese <span className="mono">{`{ "phone": "+90…", "call_id": "…", "reference": "pay_…" }`}</span> gönderir; sisteminiz{" "}
          <span className="mono">{`{ "amount": "750.00", "description": "…" }`}</span> döner.
        </p>
      )}
      <label>
        Arayana soru (sesli; boşsa hazır metin)
        <input value={p.askText} maxLength={400} onChange={(e) => set("askText", e.target.value)} placeholder="Ödemeniz {tutar}. SMS ile bağlantı için 1'e, kartla tuşlamak için 2'ye basın." />
      </label>
      <label>
        SMS metni (boşsa hazır metin; bağlantı sona eklenir)
        <input value={p.smsText} maxLength={300} onChange={(e) => set("smsText", e.target.value)} placeholder="{firma}: {aciklama} için {tutar} ödemeniz:" />
      </label>
      <label className="check">
        <input type="checkbox" checked={p.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Açık
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button>Kaydet</button>
        <button type="button" className="ghost" onClick={onDone}>
          Vazgeç
        </button>
      </div>
    </form>
  );
}

function RequestsCard({ prefix, requests, onChange }: { prefix: string; requests: PayRequest[] | null; onChange: () => void }) {
  return (
    <div className="card">
      <h2>Son ödemeler</h2>
      {!requests ? (
        <p className="muted">Yükleniyor…</p>
      ) : requests.length === 0 ? (
        <p className="muted">Henüz ödeme talebi yok.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Açıklama</th>
              <th>Tutar</th>
              <th>Telefon</th>
              <th>Durum</th>
              <th>İsteyen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="small">{when(r.createdAt)}</td>
                <td>
                  {r.description} {r.mode === "test" && <span className="badge off">Test</span>}
                  {r.error && <div className="small error">{r.error}</div>}
                </td>
                <td>{money(r.amount, r.currency)}</td>
                <td className="mono small">{r.phone ?? "—"}</td>
                <td>
                  <span className={`badge ${PAY_STATUS[r.status][1]}`}>{PAY_STATUS[r.status][0]}</span>
                </td>
                <td className="small">{r.createdBy === "agent" ? (r.createdByUser ?? "Temsilci") : r.createdBy === "ai" ? "Yapay zekâ" : r.createdBy === "ivr" ? "Sesli menü" : "API"}</td>
                <td>
                  {(r.status === "created" || r.status === "sent") && (
                    <button className="ghost" onClick={() => api.payCancel(prefix, r.id).then(onChange)}>
                      İptal
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Temsilci masası: görüşme sırasında ödeme iste ---

export function PaymentRequestBox({ prefix, phone, callId }: { prefix: string; phone: string; callId: string | null }) {
  const [profiles, setProfiles] = useState<PayProfileLite[] | null>(null);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [to, setTo] = useState(phone);
  const [req, setReq] = useState<PayRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !profiles)
      api
        .payProfiles(prefix)
        .then((ps) => {
          const usable = ps.filter((p) => p.methods !== "dtmf");
          setProfiles(usable);
          if (usable[0]) setProfile(usable[0].name);
        })
        .catch((e) => setError(err(e)));
  }, [open, prefix, profiles]);

  // Bağlantı gönderildikten sonra durum birkaç saniyede bir yenilenir (ödendiğinde ekranda görünür).
  useEffect(() => {
    if (!req || !["created", "sent"].includes(req.status)) return;
    const id = window.setInterval(() => api.payRequest(prefix, req.id).then(setReq).catch(() => {}), 4000);
    return () => window.clearInterval(id);
  }, [prefix, req]);

  const sel = profiles?.find((p) => p.name === profile);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setReq(await api.payCreate(prefix, { profile: profile || undefined, amount: sel?.amountSource === "agent" ? amount : undefined, description: description || undefined, phone: to, callId }));
    } catch (e2) {
      setError(err(e2));
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        Ödeme iste
      </button>
    );
  if (req)
    return (
      <div className="transfer">
        <p>
          <strong>{money(req.amount, req.currency)}</strong> · {req.description} <span className={`badge ${PAY_STATUS[req.status][1]}`}>{PAY_STATUS[req.status][0]}</span>
        </p>
        {req.status === "failed" && <p className="small error">{req.error ?? "Ödeme bağlantısı oluşturulamadı."}</p>}
        {req.smsStatus === "sent" && req.status === "sent" && <p className="small">Bağlantı {req.phone} numarasına SMS ile gönderildi. Müşteri hatta kalarak ödeyebilir.</p>}
        {req.smsStatus === "failed" && <p className="small error">SMS gönderilemedi: {req.error}. Bağlantıyı başka yoldan iletebilirsiniz.</p>}
        {(req.status === "created" || req.status === "sent") && req.linkUrl && (
          <p className="small">
            Bağlantı: <span className="mono">{req.linkUrl}</span>{" "}
            <button type="button" className="ghost" onClick={() => navigator.clipboard?.writeText(req.linkUrl!)}>
              Kopyala
            </button>
          </p>
        )}
        {req.status === "paid" && <p className="small">Ödeme alındı{req.cardLast4 ? ` (**** ${req.cardLast4})` : ""}. Müşteriye teşekkür edebilirsiniz.</p>}
        <div className="row">
          {["created", "sent"].includes(req.status) && (
            <button className="ghost" onClick={() => api.payCancel(prefix, req.id).then(() => api.payRequest(prefix, req.id).then(setReq))}>
              İptal et
            </button>
          )}
          <button className="ghost" onClick={() => setReq(null)}>
            Yeni ödeme
          </button>
          <button className="ghost" onClick={() => setOpen(false)}>
            Kapat
          </button>
        </div>
      </div>
    );
  return (
    <form className="transfer" onSubmit={submit}>
      <p className="muted small">Arayana güvenli ödeme bağlantısı SMS ile gider; ödeme yapılınca burada görünür.</p>
      {!profiles ? (
        <p className="muted small">Yükleniyor…</p>
      ) : profiles.length === 0 ? (
        <p className="small">Ödeme profili tanımlı değil. Yöneticiniz Panel → Ödeme'den ekleyebilir.</p>
      ) : (
        <>
          <label>
            Ödeme türü
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.title}
                  {p.amountSource === "fixed" && p.fixedAmount ? ` · ${money(p.fixedAmount, p.currency)}` : ""}
                </option>
              ))}
            </select>
          </label>
          {sel?.amountSource === "agent" && (
            <label>
              Tutar (en fazla {money(sel.maxAmount, sel.currency)})
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1500.00" required />
            </label>
          )}
          <label>
            Açıklama (isteğe bağlı)
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder={sel?.title} />
          </label>
          <label>
            Cep telefonu
            <input value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" required />
          </label>
          <div className="row">
            <button disabled={busy}>{busy ? "Gönderiliyor…" : "Bağlantıyı gönder"}</button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Vazgeç
            </button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
