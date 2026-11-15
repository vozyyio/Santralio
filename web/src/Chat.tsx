// Panel → Web sohbeti: sitedeki sohbet aracının ayarları, gömme kodu ve geçmiş sohbetler.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AiFlow, type ChatSessionDetail, type ChatSessionRow, type ChatWidget } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const STATUS: Record<ChatSessionRow["status"], [string, string]> = {
  open: ["Açık", ""],
  handoff: ["Ekibe devredildi", "warn"],
  ended: ["Bitti", "ok"],
  limit: ["Sınıra ulaştı", "off"],
};

type Form = { enabled: boolean; flow: string; title: string; greeting: string; color: string; origins: string; contactPhone: string; whatsapp: string; dailyLimit: number };
const toForm = (w: ChatWidget | null, flows: AiFlow[]): Form => ({
  enabled: w?.enabled ?? false,
  flow: w?.flow ?? flows[0]?.name ?? "",
  title: w?.title ?? "Canlı destek",
  greeting: w?.greeting ?? "",
  color: w?.color ?? "#1d6fe8",
  origins: (w?.origins ?? []).join("\n"),
  contactPhone: w?.contactPhone ?? "",
  whatsapp: w?.whatsapp ?? "",
  dailyLimit: w?.dailyLimit ?? 300,
});

export function ChatPage({ prefix }: { prefix: string }) {
  const [data, setData] = useState<{ widget: ChatWidget | null; embedBase: string; assistant: boolean } | null>(null);
  const [flows, setFlows] = useState<AiFlow[] | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(
    () =>
      Promise.all([api.chatGet(prefix), api.ai(prefix)]).then(
        ([c, ai]) => {
          setData(c);
          setFlows(ai.flows);
          setF(toForm(c.widget, ai.flows));
        },
        (e) => setError(err(e)),
      ),
    [prefix],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <p className="error">{error}</p>;
  if (!data || !f || !flows) return <p className="muted">Yükleniyor…</p>;

  const set = (p: Partial<Form>) => {
    setF({ ...f, ...p });
    setNote(null);
  };
  const save = () =>
    api
      .chatSave(prefix, {
        enabled: f.enabled,
        flow: f.flow,
        title: f.title,
        greeting: f.greeting,
        color: f.color,
        origins: f.origins.split(/[\s,]+/).filter(Boolean),
        contactPhone: f.contactPhone.trim() || null,
        whatsapp: f.whatsapp.trim() || null,
        dailyLimit: f.dailyLimit,
      })
      .then(
        (w) => {
          setData({ ...data, widget: w });
          setF(toForm(w, flows));
          setNote({ text: w.enabled ? "Kaydedildi. Sohbet sitenizde açık." : "Kaydedildi.", ok: true });
        },
        (e) => setNote({ text: err(e), ok: false }),
      );
  const w = data.widget;
  const code = w ? `<script src="${data.embedBase}/api/chat/embed.js" data-key="${w.publicKey}" async></script>` : "";
  const flow = flows.find((x) => x.name === f.flow);

  return (
    <>
      <div className="card">
        <h2>Web sohbeti</h2>
        <p className="muted small">
          Sitenizin sağ alt köşesine bir sohbet düğmesi ekler. Telefondaki asistanınız burada yazılı yanıt verir; seçtiğiniz akışta rezervasyon açıksa
          rezervasyon alır ve ödeme bağlantısını ekranda gösterir. Yanıtlayamadığında ekibinize devreder (Entegrasyonlar'daki webhook ve aşağıdaki
          geçmiş).
        </p>
        {!data.assistant && <p className="notice small">Sunucuda yapay zekâ anahtarı tanımlı değil; sohbet açılır ama yanıt veremez. Platform yöneticinize bildirin.</p>}
        {!flows.length ? (
          <div className="empty-state">
            <p>Önce bir yapay zekâ akışı oluşturun.</p>
            <p className="small muted">Sohbet asistanı akıştaki şirket bilgilerini, dilleri ve rezervasyon ayarını kullanır.</p>
            <a className="button" href={`#/t/${prefix}/yapayzeka`}>
              Yapay zekâ sekmesine git
            </a>
          </div>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Sohbet sitemde açık
            </label>
            <div className="form-grid">
              <label>
                Kullanılacak akış
                <select value={f.flow} onChange={(e) => set({ flow: e.target.value })}>
                  {flows.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name}
                      {x.booking ? " (rezervasyon açık)" : ""}
                      {!x.enabled ? " — kapalı" : ""}
                    </option>
                  ))}
                </select>
                {flow && !flow.enabled && <span className="small error">Bu akış kapalı; sohbet görünmez.</span>}
              </label>
              <label>
                Başlık
                <input value={f.title} maxLength={60} onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label>
                Renk
                <span className="row color-row">
                  <input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} aria-label="Renk seç" />
                  <input className="mono" value={f.color} maxLength={7} onChange={(e) => set({ color: e.target.value })} />
                </span>
              </label>
              <label className="span2">
                Karşılama mesajı
                <input value={f.greeting} maxLength={300} placeholder="Merhaba, size nasıl yardımcı olabilirim?" onChange={(e) => set({ greeting: e.target.value })} />
              </label>
              <label>
                İletişim telefonu (devirde gösterilir)
                <input inputMode="tel" value={f.contactPhone} placeholder="0252 000 00 00" onChange={(e) => set({ contactPhone: e.target.value })} />
              </label>
              <label>
                WhatsApp (isteğe bağlı)
                <input inputMode="tel" value={f.whatsapp} placeholder="0532 000 00 00" onChange={(e) => set({ whatsapp: e.target.value })} />
              </label>
              <label>
                Günlük sohbet sınırı
                <input type="number" min={10} max={5000} value={f.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} />
              </label>
              <label className="span2">
                Sohbetin açılacağı siteler (her satıra bir adres)
                <textarea rows={3} value={f.origins} placeholder={"https://www.firmaniz.com\nhttps://rezervasyon.firmaniz.com"} onChange={(e) => set({ origins: e.target.value })} />
                <span className="small muted">Sohbet penceresi yalnızca bu sitelerin içinde açılır; başka sitelere kopyalanan kod çalışmaz.</span>
              </label>
            </div>
            <div className="actions">
              <button onClick={save}>Kaydet</button>
              {note && <span className={`small ${note.ok ? "ok-text" : "error"}`}>{note.text}</span>}
            </div>
          </>
        )}
      </div>

      {w && (
        <div className="card">
          <h3>Sitenize ekleyin</h3>
          <p className="muted small">
            Bu satırı sitenizin bütün sayfalarında <span className="mono">&lt;/body&gt;</span> etiketinden hemen önce ekleyin (WordPress: tema
            ayarlarında “altbilgi kodu” ya da bir kod ekleme eklentisi).
          </p>
          <div className="notice">
            <code className="mono wrap">{code}</code>
          </div>
          <div className="actions">
            <button
              className="ghost"
              onClick={() =>
                navigator.clipboard?.writeText(code).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Kopyalandı" : "Kodu kopyala"}
            </button>
            <button className="ghost" onClick={() => window.open(`${data.embedBase}/api/chat/w/${w.publicKey}`, "_blank", "noopener")}>
              Önizle
            </button>
          </div>
        </div>
      )}

      <Sessions prefix={prefix} />
    </>
  );
}

