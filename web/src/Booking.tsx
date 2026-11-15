// Rezervasyon: panelde bağlantı ve hizmetler (Santral → Rezervasyon), CRM'de gelen rezervasyonlar (CRM → Rezervasyonlar).
// Yapay zekâ (telefon, web sohbeti) hizmet bilgilerini sorar; fiyat ve müsaitliği bu bağlantı söyler.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BookingField, type BookingFieldType, type BookingQuote, type BookingRow, type BookingService, type BookingSettings } from "./api";
import { SecretBox } from "./Webhooks";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");

const FIELD_TYPES: [BookingFieldType, string][] = [
  ["text", "Metin"],
  ["date", "Tarih"],
  ["time", "Saat"],
  ["datetime", "Tarih ve saat"],
  ["number", "Sayı"],
  ["phone", "Telefon"],
  ["choice", "Seçenek"],
];
const PAYMENT: [BookingService["payment"], string][] = [
  ["none", "Ödeme alınmaz"],
  ["optional", "Arayan isterse ödeme bağlantısı"],
  ["required", "Ödeme bağlantısı her zaman"],
];
const CURRENCIES = ["TRY", "EUR", "USD", "GBP"];

// Türkçe etiketten kısa ad: "Kişi sayısı" -> "kisi_sayisi"
const slug = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

const f = (label: string, type: BookingFieldType, extra: Partial<BookingField> = {}): BookingField => ({ key: slug(label), label, type, required: true, ...extra });

// Hazır şablonlar: boş başlamak yerine sektöre göre bir başlangıç.
const TEMPLATES: { name: string; service: BookingService }[] = [
  {
    name: "Havalimanı transferi",
    service: {
      key: "transfer",
      label: "Havalimanı transferi",
      description: "Havalimanından otele ya da otelden havalimanına özel transfer",
      fields: [f("Yön", "choice", { choices: ["Havalimanından otele", "Otelden havalimanına"] }), f("Tarih", "date"), f("Saat", "time"), f("Kişi sayısı", "number"), f("Uçuş numarası", "text", { required: false }), f("Otel adı", "text")],
      price: null,
      currency: "EUR",
      payment: "optional",
    },
  },
  {
    name: "Oda rezervasyonu",
    service: {
      key: "oda",
      label: "Oda rezervasyonu",
      description: "Konaklama talebi",
      fields: [f("Giriş tarihi", "date"), f("Çıkış tarihi", "date"), f("Yetişkin", "number"), f("Çocuk", "number", { required: false }), f("Oda tipi", "choice", { choices: ["Standart", "Aile", "Suit"] })],
      price: null,
      currency: "TRY",
      payment: "optional",
    },
  },
  {
    name: "Araç kiralama",
    service: {
      key: "arac",
      label: "Araç kiralama",
      description: "Günlük araç kiralama",
      fields: [f("Alış tarihi", "datetime"), f("İade tarihi", "datetime"), f("Alış yeri", "text"), f("Araç sınıfı", "choice", { choices: ["Ekonomik", "Orta", "SUV", "Minivan"] })],
      price: null,
      currency: "TRY",
      payment: "required",
    },
  },
  {
    name: "Randevu",
    service: {
      key: "randevu",
      label: "Randevu",
      description: "Muayene / görüşme randevusu",
      fields: [f("Tarih", "date"), f("Saat", "time"), f("Bölüm", "text", { required: false })],
      price: null,
      currency: "TRY",
      payment: "none",
    },
  },
];

const emptyService = (n: number): BookingService => ({
  key: `hizmet${n}`,
  label: "",
  description: "",
  fields: [f("Tarih", "date")],
  price: null,
  currency: "TRY",
  payment: "none",
});

// --- Panel: bağlantı ve hizmetler ---

