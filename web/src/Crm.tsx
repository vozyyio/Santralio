// Santralio CRM: müşteri kartları, kart sayfası (notlar, arama geçmişi), geri aramalar,
// temsilci ekranındaki kart ve not paneli, panelde sonuç kodları.

import { useEffect, useState } from "react";
import { api, type CallerHistory, type CallRow, type Contact, type ContactDetail, type Disposition, type LookupResult, type Note } from "./api";
import { mmss, queueLabel } from "./Reports";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

// --- Kart formu (yeni ve düzenleme) ---

function ContactForm({
  prefix,
  initial,
  onSaved,
  onCancel,
}: {
  prefix: string;
  initial: Partial<Contact>;
  onSaved: (id: number) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [company, setCompany] = useState(initial.company ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [phones, setPhones] = useState((initial.phones ?? []).join(", "));
  const [tags, setTags] = useState((initial.tags ?? []).join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { name, company, email, phones: splitList(phones), tags: splitList(tags) };
      if (initial.id) {
        await api.saveContact(prefix, initial.id, body);
        onSaved(initial.id);
      } else {
        onSaved((await api.addContact(prefix, body)).id);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-grid">
      <label>
        Ad Soyad
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
      </label>
      <label>
        Firma
        <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} />
      </label>
      <label>
        Telefonlar (virgülle)
        <input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="0532 123 45 67, +49 171 …" />
      </label>
      <label>
        E-posta
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
      </label>
      <label>
        Etiketler (virgülle)
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="VIP, Almanya" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={busy || !name.trim()} onClick={save}>
          Kaydet
        </button>
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            Vazgeç
          </button>
        )}
      </div>
    </div>
  );
}

// --- CRM: Müşteriler sekmesi ---

export function Contacts({ prefix, contactId }: { prefix: string; contactId: number | null }) {
  if (contactId) return <ContactPage prefix={prefix} id={contactId} />;
  return <ContactList prefix={prefix} />;
}

