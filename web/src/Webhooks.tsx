// Panel → Entegrasyonlar: webhook uçları (imzalı olay bildirimi), teslim geçmişi ve doğrulama örneği.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Webhook, type WebhookDelivery, type WebhookEvent } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const STATUS: Record<WebhookDelivery["status"], [string, "ok" | "off" | ""]> = {
  pending: ["Sırada", ""],
  delivered: ["Teslim edildi", "ok"],
  failed: ["Başarısız", "off"],
};

export function WebhooksPage({ prefix }: { prefix: string }) {
  const [data, setData] = useState<{ webhooks: Webhook[]; events: WebhookEvent[] } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [secret, setSecret] = useState<{ id: number; value: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const load = useCallback(() => api.whList(prefix).then(setData).catch((e) => setError(err(e))), [prefix]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Yükleniyor…</p>;
  const act = (p: Promise<unknown>) => p.then(load, (e) => setNote(err(e)));

  return (
    <>
      <div className="card">
        <div className="row spread">
          <h2>Webhook</h2>
          {editing === null && data.webhooks.length < 10 && <button onClick={() => setEditing("new")}>+ Webhook ekle</button>}
        </div>
        <p className="muted small">
          Görüşme, yapay zekâ, ödeme ve CRM olaylarını kendi sisteminize (ERP, otel yazılımı, CRM, Zapier/Make vb.) anında gönderir. Her istek gizli
          anahtarınızla imzalanır; ulaşamazsa 1 dk, 5 dk, 30 dk, 2 sa, 12 sa ve 24 sa sonra tekrar denenir. Adres https olmalı ve internetten
          erişilebilmeli.
        </p>
        {note && <p className="error small">{note}</p>}
        {secret && <SecretBox value={secret.value} onClose={() => setSecret(null)} />}
        {editing !== null && (
          <HookForm
            prefix={prefix}
            events={data.events}
            hook={editing === "new" ? null : editing}
            onDone={(created) => {
              setEditing(null);
              if (created) setSecret(created);
              void load();
            }}
          />
        )}
        {data.webhooks.length === 0 ? (
          editing === null && <p className="muted">Henüz webhook yok.</p>
        ) : (
          <ul className="hook-list">
            {data.webhooks.map((w) => (
              <li key={w.id}>
                <div className="hook-head">
                  <div>
                    <div className="mono small wrap">{w.url}</div>
                    {w.description && <div className="small muted">{w.description}</div>}
                  </div>
                  <span className={`badge ${w.enabled ? "ok" : "off"}`}>{w.enabled ? "Açık" : "Kapalı"}</span>
                </div>
                <div className="small muted hook-meta">
                  <span>{w.events.length === data.events.length ? "Bütün olaylar" : `${w.events.length} olay`}</span>
                  <span>Son teslim: {w.lastDeliveredAt ?? "—"}</span>
                  {w.pending > 0 && <span>{w.pending} sırada</span>}
                  {w.failed7d > 0 && <span>{w.failed7d} başarısız (7 gün)</span>}
                </div>
                {w.disabledReason && <div className="small error">{w.disabledReason}</div>}
                <div className="row wrap-actions">
                  <button className="ghost" onClick={() => setOpen(open === w.id ? null : w.id)}>
                    Teslimler
                  </button>
                  <button className="ghost" disabled={!w.enabled} onClick={() => act(api.whTest(prefix, w.id).then(() => setOpen(w.id)))}>
                    Test gönder
                  </button>
                  <button className="ghost" onClick={() => setEditing(w)}>
                    Düzenle
                  </button>
                  <button className="ghost" onClick={() => act(api.whUpdate(prefix, w.id, { enabled: !w.enabled }))}>
                    {w.enabled ? "Kapat" : "Aç"}
                  </button>
                  <button
                    className="ghost"
                    onClick={() => {
                      if (!confirm("Yeni gizli anahtar üretilsin mi? Eski anahtarla imzalanan istekler artık doğrulanmaz.")) return;
                      api.whRotate(prefix, w.id).then((r) => setSecret({ id: w.id, value: r.secret }), (e) => setNote(err(e)));
                    }}
                  >
                    Anahtarı yenile
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() => {
                      if (!confirm(`${w.url} silinsin mi? Teslim geçmişi de silinir.`)) return;
                      void act(api.whDelete(prefix, w.id));
                    }}
                  >
                    Sil
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open !== null && data.webhooks.some((w) => w.id === open) && (
        <Deliveries prefix={prefix} hook={data.webhooks.find((w) => w.id === open)!} onClose={() => setOpen(null)} />
      )}
      <VerifyCard events={data.events} />
    </>
  );
}

function SecretBox({ value, onClose }: { value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice">
      <strong>Gizli anahtar — yalnızca şimdi gösteriliyor</strong>
      <p className="small">Kendi sisteminizde güvenli bir yere kaydedin. Kaybederseniz “Anahtarı yenile” ile yenisini alırsınız.</p>
      <div className="row">
        <code className="mono wrap">{value}</code>
        <button
          className="ghost"
          onClick={() =>
            navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Kopyalandı" : "Kopyala"}
        </button>
        <button className="ghost" onClick={onClose}>
          Kaydettim
        </button>
      </div>
    </div>
  );
}

function HookForm({
  prefix,
  events,
  hook,
  onDone,
}: {
  prefix: string;
  events: WebhookEvent[];
  hook: Webhook | null;
  onDone: (created: { id: number; value: string } | null) => void;
}) {
  const [url, setUrl] = useState(hook?.url ?? "");
  const [description, setDescription] = useState(hook?.description ?? "");
  const [sel, setSel] = useState<Set<string>>(new Set(hook?.events ?? []));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(events.map((e) => e.group))];
  const toggle = (t: string) => setSel((s) => (s.has(t) ? new Set([...s].filter((x) => x !== t)) : new Set([...s, t])));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      if (hook) {
        await api.whUpdate(prefix, hook.id, { url, description, events: [...sel] });
        onDone(null);
      } else {
        const r = await api.whAdd(prefix, { url, description, events: [...sel] });
        onDone({ id: r.id, value: r.secret });
      }
    } catch (x) {
      setMsg(err(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="subcard" onSubmit={submit}>
      <h3>{hook ? "Webhook düzenle" : "Yeni webhook"}</h3>
      <div className="form-grid">
        <label>
          Adres (https)
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://sisteminiz.com/santralio/olay" maxLength={500} />
        </label>
        <label>
          Açıklama
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ör. Otel yazılımı" maxLength={200} />
        </label>
      </div>
      <div className="row spread">
        <h4>Olaylar</h4>
        <button type="button" className="ghost" onClick={() => setSel(sel.size === events.length ? new Set() : new Set(events.map((e) => e.type)))}>
          {sel.size === events.length ? "Hiçbiri" : "Hepsini seç"}
        </button>
      </div>
      <div className="event-groups">
        {groups.map((g) => (
          <fieldset key={g}>
            <legend>{g}</legend>
            {events
              .filter((e) => e.group === g)
              .map((e) => (
                <label key={e.type} className="check">
                  <input type="checkbox" checked={sel.has(e.type)} onChange={() => toggle(e.type)} />
                  <span>
                    {e.label} <span className="mono small muted">{e.type}</span>
                  </span>
                </label>
              ))}
          </fieldset>
        ))}
      </div>
      <div className="actions">
        <button disabled={busy || sel.size === 0 || !url}>{hook ? "Kaydet" : "Ekle"}</button>
        <button type="button" className="ghost" onClick={() => onDone(null)}>
          Vazgeç
        </button>
        {msg && <span className="error small">{msg}</span>}
      </div>
    </form>
  );
}

function Deliveries({ prefix, hook, onClose }: { prefix: string; hook: Webhook; onClose: () => void }) {
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [show, setShow] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api.whDeliveries(prefix, hook.id).then(setRows).catch((e) => setMsg(err(e))), [prefix, hook.id]);
  useEffect(() => {
    void load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);
  return (
    <div className="card">
      <div className="row spread">
        <h2>Teslimler</h2>
        <button className="ghost" onClick={onClose}>
          Kapat
        </button>
      </div>
      <p className="mono small muted wrap">{hook.url}</p>
      {msg && <p className="error small">{msg}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Henüz teslim yok. “Test gönder” ile deneyebilirsiniz.</p>
      ) : (
        <ul className="hook-list">
          {rows.map((d) => (
            <li key={d.id}>
              <div className="hook-head">
                <span className="mono small">{d.type}</span>
                <span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
              </div>
              <div className="small muted hook-meta">
                <span>{d.createdAt}</span>
                <span>Deneme: {d.attempts}</span>
                <span>Yanıt: {d.lastError ?? (d.lastCode ? `HTTP ${d.lastCode}` : "—")}</span>
                {d.status === "pending" && d.attempts > 0 && <span>Sonraki: {d.nextAt}</span>}
              </div>
              <div className="row wrap-actions">
                <button className="ghost" onClick={() => setShow(show === d.id ? null : d.id)}>
                  {show === d.id ? "Gövdeyi gizle" : "Gövde"}
                </button>
                {d.status !== "pending" && (
                  <button className="ghost" onClick={() => api.whRetry(prefix, d.id).then(load, (e) => setMsg(err(e)))}>
                    Yeniden gönder
                  </button>
                )}
              </div>
              {show === d.id && <pre className="payload">{JSON.stringify(d.payload, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SAMPLE = `// Node.js (Express): ham gövdeyle doğrulayın, JSON'a çevirmeden önce.
import { createHmac, timingSafeEqual } from "node:crypto";

app.post("/santralio/olay", express.raw({ type: "application/json" }), (req, res) => {
  const ts = req.get("X-Santralio-Timestamp");
  const sig = req.get("X-Santralio-Signature") ?? "";
  const expected = "sha256=" + createHmac("sha256", process.env.SANTRALIO_WEBHOOK_SECRET)
    .update(ts + "." + req.body).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.sendStatus(401);
  const event = JSON.parse(req.body);   // { id, type, created_at, tenant, data }
  // event.id daha önce işlendiyse tekrar işlemeyin (yeniden denemelerde aynı id gelir).
  res.sendStatus(200);
});`;

function VerifyCard({ events }: { events: WebhookEvent[] }) {
  return (
    <div className="card">
      <h2>İmzayı doğrulama</h2>
      <p className="small">
        Her istekte <span className="mono">X-Santralio-Event</span>, <span className="mono">X-Santralio-Event-Id</span>,{" "}
        <span className="mono">X-Santralio-Timestamp</span> ve <span className="mono">X-Santralio-Signature</span> başlıkları gelir. İmza:{" "}
        <span className="mono">sha256=</span> + HMAC-SHA256(gizli anahtar, <span className="mono">zaman + "." + ham gövde</span>). 2xx dışındaki yanıtlar
        yeniden denenir; 5 dakikadan eski zaman damgalarını reddetmenizi öneririz.
      </p>
      <pre className="payload">{SAMPLE}</pre>
      <details>
        <summary className="small">Olay listesi ({events.length})</summary>
        <ul className="small">
          {events.map((e) => (
            <li key={e.type}>
              <span className="mono">{e.type}</span> — {e.label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
