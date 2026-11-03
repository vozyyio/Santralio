// Santralio: dış arama politikası kartı. Kiracının yöneticileri görür, yalnızca platform yöneticisi değiştirir.

import { useEffect, useState } from "react";
import { api, type Policy, type PolicyView } from "./api";

// Sık kullanılan ülke kodları (panelde ad göstermek için; listede olmayan kod da girilebilir).
export const COUNTRY_NAMES: Record<string, string> = {
  "49": "Almanya", "44": "Birleşik Krallık", "7": "Rusya / Kazakistan", "31": "Hollanda", "33": "Fransa", "39": "İtalya",
  "48": "Polonya", "380": "Ukrayna", "972": "İsrail", "966": "Suudi Arabistan", "971": "BAE", "974": "Katar", "965": "Kuveyt",
  "964": "Irak", "994": "Azerbaycan", "32": "Belçika", "43": "Avusturya", "41": "İsviçre", "46": "İsveç", "45": "Danimarka",
  "47": "Norveç", "358": "Finlandiya", "34": "İspanya", "30": "Yunanistan", "359": "Bulgaristan", "40": "Romanya", "995": "Gürcistan",
  "98": "İran", "20": "Mısır", "962": "Ürdün", "961": "Lübnan", "973": "Bahreyn", "968": "Umman", "993": "Türkmenistan", "998": "Özbekistan",
};
const countryLabel = (c: string) => `+${c}${COUNTRY_NAMES[c] ? ` ${COUNTRY_NAMES[c]}` : ""}`;

const TYPES: [keyof Policy, string][] = [
  ["trMobile", "Türkiye mobil (05xx)"],
  ["trLandline", "Türkiye sabit (02xx, 03xx, 04xx)"],
  ["trNational", "0850 ve 444 numaraları"],
  ["trTollfree", "0800 ücretsiz hatlar"],
];

export function OutboundPolicyCard({ prefix }: { prefix: string }) {
  const [view, setView] = useState<PolicyView | null>(null);
  const [p, setP] = useState<Policy | null>(null);
  const [newCountry, setNewCountry] = useState("");
  const [state, setState] = useState<{ msg: string; error: boolean } | null>(null);
  const load = () =>
    api
      .outboundPolicy(prefix)
      .then((v) => {
        setView(v);
        setP(v.policy);
      })
      .catch((e) => setState({ msg: String(e.message ?? e), error: true }));
  useEffect(() => {
    void load();
  }, [prefix]);
  if (!view || !p) return <div className="card wide"><h3>Dış arama</h3>{state ? <p className="error">{state.msg}</p> : <p className="muted">Yükleniyor…</p>}</div>;

  const set = (patch: Partial<Policy>) => setP({ ...p, ...patch, template: patch.template ?? "custom" });
  const save = () =>
    api
      .saveOutboundPolicy(prefix, p)
      .then(() => {
        setState({ msg: "Kaydedildi ve santrale uygulandı.", error: false });
        return load();
      })
      .catch((e) => setState({ msg: String(e.message ?? e), error: true }));
  const tplLabel = view.templates.find((t) => t.id === view.policy.template)?.label ?? "Özel";

  if (!view.editable) {
    return (
      <div className="card wide">
        <h3>Dış arama</h3>
        <p>
          Politika: <strong>{tplLabel}</strong> · {view.policy.enabled ? <span className="badge ok">Açık</span> : <span className="badge off">Kapalı</span>}
        </p>
        <p className="small">Aranabilen: {view.patterns.length ? view.patterns.join(", ") : "yok"}</p>
        <p className="small muted">
          Eş zamanlı {view.policy.maxConcurrent} · günlük {view.policy.dailyLimit} · en uzun {view.policy.maxMinutes} dk. Hangi rolün dış arama yapabileceğini
          “Roller” sekmesinde “Dış arama yapma” yetkisiyle siz belirlersiniz. Politikanın değişmesi için platform yöneticisine başvurun.
        </p>
      </div>
    );
  }

  return (
    <div className="card wide">
      <h3>Dış arama politikası <span className="muted small">· yalnızca platform yöneticisi değiştirir</span></h3>
      <div className="row">
        <label className="inline">
          Şablon
          <select
            value={view.templates.some((t) => t.id === p.template) ? p.template : ""}
            onChange={(e) => {
              const t = view.templates.find((x) => x.id === e.target.value);
              if (t) setP({ ...t.policy });
            }}
          >
            <option value="">Özel</option>
            {view.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Dış arama açık
        </label>
      </div>
      <h4>Yurt içi</h4>
      <div className="perms">
        {TYPES.map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={p[k] as boolean} onChange={(e) => set({ [k]: e.target.checked } as Partial<Policy>)} />
            {label}
          </label>
        ))}
      </div>
      <h4>Yurt dışı (izin verilen ülkeler)</h4>
      <div className="row">
        {p.countries.map((c) => (
          <span key={c} className="chip-static">
            {countryLabel(c)}
            <button className="ghost x" aria-label={`${c} kaldır`} onClick={() => set({ countries: p.countries.filter((x) => x !== c) })}>
              ×
            </button>
          </span>
        ))}
        {p.countries.length === 0 && <span className="muted small">Yurt dışı kapalı.</span>}
      </div>
      <div className="row">
        <input list="country-codes" placeholder="Ülke kodu (ör. 49)" value={newCountry} onChange={(e) => setNewCountry(e.target.value.replace(/\D/g, ""))} maxLength={4} />
        <datalist id="country-codes">
          {Object.entries(COUNTRY_NAMES).map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </datalist>
        <button
          className="ghost"
          disabled={!newCountry || p.countries.includes(newCountry)}
          onClick={() => {
            set({ countries: [...p.countries, newCountry].sort() });
            setNewCountry("");
          }}
        >
          Ekle
        </button>
      </div>
      <p className="muted small">Türkiye (+90) ve +1 (Kuzey Amerika; Karayipler'deki yüksek ücretli hatları da kapsar) eklenemez. Özel ücretli (0900 vb.) ve kısa numaralar her zaman engellidir.</p>
      <h4>Sınırlar</h4>
      <div className="row">
        <label className="inline">
          Eş zamanlı
          <input type="number" min={0} max={100} value={p.maxConcurrent} onChange={(e) => set({ maxConcurrent: Number(e.target.value) })} />
        </label>
        <label className="inline">
          Günlük arama
          <input type="number" min={0} max={100000} value={p.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} />
        </label>
        <label className="inline">
          En uzun görüşme (dk)
          <input type="number" min={1} max={480} value={p.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />
        </label>
      </div>
      <div className="actions">
        <button onClick={save}>Kaydet</button>
        {state && <span className={state.error ? "error small" : "ok small"}>{state.msg}</span>}
      </div>
    </div>
  );
}
