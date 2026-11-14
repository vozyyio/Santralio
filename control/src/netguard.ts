// Santralio: kiracının verdiği adreslere giden istekler için SSRF koruması.
//
// - Adres yalnızca https, 443, kullanıcı/şifresiz, genel bir alan adı olabilir (IP yazılamaz; IP yazılırsa
//   Node DNS çözümlemesini atlar ve aşağıdaki denetim çalışmaz).
// - Kaydederken: alan adı çözülür, iç ağ adresine çözülüyorsa reddedilir.
// - Bağlanırken: aynı denetim bağlantının kendi DNS çözümlemesinde tekrar yapılır (DNS rebinding'e karşı).
// - Yönlendirme izlenmez; yanıtın yalnızca ilk 1 KB'ı okunur.

import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { UserError } from "./ops.ts";

export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v === "::" || v.startsWith("::ffff:") || v.startsWith("64:ff9b:");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Yalnızca biçim denetimi (DNS yok).
export function publicHttpsShape(url: unknown, label = "adres"): URL {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new UserError(`${label} geçersiz`);
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw new UserError(`${label} https olmalı, kullanıcı/port içermemeli`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) throw new UserError(`${label} genel bir alan adı olmalı`);
  if (String(url).length > 500) throw new UserError(`${label} en fazla 500 karakter`);
  return u;
}

type Resolve = (host: string, o: { all: true }) => Promise<{ address: string; family: number }[]>;

export async function assertPublicHttps(url: unknown, resolve: Resolve = dnsLookupAsync as unknown as Resolve, label = "adres"): Promise<URL> {
  const u = publicHttpsShape(url, label);
  const addrs = await resolve(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new UserError(`${label} iç ağa çözülüyor ya da çözülemiyor`);
  return u;
}

// net.connect'e verilen DNS çözümleyicisi: iç ağ adresi dönerse bağlantı hiç kurulmaz.
export function guardedLookup(base: typeof dnsLookup = dnsLookup): LookupFunction {
  return ((hostname: string, options: any, cb: any) => {
    base(hostname, { ...(options ?? {}), all: true }, (err: NodeJS.ErrnoException | null, addrs: any) => {
      if (err) return cb(err);
      const list = addrs as { address: string; family: number }[];
      if (!list.length || list.some((a) => privateAddress(a.address))) {
        return cb(Object.assign(new Error(`${hostname} iç ağ adresine çözülüyor`), { code: "EPRIVATE" }));
      }
      if (options?.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

export type PostResult = { status: number; body: string };

// JSON POST. Yönlendirme izlenmez, zaman aşımı vardır, yanıtın en fazla 1 KB'ı okunur.
export function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000, lookup: LookupFunction = guardedLookup()): Promise<PostResult> {
  const u = publicHttpsShape(url);
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "Santralio-Webhooks/1", ...headers },
        lookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < 1024) chunks.push(c.subarray(0, 1024 - size));
          size += c.length;
          if (size > 64 * 1024) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("zaman aşımı")), timeoutMs + 1000);
    req.on("timeout", () => req.destroy(new Error("zaman aşımı")));
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}
