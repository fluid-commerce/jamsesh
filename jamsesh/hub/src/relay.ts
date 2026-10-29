// The hub's connection to the canvas server for one relayed canvas socket.
//
// A plain WebSocket client can't be used here: Bun's reports `bufferedAmount` as 0 however much it
// is holding for a peer that has stopped reading, so the relay couldn't tell a stalled canvas server
// from a slow one. This speaks the (small) client side of the protocol over a TCP socket instead,
// where `write()` says how much the kernel took and the rest is held here, counted, up to a cap.
import type { Socket } from "bun";

export interface UpstreamEvents {
  open(): void;
  /** One whole message (text as a string, binary as bytes). */
  message(data: string | Uint8Array): void;
  /** The connection ended or failed; `why` is set when it was this side's doing (over the cap, bad frame). */
  close(why?: string): void;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A client WebSocket frame, masked as the protocol requires. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(head + 4 + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else if (n < 65536) {
    out[1] = 0x80 | 126;
    out[2] = n >> 8;
    out[3] = n & 255;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(n));
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export class Upstream {
  open = false;
  /** Bytes taken from send() that the canvas server hasn't read yet. */
  held = 0;
  private sock: Socket | null = null;
  private pending: Uint8Array[] = [];
  private head = new Uint8Array(0); // handshake response, then unparsed frame bytes
  private shaken = false;
  private done = false;
  private fragments: Uint8Array[] = [];
  private fragOp = 0;
  private fragBytes = 0;

  constructor(
    private port: number,
    private path: string,
    private ev: UpstreamEvents,
    /** The most the relay holds for this peer, in either direction of buffering (unsent frames, a message being assembled). */
    private maxBytes: () => number,
  ) {
    this.connect();
  }

  private async connect() {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    try {
      this.sock = await Bun.connect({
        hostname: "127.0.0.1",
        port: this.port,
        socket: {
          open: (s) => {
            if (this.done) return void s.end();
            s.write(`GET ${this.path} HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
          },
          data: (_s, buf) => this.onBytes(buf, key),
          drain: () => this.flush(),
          close: () => this.finish(),
          error: () => this.finish(),
        },
      });
      if (this.done) this.sock.end();
    } catch {
      this.finish();
    }
  }

  /** Queues a message for the canvas server; false when it is already holding as much as it may (it stopped reading). */
  send(data: string | Uint8Array): boolean {
    if (this.done) return false;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.held + bytes.length > this.maxBytes()) return false;
    const frame = encodeFrame(typeof data === "string" ? 1 : 2, bytes);
    this.pending.push(frame);
    this.held += frame.length;
    this.flush();
    return true;
  }

  private flush() {
    const s = this.sock;
    if (!s || !this.shaken) return;
    while (this.pending.length) {
      const next = this.pending[0];
      const wrote = s.write(next);
      this.held -= Math.max(0, wrote);
      if (wrote < next.length) {
        this.pending[0] = next.subarray(Math.max(0, wrote));
        return; // the kernel is full: the rest goes on drain
      }
      this.pending.shift();
    }
  }

  close(code = 1000) {
    if (this.sock && this.shaken && !this.done) {
      try {
        this.sock.write(encodeFrame(8, new Uint8Array([code >> 8, code & 255])));
      } catch {}
    }
    this.finish();
  }

  private finish(why?: string) {
    if (this.done) return;
    this.done = true;
    this.open = false;
    this.pending = [];
    this.held = 0;
    this.fragments = [];
    try {
      this.sock?.end();
    } catch {}
    this.ev.close(why);
  }

  private onBytes(buf: Uint8Array, key: string) {
    if (this.done) return;
    const all = new Uint8Array(this.head.length + buf.length);
    all.set(this.head);
    all.set(buf, this.head.length);
    this.head = all;
    if (!this.shaken) {
      const text = new TextDecoder().decode(this.head.subarray(0, Math.min(this.head.length, 8192)));
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return this.head.length > 8192 ? this.finish("bad handshake") : undefined;
      const accept = btoa(String.fromCharCode(...new Uint8Array(new Bun.CryptoHasher("sha1").update(key + GUID).digest())));
      if (!/^HTTP\/1\.1 101/.test(text) || !text.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) return this.finish("canvas server refused the upgrade");
      this.head = this.head.subarray(Buffer.byteLength(text.slice(0, end + 4)));
      this.shaken = true;
      this.open = true;
      this.ev.open();
      this.flush();
    }
    this.parse();
  }

  /** Whole frames out of what has arrived; a frame or message over the cap ends the relay instead of being assembled. */
  private parse() {
    for (;;) {
      const b = this.head;
      if (b.length < 2) return;
      const op = b[0] & 15;
      const fin = (b[0] & 0x80) !== 0;
      let len = b[1] & 127;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = (b[2] << 8) | b[3];
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = new DataView(b.buffer, b.byteOffset).getBigUint64(2);
        if (big > BigInt(this.maxBytes())) return this.finish("message too large");
        len = Number(big);
        off = 10;
      }
      const masked = (b[1] & 0x80) !== 0;
      if (len > this.maxBytes()) return this.finish("message too large");
      const total = off + (masked ? 4 : 0) + len;
      if (b.length < total) return;
      let payload = b.slice(off + (masked ? 4 : 0), total);
      if (masked) {
        const m = b.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.head = b.subarray(total);
      if (op === 8) return this.finish();
      if (op === 9) {
        this.sock?.write(encodeFrame(10, payload));
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2) {
        this.fragOp = op;
        this.fragments = [];
        this.fragBytes = 0;
      } else if (op !== 0 || !this.fragOp) return this.finish("bad frame");
      this.fragments.push(payload);
      this.fragBytes += payload.length;
      if (this.fragBytes > this.maxBytes()) return this.finish("message too large");
      if (!fin) continue;
      const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      const kind = this.fragOp;
      this.fragOp = 0;
      this.fragments = [];
      this.fragBytes = 0;
      this.ev.message(kind === 1 ? new TextDecoder().decode(whole) : new Uint8Array(whole));
      if (this.done) return;
    }
  }
}