function Sessions({ prefix }: { prefix: string }) {
  const [rows, setRows] = useState<ChatSessionRow[] | null>(null);
  const [open, setOpen] = useState<ChatSessionDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.chatSessions(prefix).then(setRows, (e) => setError(err(e)));
  }, [prefix]);
  return (
    <div className="card">
      <h3>Son sohbetler</h3>
      {error && <p className="error small">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : !rows.length ? (
        <div className="empty-state">
          <p>Henüz sohbet yok.</p>
          <p className="small muted">Sitenizde biri yazdığında burada görünür.</p>
        </div>
      ) : (
        <ul className="booking-list">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="booking-head">
                <span className="wrap">{r.summary ?? r.firstMessage ?? "—"}</span>
                <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
              </div>
              <div className="small muted booking-meta">
                <span>{r.createdAt}</span>
                <span>{r.messages} mesaj</span>
                {r.bookingRef && <span>Rezervasyon {r.bookingRef}</span>}
                {r.page && <span className="wrap">{r.page}</span>}
              </div>
              <div className="row wrap-actions">
                <button className="ghost" onClick={() => (open?.id === r.id ? setOpen(null) : api.chatSession(prefix, r.id).then(setOpen, (e) => setError(err(e))))}>
                  {open?.id === r.id ? "Kapat" : "Konuşmayı göster"}
                </button>
              </div>
              {open?.id === r.id && (
                <div className="chat-log">
                  {open.history.map((t, i) => (
                    <div key={i} className={`chat-turn ${t.role}`}>
                      <span className="small muted">{t.role === "caller" ? "Ziyaretçi" : t.role === "tool" ? "Sistem" : "Asistan"}</span>
                      <p>{t.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
