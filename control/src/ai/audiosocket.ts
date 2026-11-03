// Santralio: Asterisk AudioSocket protokolü. Her mesaj: tür (1 bayt) + uzunluk (2 bayt, big-endian) + veri.
// Ses: 8 kHz, 16 bit, tek kanal, işaretli PCM (slin); Asterisk 20 ms'lik (320 bayt) çerçeveler gönderir.

export const KIND = { hangup: 0x00, uuid: 0x01, dtmf: 0x03, audio: 0x10, error: 0xff } as const;
export const FRAME_BYTES = 320; // 20 ms, 8 kHz, 16 bit
export const FRAME_MS = 20;

export type Message = { kind: number; payload: Buffer };

// Gelen bayt akışını mesajlara böler; yarım mesajı bir sonraki parçaya bekletir.
export class Parser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Message[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Message[] = [];
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      out.push({ kind: this.buf[0], payload: this.buf.subarray(3, 3 + len) });
      this.buf = this.buf.subarray(3 + len);
    }
    return out;
  }
}

export function encode(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(3);
  head[0] = kind;
  head.writeUInt16BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export function uuidString(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
