// Santralio: gizli alanların şifrelenmesi (AES-256-GCM).
// Biçim: iv (12 bayt) | etiket (16 bayt) | şifreli metin.
// AAD, şifreli metni ait olduğu satıra bağlar: başka bir satıra kopyalanan değer çözülmez.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealed = { enc: Buffer; keyId: string };

export function seal(plain: string, aad: string, key: Buffer, keyId: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { enc: Buffer.concat([iv, cipher.getAuthTag(), body]), keyId };
}

export function open(enc: Buffer, aad: string, key: Buffer): string {
  if (enc.length < 28) throw new Error("şifreli değer bozuk");
  const decipher = createDecipheriv("aes-256-gcm", key, enc.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(enc.subarray(12, 28));
  return Buffer.concat([decipher.update(enc.subarray(28)), decipher.final()]).toString("utf8");
}

// Gizli alanların AAD'leri. Satırın değişmeyen kimliğine bağlanır.
export const aad = {
  trunk: (tenantId: number) => `trunks:${tenantId}`,
  extension: (tenantId: number, number: string) => `extensions:${tenantId}:${number}`,
};

// SIP şifreleri ve Contact token'ları için: yalnızca küçük harf ve rakam.
export function randomToken(length: number): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const out: string[] = [];
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      // 33 karakterlik alfabede eşit dağılım için 231 üstü atılır.
      if (b < 231 && out.length < length) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}