export function BookingSettingsPage({ prefix }: { prefix: string }) {
  const [s, setS] = useState<BookingSettings | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const load = useCallback(() => api.bookingSettings(prefix).then((r) => (setS(r), setDirty(false)), (e) => setError(err(e))), [prefix]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Yükleniyor…</p>;

  const edit = (patch: Partial<BookingSettings>) => {
    setS({ ...s, ...patch });
    setDirty(true);
    setNote(null);
  };
  const setService = (i: number, svc: BookingService | null) =>
    edit({ services: svc ? s.services.map((x, j) => (j === i ? svc : x)) : s.services.filter((_, j) => j !== i) });
  const save = () =>
    api.bookingSave(prefix, { mode: s.mode, apiUrl: s.apiUrl, services: s.services }).then(
      (r) => {
        setS(r);
        setDirty(false);
        if (r.secret) setSecret(r.secret);
        setNote({ text: "Kaydedildi.", ok: true });
      },
      (e) => setNote({ text: err(e), ok: false }),
    );

  return (
    <>
      <div className="card">
        <h2>Rezervasyon</h2>
        <p className="muted small">
          Yapay zekâ asistanı telefonda (ve web sitenizdeki sohbette) rezervasyon alır: hizmeti ve gerekli bilgileri sorar, fiyatı ve müsaitliği buradaki
          bağlantıdan öğrenir, arayana özetleyip onay alır ve rezervasyonu oluşturur. Asistan fiyatı kendisi belirlemez.
        </p>
        <div className="mode-pick">
          {(
            [
              ["off", "Kapalı", "Asistan rezervasyon almaz."],
              ["builtin", "Santralio'da tut", "Otomasyon sisteminiz yoksa. Rezervasyonlar CRM → Rezervasyonlar'a düşer; ekibiniz onaylar. Fiyat hizmette yazılıysa söylenir."],
              ["api", "Kendi sistemime bağla", "Otomasyon / rezervasyon yazılımınız varsa. Müsaitlik, fiyat ve kayıt sizin sisteminizden; Santralio imzalı istek gönderir."],
            ] as const
          ).map(([v, title, desc]) => (
            <label key={v} className={`mode-option ${s.mode === v ? "on" : ""}`}>
              <input type="radio" name="booking-mode" checked={s.mode === v} onChange={() => edit({ mode: v })} />
              <span>
                <strong>{title}</strong>
                <span className="small muted">{desc}</span>
              </span>
            </label>
          ))}
        </div>
        {s.mode === "api" && (
          <>
            <label>
              Sisteminizin adresi (https)
              <input value={s.apiUrl ?? ""} placeholder="https://otomasyon.firmaniz.com/santralio/rezervasyon" onChange={(e) => edit({ apiUrl: e.target.value })} />
            </label>
            <p className="muted small">
              Santralio bu adrese <span className="mono">quote</span> (müsaitlik ve fiyat), <span className="mono">create</span>,{" "}
              <span className="mono">lookup</span> (arayanın rezervasyonları) ve <span className="mono">cancel</span> isteklerini JSON olarak gönderir.
              İstekler webhook'larla aynı biçimde imzalanır (<span className="mono">X-Santralio-Signature</span>). Ayrıntılar: Santralio rezervasyon
              sözleşmesi belgesi.
            </p>
          </>
        )}
        {secret && <SecretBox value={secret} onClose={() => setSecret(null)} />}
        <div className="actions">
          <button onClick={save} disabled={!dirty}>
            Kaydet
          </button>
          {s.mode === "api" && s.hasSecret && !dirty && (
            <>
              <button className="ghost" onClick={() => api.bookingTest(prefix).then((r) => setNote({ text: r.ok ? "Bağlantı çalışıyor." : "Sistem yanıt verdi ama biçim beklenen gibi değil.", ok: r.ok }), (e) => setNote({ text: err(e), ok: false }))}>
                Bağlantıyı test et
              </button>
              <button
                className="ghost"
                onClick={() => {
                  if (!confirm("Yeni imza anahtarı üretilsin mi? Sisteminizdeki anahtarı da değiştirmeniz gerekir.")) return;
                  api.bookingRotate(prefix).then((r) => setSecret(r.secret), (e) => setNote({ text: err(e), ok: false }));
                }}
              >
                Anahtarı yenile
              </button>
            </>
          )}
          {dirty && <span className="small muted">Kaydedilmemiş değişiklik var</span>}
          {note && <span className={`small ${note.ok ? "ok-text" : "error"}`}>{note.text}</span>}
        </div>
      </div>

      <div className="card">
        <div className="row spread svc-head">
          <h3>Hizmetler</h3>
          {s.services.length < 20 && (
            <div className="row wrap-actions">
              <select
                value=""
                onChange={(e) => {
                  const t = TEMPLATES.find((x) => x.name === e.target.value);
                  if (!t) return;
                  let key = t.service.key;
                  for (let n = 2; s.services.some((x) => x.key === key); n++) key = `${t.service.key}${n}`;
                  edit({ services: [...s.services, { ...t.service, key }] });
                }}
              >
                <option value="">Şablondan ekle…</option>
                {TEMPLATES.map((t) => (
                  <option key={t.name}>{t.name}</option>
                ))}
              </select>
              <button className="ghost" onClick={() => edit({ services: [...s.services, emptyService(s.services.length + 1)] })}>
                + Boş hizmet
              </button>
            </div>
          )}
        </div>
        <p className="muted small">
          Asistan, arayanın istediği hizmeti seçer ve buradaki bilgileri sırayla sorar. Kısa adlar sisteminize giden istekte alan adı olarak kullanılır.
        </p>
        {s.services.length === 0 ? (
          <div className="empty-state">
            <p>Henüz hizmet yok.</p>
            <p className="small muted">Yukarıdan bir şablon seçin (transfer, oda, araç kiralama, randevu) ya da boş bir hizmetle başlayın.</p>
          </div>
        ) : (
          s.services.map((svc, i) => <ServiceEditor key={i} svc={svc} onChange={(v) => setService(i, v)} />)
        )}
        {dirty && s.services.length > 0 && (
          <div className="actions">
            <button onClick={save}>Kaydet</button>
          </div>
        )}
      </div>

      {s.mode !== "off" && s.services.length > 0 && !dirty && <QuoteTry prefix={prefix} services={s.services} />}
    </>
  );
}

function ServiceEditor({ svc, onChange }: { svc: BookingService; onChange: (s: BookingService | null) => void }) {
  const set = (p: Partial<BookingService>) => onChange({ ...svc, ...p });
  const setField = (i: number, p: Partial<BookingField> | null) =>
    set({ fields: p ? svc.fields.map((x, j) => (j === i ? { ...x, ...p } : x)) : svc.fields.filter((_, j) => j !== i) });
  return (
    <div className="service-box">
      <div className="form-grid">
        <label>
          Hizmet adı
          <input value={svc.label} placeholder="Havalimanı transferi" onChange={(e) => set({ label: e.target.value })} maxLength={80} />
        </label>
        <label>
          Kısa ad
          <input className="mono" value={svc.key} onChange={(e) => set({ key: slug(e.target.value) })} maxLength={32} />
        </label>
        <label className="span2">
          Açıklama (asistan için)
          <input value={svc.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} />
        </label>
        <label>
          Sabit fiyat (boş: sisteminiz söyler / ekip teyit eder)
          <input inputMode="decimal" value={svc.price ?? ""} placeholder="ör. 85.00" onChange={(e) => set({ price: e.target.value.trim() || null })} />
        </label>
        <label>
          Para birimi
          <select value={svc.currency} onChange={(e) => set({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="span2">
          Ödeme
          <select value={svc.payment} onChange={(e) => set({ payment: e.target.value as BookingService["payment"] })}>
            {PAYMENT.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h4>Sorulacak bilgiler</h4>
      <ul className="field-list">
        {svc.fields.map((fl, i) => (
          <li key={i}>
            <input
              value={fl.label}
              placeholder="Etiket"
              aria-label="Etiket"
              onChange={(e) => setField(i, { label: e.target.value, ...(fl.key === slug(fl.label) || !fl.key ? { key: slug(e.target.value) } : {}) })}
            />
            <input className="mono" value={fl.key} aria-label="Kısa ad" onChange={(e) => setField(i, { key: slug(e.target.value) })} />
            <select value={fl.type} aria-label="Tür" onChange={(e) => setField(i, { type: e.target.value as BookingFieldType, choices: e.target.value === "choice" ? (fl.choices ?? []) : undefined })}>
              {FIELD_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={fl.required} onChange={(e) => setField(i, { required: e.target.checked })} />
              Zorunlu
            </label>
            <button className="ghost danger" disabled={svc.fields.length <= 1} onClick={() => setField(i, null)} aria-label="Bilgiyi sil">
              ×
            </button>
            {fl.type === "choice" && (
              <input
                className="choices"
                value={(fl.choices ?? []).join(", ")}
                placeholder="Seçenekler, virgülle: Vito, Sprinter"
                onChange={(e) => setField(i, { choices: e.target.value.split(",").map((x) => x.trimStart()) })}
                onBlur={(e) => setField(i, { choices: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="row wrap-actions">
        {svc.fields.length < 15 && (
          <button className="ghost" onClick={() => set({ fields: [...svc.fields, { key: "", label: "", type: "text", required: true }] })}>
            + Bilgi ekle
          </button>
        )}
        <button
          className="ghost danger"
          onClick={() => {
            if (confirm(`${svc.label || svc.key} hizmeti kaldırılsın mı? (Kaydet'e basınca uygulanır)`)) onChange(null);
          }}
        >
          Hizmeti kaldır
        </button>
      </div>
    </div>
  );
}

// Arama yapmadan deneme: asistanın bu bilgilerle göreceği yanıt.
function QuoteTry({ prefix, services }: { prefix: string; services: BookingService[] }) {
  const [key, setKey] = useState(services[0].key);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [res, setRes] = useState<BookingQuote | string | null>(null);
  const svc = services.find((x) => x.key === key) ?? services[0];
  return (
    <div className="card">
      <h3>Dene</h3>
      <p className="muted small">Asistanın fiyat sorduğunda alacağı yanıtı görün. Rezervasyon oluşturulmaz.</p>
      <div className="form-grid">
        <label>
          Hizmet
          <select
            value={svc.key}
            onChange={(e) => {
              setKey(e.target.value);
              setFields({});
              setRes(null);
            }}
          >
            {services.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label || x.key}
              </option>
            ))}
          </select>
        </label>
        {svc.fields.map((fl) => (
          <label key={fl.key}>
            {fl.label}
            {!fl.required && <span className="muted"> (isteğe bağlı)</span>}
            {fl.type === "choice" ? (
              <select value={fields[fl.key] ?? ""} onChange={(e) => setFields({ ...fields, [fl.key]: e.target.value })}>
                <option value="">—</option>
                {fl.choices?.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                type={fl.type === "date" ? "date" : fl.type === "time" ? "time" : fl.type === "datetime" ? "datetime-local" : fl.type === "number" ? "number" : "text"}
                value={fields[fl.key] ?? ""}
                onChange={(e) => setFields({ ...fields, [fl.key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => api.bookingQuote(prefix, { service: svc.key, fields }).then(setRes, (e) => setRes(err(e)))}>Fiyat sor</button>
        {res !== null &&
          (typeof res === "string" ? (
            <span className="small error">{res}</span>
          ) : (
            <span className={`small ${res.available ? "ok-text" : "error"}`}>
              {res.available ? "Müsait" : "Müsait değil"}
              {res.price ? ` · ${res.price.amount} ${res.price.currency}` : res.available ? " · fiyat yok (ekip teyit eder)" : ""}
              {res.message ? ` · ${res.message}` : ""}
            </span>
          ))}
      </div>
    </div>
  );
}

// --- CRM: gelen rezervasyonlar ---

const STATUS: Record<BookingRow["status"], [string, string]> = {
  pending: ["Teyit bekliyor", "warn"],
  confirmed: ["Onaylandı", "ok"],
  cancelled: ["İptal", "off"],
};
const SOURCE: Record<BookingRow["source"], string> = { phone: "Telefon", chat: "Web sohbeti", panel: "Panel", api: "API" };

export function BookingsPage({ prefix }: { prefix: string }) {
  const [status, setStatus] = useState<"" | BookingRow["status"]>("pending");
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api.bookings(prefix, status).then(setRows, (e) => setError(err(e))), [prefix, status]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);
  const act = (r: BookingRow, action: "confirm" | "cancel") => {
    let note: string | undefined;
    if (action === "cancel") {
      const n = prompt(`${r.externalRef ?? r.reference} iptal edilsin mi? İsterseniz kısa bir not yazın:`, "");
      if (n === null) return;
      note = n.trim() || undefined;
    }
    api.bookingSet(prefix, r.id, action, note).then(load, (e) => setError(err(e)));
  };
  return (
    <div className="card">
      <div className="row spread">
        <h2>Rezervasyonlar</h2>
        <div className="row filters">
          {(
            [
              ["pending", "Teyit bekleyen"],
              ["confirmed", "Onaylanan"],
              ["cancelled", "İptal"],
              ["", "Tümü"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={status === v ? "" : "ghost"} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>{status === "pending" ? "Teyit bekleyen rezervasyon yok." : "Bu listede rezervasyon yok."}</p>
          <p className="small muted">Yapay zekâ asistanının telefonda ve web sohbetinde aldığı rezervasyonlar burada görünür.</p>
        </div>
      ) : (
        <ul className="booking-list">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="booking-head">
                <div>
                  <strong>{r.serviceLabel}</strong>
                  <span className="mono small muted"> · {r.externalRef ?? r.reference}</span>
                </div>
                <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
              </div>
              <div className="booking-fields small">
                {Object.entries(r.fields).map(([k, v]) => (
                  <span key={k}>
                    <span className="muted">{r.labels?.[k] ?? k.replace(/_/g, " ")}:</span> {v}
                  </span>
                ))}
              </div>
              <div className="small muted booking-meta">
                <span>{r.customerName ?? "Ad yok"}</span>
                {r.phone && <span className="mono">{r.phone}</span>}
                {r.amount && (
                  <span>
                    {r.amount} {r.currency}
                    {r.paymentRef ? " · ödeme bağlantısı gönderildi" : ""}
                  </span>
                )}
                <span>{SOURCE[r.source]}</span>
                <span>{r.createdAt}</span>
              </div>
              {r.note && <div className="small">Not: {r.note}</div>}
              {r.status !== "cancelled" && (
                <div className="row wrap-actions">
                  {r.status === "pending" && <button onClick={() => act(r, "confirm")}>Onayla</button>}
                  <button className="ghost danger" onClick={() => act(r, "cancel")}>
                    İptal et
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
