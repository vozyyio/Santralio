// Kuyruk: "Sıranız gelince sizi arayalım" ayarı ve talepler.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type QueueCallbackJob, type QueueCallbackSettings } from "./api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function QueueCallbackBox({ prefix, queue, hasTrunk, onSaved }: { prefix: string; queue: string; hasTrunk: boolean; onSaved: () => void }) {
  const [s, setS] = useState<QueueCallbackSettings | null>(null);
  const [saved, setSaved] = useState<QueueCallbackSettings | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.qcbGet(prefix, queue).then(
      (r) => {
        setS(r);
        setSaved(r);
      },
      (e) => setMsg({ text: err(e), error: true }),
    );
  }, [prefix, queue]);
  if (!s) return msg ? <p className="error small">{msg.text}</p> : null;
  const set = (p: Partial<QueueCallbackSettings>) => setS({ ...s, ...p });
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.qcbSave(prefix, queue, s);
      setS(r);
      setSaved(r);
      setMsg({ text: "Kaydedildi ve santrale uygulandı.", error: false });
      onSaved();
    } catch (e) {
      setMsg({ text: err(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="subcard">
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={!hasTrunk && !s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <strong>Sıranız gelince sizi arayalım</strong>
      </label>
      <p className="muted small">
        Bekleyen arayana belli aralıklarla geri arama teklif edilir. 1'e basan kapatır; sırası geldiğinde (temsilci boşalınca ve ondan önce girmiş kimse
        beklemiyorsa) işletmenin hattından aranır ve öncelikli olarak temsilciye bağlanır. Açmazsa 2 dakika arayla 3 kez denenir.
        {!hasTrunk && " Bu özellik için açık bir hat (SIP trunk) gerekli."}
      </p>
      {s.enabled && (
        <>
          <div className="form-grid">
            <label>
              Teklif aralığı (saniye)
              <input type="number" min={20} max={600} value={s.offerAfterS} onChange={(e) => set({ offerAfterS: Number(e.target.value) })} />
            </label>
            <label>
              Talep geçerliliği (dakika)
              <input type="number" min={10} max={720} value={s.expireMin} onChange={(e) => set({ expireMin: Number(e.target.value) })} />
            </label>
          </div>
          <label>
            Teklif anonsu
            <textarea rows={2} maxLength={300} value={s.offerText} onChange={(e) => set({ offerText: e.target.value })} />
          </label>
          <label>
            Talep alındı
            <textarea rows={2} maxLength={300} value={s.confirmText} onChange={(e) => set({ confirmText: e.target.value })} />
          </label>
          <label>
            Geri arama açılınca
            <textarea rows={2} maxLength={300} value={s.connectText} onChange={(e) => set({ connectText: e.target.value })} />
          </label>
          <label>
            Numara görünmüyorsa (arayan kuyruğa geri alınır)
            <textarea rows={2} maxLength={300} value={s.nonumText} onChange={(e) => set({ nonumText: e.target.value })} />
          </label>
        </>
      )}
      <div className="actions">
        <button disabled={busy || !dirty} onClick={save}>
          Kaydet
        </button>
        {msg && <span className={msg.error ? "error small" : "ok small"}>{msg.text}</span>}
      </div>
    </div>
  );
}

const STATUS: Record<QueueCallbackJob["status"], [string, "ok" | "off" | ""]> = {
  waiting: ["Sırada", ""],
  dialing: ["Aranıyor", ""],
  connected: ["Bağlandı", "ok"],
  no_answer: ["Açmadı", "off"],
  expired: ["Süresi doldu", "off"],
  cancelled: ["İptal", ""],
  failed: ["Aranamadı", "off"],
};

export function QueueCallbackJobs({ prefix }: { prefix: string }) {
  const [rows, setRows] = useState<QueueCallbackJob[] | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api.qcbJobs(prefix).then(setRows, (e) => setMsg(err(e))), [prefix]);
  useEffect(() => {
    void load();
    const id = window.setInterval(load, 15_000);
    return () => window.clearInterval(id);
  }, [load]);
  if (!rows) return msg ? <p className="error small">{msg}</p> : null;
  if (!rows.length) return null;
  return (
    <div className="card">
      <h3>Geri arama talepleri</h3>
      {msg && <p className="error small">{msg}</p>}
      <ul className="hook-list">
        {rows.map((j) => (
          <li key={j.id}>
            <div className="hook-head">
              <span>
                <span className="mono">{j.phone}</span> <span className="muted small">· {j.queue}</span>
              </span>
              <span className={`badge ${STATUS[j.status][1]}`}>{STATUS[j.status][0]}</span>
            </div>
            <div className="small muted hook-meta">
              <span>İstedi: {j.requestedAt}</span>
              {j.connectedAt && <span>Bağlandı: {j.connectedAt}</span>}
              {j.waitS !== null && <span>Bekleme: {mmss(j.waitS)}</span>}
              {j.attempts > 0 && <span>Deneme: {j.attempts}</span>}
              {j.note && <span>{j.note}</span>}
            </div>
            {j.status === "waiting" && (
              <div className="row wrap-actions">
                <button className="ghost" onClick={() => api.qcbCancel(prefix, j.id).then(load, (e) => setMsg(err(e)))}>
                  İptal et
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
