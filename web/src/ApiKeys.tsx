// Panel → Entegrasyon: API anahtarları (işletmenin kendi yazılımı Santralio'yu çağırsın diye).

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ApiKeyRow } from "./api";
import { SecretBox } from "./Webhooks";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Bir hata oluştu");

export function ApiKeysCard({ prefix }: { prefix: string }) {
  const [data, setData] = useState<{ keys: ApiKeyRow[]; permissions: { id: string; label: string }[]; base: string } | null>(null);
  const [form, setForm] = useState<{ name: string; permissions: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const load = useCallback(() => api.apiKeys(prefix).then(setData, (e) => setNote(err(e))), [prefix]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return note ? <p className="error small">{note}</p> : null;
  const active = data.keys.filter((k) => !k.revokedAt);
  const label = (id: string) => data.permissions.find((p) => p.id === id)?.label.split(":")[0] ?? id;
  return (
    <div className="card">
      <div className="row spread">
        <h2>API anahtarları</h2>
        {!form && active.length < 10 && <button onClick={() => setForm({ name: "", permissions: [] })}>+ Anahtar oluştur</button>}
      </div>
      <p className="muted small">
        Otel / acente / CRM yazılımınız Santralio'dan görüşmeleri, müşteri kartlarını ve rezervasyonları okuyabilir, ödeme bağlantısı oluşturabilir.
        İstekte <span className="mono">Authorization: Bearer sk_…</span> başlığı gönderilir; adres <span className="mono">{data.base}/api/tenants/{prefix}/…</span>.
        Anahtar ayar ve personel değiştiremez.
      </p>
      {note && <p className="error small">{note}</p>}
      {secret && <SecretBox value={secret} onClose={() => setSecret(null)} />}
      {form && (
        <div className="service-box">
          <label>
            Ad (nerede kullanılacak)
            <input value={form.name} maxLength={60} placeholder="Otel yazılımı" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <div className="perms">
            {data.permissions.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={form.permissions.includes(p.id)}
                  onChange={(e) => setForm({ ...form, permissions: e.target.checked ? [...form.permissions, p.id] : form.permissions.filter((x) => x !== p.id) })}
                />
                {p.label}
              </label>
            ))}
          </div>
          <div className="actions">
            <button
              disabled={!form.name.trim() || !form.permissions.length}
              onClick={() =>
                api.apiKeyCreate(prefix, form).then(
                  (r) => {
                    setForm(null);
                    setSecret(r.key);
                    setNote("");
                    void load();
                  },
                  (e) => setNote(err(e)),
                )
              }
            >
              Oluştur
            </button>
            <button className="ghost" onClick={() => setForm(null)}>
              Vazgeç
            </button>
          </div>
        </div>
      )}
      {!data.keys.length ? (
        !form && (
          <div className="empty-state">
            <p>Henüz API anahtarı yok.</p>
            <p className="small muted">Kendi yazılımınızla bağlantı kurmak istediğinizde oluşturun.</p>
          </div>
        )
      ) : (
        <ul className="hook-list">
          {data.keys.map((k) => (
            <li key={k.id}>
              <div className="hook-head">
                <div>
                  <strong>{k.name}</strong> <span className="mono small muted">{k.prefix}…</span>
                </div>
                <span className={`badge ${k.revokedAt ? "off" : "ok"}`}>{k.revokedAt ? "İptal" : "Etkin"}</span>
              </div>
              <div className="small muted hook-meta">
                <span>{k.permissions.map(label).join(", ")}</span>
                <span>Son kullanım: {k.lastUsedAt ?? "—"}</span>
                <span>
                  {k.createdAt} · {k.createdBy}
                </span>
              </div>
              {!k.revokedAt && (
                <div className="row wrap-actions">
                  <button
                    className="ghost danger"
                    onClick={() => {
                      if (!confirm(`"${k.name}" anahtarı iptal edilsin mi? Bu anahtarı kullanan sistem hemen erişimini kaybeder.`)) return;
                      api.apiKeyRevoke(prefix, k.id).then(load, (e) => setNote(err(e)));
                    }}
                  >
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
