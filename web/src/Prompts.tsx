// Santralio: anons sesi seçimi, kendi kaydını yükleme/kaydetme ve santrali açıp kapatma.

import { useEffect, useRef, useState } from "react";
import { api, type PromptRow, type Tenant } from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bust = () => `?v=${Date.now()}`;

export function PbxCard({ t, reload }: { t: Tenant; reload: () => void }) {
  const [text, setText] = useState(t.pbxClosedText);
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (open: boolean) => {
    if (!open && !confirm("Santral kapatılsın mı? Bütün numaralara gelen aramalar kapalı anonsunu duyup kapanacak.")) return;
    setBusy(true);
    try {
      await api.setPbx(t.prefix, open, text);
      setState({ msg: open ? "Santral açıldı." : "Santral kapatıldı.", error: false });
      reload();
    } catch (e) {
      setState({ msg: msg(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card wide pbx ${t.pbxOpen ? "" : "closed"}`}>
      <div className="row spread">
        <h3>
          Santral <span className={`badge ${t.pbxOpen ? "ok" : "off"}`}>{t.pbxOpen ? "Açık" : "Kapalı"}</span>
        </h3>
        {t.pbxOpen ? (
          <button className="danger" disabled={busy} onClick={() => run(false)}>
            Santrali kapat
          </button>
        ) : (
          <button disabled={busy} onClick={() => run(true)}>
            Santrali aç
          </button>
        )}
      </div>
      <p className="muted small">
        Kapalıyken bütün numaralara gelen aramalar, menü ve çalışma saatlerinden bağımsız olarak aşağıdaki anonsu duyup kapanır. İç aramalar ve dış aramalar
        etkilenmez.
      </p>
      <label>
        Santral kapalı anonsu
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </label>
      <div className="actions">
        <button className="ghost" disabled={busy || text === t.pbxClosedText} onClick={() => run(t.pbxOpen)}>
          Anonsu kaydet
        </button>
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
    </div>
  );
}

export function PromptsTab({ t, reload }: { t: Tenant; reload: () => void }) {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[] | null>(null);
  const [error, setError] = useState("");
  const [savedVoice, setSavedVoice] = useState("");
  const [version, setVersion] = useState(bust());
  const load = () =>
    Promise.all([api.voices(), api.prompts(t.prefix)])
      .then(([v, p]) => {
        setVoices(v);
        setPrompts(p);
        setVersion(bust());
      })
      .catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, [t.prefix]);
  const chooseVoice = async (id: string) => {
    try {
      await api.setVoice(t.prefix, id);
      setSavedVoice("Ses değişti; anonslar yeni sesle yeniden üretildi (yüklediğiniz kayıtlar değişmez).");
      reload();
      void load();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <>
      <div className="card">
        <h3>Anons sesi</h3>
        <p className="muted small">Metinden üretilen bütün anonslar bu sesle okunur. Seçmeden önce dinleyebilirsiniz.</p>
        <div className="voices">
          {voices.map((v) => (
            <label key={v.id} className={`voice ${t.voice === v.id ? "active" : ""}`}>
              <span className="row">
                <input type="radio" name="voice" checked={t.voice === v.id} onChange={() => chooseVoice(v.id)} />
                {v.label}
              </span>
              <audio controls preload="none" src={api.voiceSampleUrl(v.id)} />
            </label>
          ))}
        </div>
        {savedVoice && <p className="ok small">{savedVoice}</p>}
        <p className="muted small">
          Doğal bir kadın sesi için kendi kaydınızı aşağıdan yükleyebilir ya da tarayıcıdan okuyabilirsiniz. Yeni ses modelleri sunucuya eklendikçe bu listede görünür.
        </p>
      </div>
      <div className="card">
        <h3>Anonslar</h3>
        <p className="muted small">
          Her anons metninden otomatik okunur. İsterseniz kendi kaydınızı yükleyin (mp3, wav, m4a, ogg; en fazla 5 dakika, 12 MB) ya da mikrofona okuyun;
          yüklenen kayıt metin değişse de aynen çalınır. Metinler ilgili sekmelerden (Menüler, Kuyruklar, Çalışma saatleri, Genel) değiştirilir.
        </p>
        {error && <p className="error">{error}</p>}
        {!prompts ? (
          <p className="muted">Yükleniyor…</p>
        ) : (
          prompts.map((p) => <PromptItem key={p.name} t={t} p={p} version={version} onChange={load} />)
        )}
      </div>
    </>
  );
}

function PromptItem({ t, p, version, onChange }: { t: Tenant; p: PromptRow; version: string; onChange: () => void }) {
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (blob: Blob, filename: string) => {
    setBusy(true);
    setState(null);
    try {
      const r = await api.uploadPrompt(t.prefix, p.name, blob, filename);
      setState({ msg: `Yüklendi (${r.durationS} sn).`, error: false });
      onChange();
    } catch (e) {
      setState({ msg: msg(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleRecord = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((x) => x.stop());
        setRecording(false);
        void upload(new Blob(parts, { type: rec.mimeType }), "tarayici-kaydi.webm");
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setState({ msg: "Mikrofon izni verilmedi.", error: true });
    }
  };

  return (
    <div className="prompt">
      <div className="row spread">
        <strong>{p.label}</strong>
        {p.upload ? <span className="badge ok">Kendi kaydınız</span> : <span className="badge off">Metinden okunuyor</span>}
      </div>
      {p.upload ? (
        <p className="muted small">
          {p.upload.originalName || "kayıt"} · {p.upload.durationS} sn · {p.upload.uploadedAt} · {p.upload.uploadedBy}
        </p>
      ) : (
        <p className="small">“{p.text}”</p>
      )}
      <audio controls preload="none" src={`${api.promptUrl(t.prefix, p.name)}${version}`} />
      <div className="row">
        <input
          ref={file}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f, f.name);
            e.target.value = "";
          }}
        />
        <button className="ghost" disabled={busy || recording} onClick={() => file.current?.click()}>
          Dosya yükle
        </button>
        <button className={recording ? "danger" : "ghost"} disabled={busy} onClick={toggleRecord}>
          {recording ? "Kaydı bitir" : "Mikrofondan kaydet"}
        </button>
        {p.upload && (
          <button
            className="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.removePromptUpload(t.prefix, p.name);
                setState({ msg: "Kayıt kaldırıldı; anons yeniden metinden okunuyor.", error: false });
                onChange();
              } catch (e) {
                setState({ msg: msg(e), error: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Kendi kaydımı kaldır
          </button>
        )}
        {busy && <span className="muted small">İşleniyor…</span>}
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
    </div>
  );
}
