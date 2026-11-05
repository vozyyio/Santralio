// Santralio kontrol servisi: ortam ayarları ve gizli bilgiler.
// Gizli bilgiler systemd credential olarak gelir ($CREDENTIALS_DIRECTORY).
// Depoda ya da ortam değişkeninde gizli bilgi tutulmaz.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Sunucu ayarları /etc/santralio/site.env'den ortam değişkeni olarak gelir (systemd EnvironmentFile).
export const BASE_DOMAIN = process.env.SANTRALIO_BASE_DOMAIN ?? "santralio.site";
export const SIP_HOST = process.env.SANTRALIO_SIP_HOST ?? `sip.${BASE_DOMAIN}`;
export const TENANTS_DIR = process.env.SANTRALIO_TENANTS_DIR ?? "/etc/asterisk/tenants";
export const SOUNDS_DIR = process.env.SANTRALIO_SOUNDS_DIR ?? "/var/lib/asterisk/sounds/santralio";
// Anons sesi: Piper (yerel, sinir ağı tabanlı) varsa o, yoksa espeak-ng kullanılır.
export const PIPER_BIN = process.env.SANTRALIO_PIPER_BIN ?? "/opt/santralio/piper/piper";
export const PIPER_MODEL = process.env.SANTRALIO_PIPER_MODEL ?? "/opt/santralio/voices/tr_TR-dfki-medium.onnx";
export const PG_DATABASE = process.env.SANTRALIO_PG_DATABASE ?? "santralio";
export const PG_HOST = process.env.SANTRALIO_PG_HOST ?? "/var/run/postgresql";
export const AMI_HOST = "127.0.0.1";
export const AMI_PORT = 5038;
export const AMI_USER = "santralio-ctl";

// Panelin adresi (hosted kiracıların hepsi için aynı; firmaya özel alt alan adı henüz yok).
export const PANEL_URL = `https://panel.${BASE_DOMAIN}`;
export const VOZYY_API_BASE = (process.env.VOZYY_API_BASE ?? "https://api.vozyy.com").replace(/\/+$/, "");

// İsteğe bağlı credential: yoksa null (ör. Vozyy anahtarları henüz girilmemişse).
export function optionalCredential(name: string): string | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  try {
    return readFileSync(join(dir, name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Şu an kullanılan ana anahtarın kimliği. Anahtar yenilenince yeni kimlik eklenir.
export const CURRENT_KEY_ID = "k1";

export function credential(name: string): Buffer {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) {
    throw new Error(`systemd credential bulunamadı: ${name}. CLI'yi /usr/local/bin/santralio ile çalıştırın.`);
  }
  return readFileSync(join(dir, name));
}

export function masterKey(keyId: string): Buffer {
  const raw = credential(`santralio-master-key-${keyId}`);
  const key = Buffer.from(raw.toString("utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`ana anahtar ${keyId} 32 bayt değil`);
  return key;
}

export function amiSecret(): string {
  return credential("santralio-ami-secret").toString("utf8").trim();
}
