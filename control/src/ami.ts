// Santralio: Asterisk Manager Interface (AMI) istemcisi.
// Yalnızca localhost'a bağlanır. Her çağrı için açılır, işi bitince kapanır.

import { connect, type Socket } from "node:net";
import { AMI_HOST, AMI_PORT, AMI_USER, amiSecret } from "./config.ts";

type Message = Record<string, string> & { _lines: string[] };

export class Ami {
  private sock: Socket;
  private buffer = "";
  private waiters: ((m: Message) => void)[] = [];
  private seq = 0;

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
  }

  static async open(): Promise<Ami> {
    const sock = connect(AMI_PORT, AMI_HOST);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    const ami = new Ami(sock);
    const login = await ami.action({ Action: "Login", Username: AMI_USER, Secret: amiSecret(), Events: "off" });
    if (login.Response !== "Success") throw new Error(`AMI girişi başarısız: ${login.Message ?? ""}`);
    return ami;
  }

  private onData(chunk: string) {
    this.buffer += chunk.replace(/^Asterisk Call Manager\/[^\r\n]*\r\n/, "");
    let end: number;
    while ((end = this.buffer.indexOf("\r\n\r\n")) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 4);
      const msg = { _lines: [] } as unknown as Message;
      for (const line of raw.split("\r\n")) {
        const i = line.indexOf(": ");
        if (i > 0) {
          const key = line.slice(0, i);
          const value = line.slice(i + 2);
          if (key === "Output") msg._lines.push(value);
          else msg[key] = value;
        } else if (line) {
          msg._lines.push(line);
        }
      }
      if (msg.Event) continue;
      this.waiters.shift()?.(msg);
    }
  }

  action(fields: Record<string, string>): Promise<Message> {
    const id = `santralio-${++this.seq}`;
    const body = Object.entries({ ...fields, ActionID: id })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AMI zaman aşımı: ${fields.Action}`)), 10_000);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.sock.write(body + "\r\n\r\n");
    });
  }

  async command(cmd: string): Promise<string[]> {
    const res = await this.action({ Action: "Command", Command: cmd });
    if (res.Response !== "Success" && res.Response !== "Follows") {
      throw new Error(`AMI komutu başarısız (${cmd}): ${res.Message ?? ""}`);
    }
    return res._lines;
  }

  async close() {
    try {
      await this.action({ Action: "Logoff" });
    } finally {
      this.sock.end();
    }
  }
}

// Kiracı dosyaları değişince yeniden yüklenecek modüller.
export const RELOAD_MODULES = ["res_pjsip.so", "pbx_config.so", "app_queue.so", "res_musiconhold.so"];

export async function reloadTenants(): Promise<void> {
  const ami = await Ami.open();
  try {
    for (const module of RELOAD_MODULES) {
      const res = await ami.action({ Action: "Reload", Module: module });
      if (res.Response !== "Success") throw new Error(`${module} yeniden yüklenemedi: ${res.Message ?? ""}`);
    }
  } finally {
    await ami.close();
  }
}