function ContactList({ prefix }: { prefix: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.contacts(prefix, q).then(setRows).catch((e) => setError(msg(e)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [prefix, q]);
  return (
    <div className="card">
      <div className="row spread">
        <h3>Müşteriler</h3>
        <button onClick={() => setAdding(!adding)}>{adding ? "Kapat" : "Yeni kart"}</button>
      </div>
      {adding && <ContactForm prefix={prefix} initial={{}} onSaved={(id) => (location.hash = `#/t/${prefix}/musteriler/${id}`)} onCancel={() => setAdding(false)} />}
      <input placeholder="Ad, firma, telefon, e-posta ya da etiket ara" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">{q ? "Eşleşen kart yok." : "Henüz kart yok."}</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Firma</th>
                <th>Telefon</th>
                <th>Etiketler</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="link" onClick={() => (location.hash = `#/t/${prefix}/musteriler/${c.id}`)}>
                  <td>{c.name}</td>
                  <td>{c.company}</td>
                  <td className="mono small">{c.phones.join(", ")}</td>
                  <td>{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NotesList({ notes }: { notes: Note[] }) {
  if (notes.length === 0) return <p className="muted small">Not yok.</p>;
  return (
    <ul className="notes">
      {notes.map((n) => (
        <li key={n.id}>
          <div className="small muted">
            {n.at} · {n.user}
            {n.direction === "out" ? " · dış arama" : n.direction === "in" ? " · gelen arama" : ""}
          </div>
          {n.disposition && <span className="tag">{n.disposition}</span>}
          {n.followUpAt && <span className="tag">Geri ara: {n.followUpAt}</span>}
          {n.note && <div className="note-text">{n.note}</div>}
        </li>
      ))}
    </ul>
  );
}

function ContactPage({ prefix, id }: { prefix: string; id: number }) {
  const [c, setC] = useState<ContactDetail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const load = () => api.contact(prefix, id).then(setC).catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [prefix, id]);
  if (error) return <p className="error">{error}</p>;
  if (!c) return <p className="muted">Yükleniyor…</p>;
  return (
    <>
      <p>
        <a href={`#/t/${prefix}/musteriler`}>← Müşteriler</a>
      </p>
      <div className="card">
        {editing ? (
          <ContactForm
            prefix={prefix}
            initial={c}
            onSaved={() => {
              setEditing(false);
              void load();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="row spread">
              <div>
                <h2>{c.name}</h2>
                {c.company && <p className="muted">{c.company}</p>}
              </div>
              <button className="ghost" onClick={() => setEditing(true)}>
                Düzenle
              </button>
            </div>
            <dl>
              <dt>Telefon</dt>
              <dd className="mono">{c.phones.join(", ") || "–"}</dd>
              <dt>E-posta</dt>
              <dd>{c.email || "–"}</dd>
              <dt>Etiketler</dt>
              <dd>{c.tags.length ? c.tags.map((t) => <span key={t} className="tag">{t}</span>) : "–"}</dd>
            </dl>
          </>
        )}
      </div>
      <div className="grid">
        <div className="card">
          <h3>Notlar</h3>
          <NoteForm prefix={prefix} context={{ contactId: c.id, phone: c.phones[0] ?? null }} onSaved={load} />
          <NotesList notes={c.notes} />
        </div>
        <div className="card">
          <h3>Arama geçmişi</h3>
          <CallHistory prefix={prefix} calls={c.calls} playing={playing} setPlaying={setPlaying} />
        </div>
      </div>
    </>
  );
}

function CallHistory({ prefix, calls, playing, setPlaying }: { prefix: string; calls: CallRow[]; playing: string | null; setPlaying: (s: string) => void }) {
  if (calls.length === 0) return <p className="muted small">Son bir yılda görebildiğiniz görüşme yok.</p>;
  return (
    <ul className="notes">
      {calls.map((c) => (
        <li key={`${c.callid}-${c.queue}`}>
          <div className="small">
            <span className="mono">{c.started.slice(0, 16)}</span> · {queueLabel(c.queue)}
            {c.agent ? ` · ${c.agent}` : ""} · {c.outcome === "answered" ? mmss(c.talk_s) : "cevapsız"}
          </div>
          {(c.disposition || c.note) && (
            <div className="small muted">
              {c.disposition}
              {c.disposition && c.note ? " · " : ""}
              {c.note}
            </div>
          )}
          {c.recording &&
            (playing === c.callid ? (
              <audio controls autoPlay src={api.recordingUrl(prefix, c.callid)} />
            ) : (
              <button className="ghost" onClick={() => setPlaying(c.callid)}>
                Dinle
              </button>
            ))}
        </li>
      ))}
    </ul>
  );
}

// --- Not formu (kart sayfası ve temsilci ekranı) ---

export type NoteContext = { contactId: number | null; phone: string | null; callid?: string | null; direction?: "in" | "out" | null };

function useDispositions(prefix: string) {
  const [list, setList] = useState<Disposition[]>([]);
  useEffect(() => {
    api.dispositions(prefix).then(setList).catch(() => setList([]));
  }, [prefix]);
  return list;
}

export function NoteForm({ prefix, context, onSaved }: { prefix: string; context: NoteContext; onSaved?: () => void }) {
  const dispositions = useDispositions(prefix);
  const [dispositionId, setDispositionId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const save = async () => {
    try {
      await api.addNote(prefix, { ...context, dispositionId, note, followUpAt: followUp || null });
      setState({ msg: "Kaydedildi.", error: false });
      if (!context.callid) {
        setNote("");
        setDispositionId(null);
        setFollowUp("");
      }
      onSaved?.();
    } catch (e) {
      setState({ msg: msg(e), error: true });
    }
  };
  return (
    <div className="note-form">
      <div className="row">
        <select value={dispositionId ?? ""} onChange={(e) => setDispositionId(e.target.value ? Number(e.target.value) : null)} aria-label="Sonuç kodu">
          <option value="">Sonuç kodu</option>
          {dispositions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <label className="inline">
          Geri ara
          <input type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </label>
      </div>
      <textarea rows={3} placeholder="Görüşme notu" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
      <div className="actions">
        <button disabled={!note.trim() && dispositionId === null} onClick={save}>
          Notu kaydet
        </button>
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
    </div>
  );
}

// --- Temsilci ekranındaki müşteri paneli ---

export function CallerPanel({ prefix, phone, callid, direction }: { prefix: string; phone: string; callid: string | null; direction: "in" | "out" }) {
  const [data, setData] = useState<LookupResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.lookup(prefix, phone, callid).then(setData).catch((e) => setError(msg(e)));
  useEffect(() => {
    setData(null);
    setCreating(false);
    void load();
  }, [prefix, phone]);
  if (error) return <p className="error small">{error}</p>;
  if (!data) return <p className="muted small">Müşteri aranıyor…</p>;
  const c = data.contact;
  return (
    <div className="caller-panel">
      {c ? (
        <div>
          <strong>{c.name}</strong>
          {c.company && <span className="muted"> · {c.company}</span>}{" "}
          {c.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}{" "}
          <a className="small" href={`${location.origin.replace("//agent.", "//crm.")}/#/t/${prefix}/musteriler/${c.id}`} target="_blank" rel="noreferrer">
            Kartı aç
          </a>
        </div>
      ) : creating ? (
        <ContactForm
          prefix={prefix}
          initial={{ phones: data.phone ? [data.phone] : [] }}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="row">
          <span className="muted small">Bu numara için kart yok.</span>
          <button className="ghost" onClick={() => setCreating(true)}>
            Kart oluştur
          </button>
        </div>
      )}
      <CallerHistoryLine h={data.history} />
      {data.notes.length > 0 && (
        <>
          <h4>Son notlar</h4>
          <NotesList notes={data.notes} />
        </>
      )}
      <h4>Bu görüşmenin notu</h4>
      <NoteForm prefix={prefix} context={{ contactId: c?.id ?? null, phone: data.phone, callid, direction }} onSaved={load} />
    </div>
  );
}

// Arayanı tanıma: kaçıncı araması, son arama zamanı, son yapay zekâ özeti.
function CallerHistoryLine({ h }: { h?: CallerHistory }) {
  if (!h) return null;
  return (
    <div className="caller-history">
      {h.previousCalls === 0 ? (
        <span className="badge">İlk araması</span>
      ) : (
        <span className="badge">
          {h.previousCalls + 1}. araması · son: {h.lastCallAt}
        </span>
      )}
      {h.lastSummary && (
        <p className="small">
          <span className="muted">Önceki yapay zekâ özeti:</span> {h.lastSummary}
        </p>
      )}
    </div>
  );
}

// --- Geri aramalar sekmesi ---

export function FollowUps({ prefix }: { prefix: string }) {
  const [rows, setRows] = useState<
    { id: number; phone: string | null; note: string; user: string; disposition: string | null; contactId: number | null; contactName: string | null; followUpAt: string; due: boolean }[] | null
  >(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.followUps(prefix).then(setRows).catch((e) => setError(msg(e)));
  }, [prefix]);
  return (
    <div className="card">
      <h3>Geri aramalar</h3>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Yükleniyor…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Planlanmış geri arama yok.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Müşteri</th>
                <th>Telefon</th>
                <th>Not</th>
                <th>Kim</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">
                    {r.followUpAt} {r.due && <span className="badge off">Vakti geldi</span>}
                  </td>
                  <td>{r.contactId ? <a href={`#/t/${prefix}/musteriler/${r.contactId}`}>{r.contactName}</a> : <span className="muted">–</span>}</td>
                  <td className="mono small">{r.phone ?? "–"}</td>
                  <td className="small">
                    {r.disposition && <span className="tag">{r.disposition}</span>} {r.note}
                  </td>
                  <td className="small">{r.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Panel: sonuç kodları ---

export function DispositionsCard({ prefix }: { prefix: string }) {
  const [rows, setRows] = useState<Disposition[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = () => api.dispositions(prefix, true).then(setRows).catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [prefix]);
  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(() => load())
      .catch((e) => setError(msg(e)));
  return (
    <div className="card wide">
      <h3>Sonuç kodları</h3>
      <p className="muted small">Personel görüşme notunda bunlardan birini seçer; raporlarda ve müşteri kartında görünür.</p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        {rows?.map((d) => (
          <span key={d.id} className={`chip-static ${d.enabled ? "" : "muted"}`}>
            {d.name}
            <button className="ghost x" title={d.enabled ? "Kapat" : "Aç"} onClick={() => run(() => api.saveDisposition(prefix, d.id, d.name, !d.enabled))}>
              {d.enabled ? "×" : "+"}
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input placeholder="Yeni sonuç kodu" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
        <button
          className="ghost"
          disabled={!name.trim()}
          onClick={() =>
            run(async () => {
              await api.addDisposition(prefix, name.trim());
              setName("");
            })
          }
        >
          Ekle
        </button>
      </div>
    </div>
  );
}
