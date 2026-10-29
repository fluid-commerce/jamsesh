// A small client for Facebook's idb companion (`idb_companion`, from `brew install
// facebook/fb/idb-companion`), the one headless way to tap, swipe and stream a Simulator without
// a Simulator window or any macOS permission. It speaks gRPC; the few messages JamSesh needs are
// encoded by hand here (field numbers from idb.proto) instead of adding a protobuf dependency.
// The companion listens on a unix socket in the hub's own folder, never on a port.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import { dirname } from "node:path";

// ---- protobuf, just enough ----
const varint = (n: number) => {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(n));
  while (v > 127) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const lenField = (f: number, body: Uint8Array) => cat(varint(f * 8 + 2), varint(body.length), body);
const intField = (f: number, v: number) => (v ? cat(varint(f * 8), varint(v)) : new Uint8Array());
const dblField = (f: number, v: number) => {
  const b = new Uint8Array(9);
  b[0] = f * 8 + 1;
  new DataView(b.buffer).setFloat64(1, v, true);
  return b;
};
const point = (x: number, y: number) => cat(dblField(1, x), dblField(2, y));

/** Every field of one message: [field number, number | bytes]. Stops at anything malformed. */
export function fields(buf: Uint8Array): [number, number | Uint8Array][] {
  const out: [number, number | Uint8Array][] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const read = () => {
    let v = 0;
    let mul = 1;
    for (let n = 0; n < 10 && i < buf.length; n++) {
      const b = buf[i++]!;
      v += (b & 127) * mul;
      mul *= 128;
      if (b < 128) return v;
    }
    return -1;
  };
  while (i < buf.length) {
    const tag = read();
    if (tag < 0) break;
    const f = Math.floor(tag / 8);
    const w = tag % 8;
    if (w === 0) {
      const v = read();
      if (v < 0) break;
      out.push([f, v]);
    } else if (w === 1) {
      if (i + 8 > buf.length) break;
      out.push([f, dv.getFloat64(i, true)]);
      i += 8;
    } else if (w === 2) {
      const n = read();
      if (n < 0 || i + n > buf.length) break;
      out.push([f, buf.subarray(i, i + n)]);
      i += n;
    } else if (w === 5) {
      i += 4;
    } else break;
  }
  return out;
}
const num = (fs: [number, number | Uint8Array][], f: number) => {
  const v = fs.find(([k, x]) => k === f && typeof x === "number")?.[1];
  return typeof v === "number" ? v : 0;
};
const bytes = (fs: [number, number | Uint8Array][], f: number) => {
  const v = fs.find(([k, x]) => k === f && typeof x !== "number")?.[1];
  return typeof v === "number" ? undefined : v;
};

// ---- the messages ----
const hidPress = (action: Uint8Array, up: boolean) => lenField(1, cat(lenField(1, action), intField(2, up ? 1 : 0)));
const hidDelay = (seconds: number) => lenField(3, dblField(1, seconds));
const touchAction = (x: number, y: number) => lenField(1, lenField(1, point(x, y)));
const buttonAction = (button: number) => lenField(2, intField(1, button));

export const BUTTON = { home: 1, lock: 2, side: 3, siri: 4 } as const;
export const ORIENTATION = { portrait: 0, upsideDown: 1, landscapeLeft: 2, landscapeRight: 3 } as const;

// ---- typing: a US keyboard as HID usage codes (the Keyboard page of the USB HID spec) ----
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "1234567890";
// Unshifted symbol keys and what shift turns them into.
const SYMBOLS: [string, string, number][] = [["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49], [";", ":", 51], ["'", '"', 52], ["`", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56]];
const SHIFTED_DIGITS = "!@#$%^&*()";
export const KEY_SHIFT = 225;
const SHIFT_BEAT = 0.03;
export const NAMED_KEYS = { return: 40, delete: 42, tab: 43, escape: 41 } as const;

/** One character as a key press: its HID code and whether shift is held. Null for anything a US keyboard can't type. */
export function hidKey(ch: string): { code: number; shift: boolean } | null {
  if (ch.length !== 1) return null;
  const lower = LETTERS.indexOf(ch.toLowerCase());
  if (lower >= 0) return { code: 4 + lower, shift: ch !== ch.toLowerCase() };
  const d = DIGITS.indexOf(ch);
  if (d >= 0) return { code: 30 + d, shift: false };
  const sd = SHIFTED_DIGITS.indexOf(ch);
  if (sd >= 0) return { code: 30 + sd, shift: true };
  if (ch === " ") return { code: 44, shift: false };
  if (ch === "\n") return { code: NAMED_KEYS.return, shift: false };
  if (ch === "\t") return { code: NAMED_KEYS.tab, shift: false };
  for (const [plain, shifted, code] of SYMBOLS) {
    if (ch === plain) return { code, shift: false };
    if (ch === shifted) return { code, shift: true };
  }
  return null;
}

/** Key down/up steps for a whole string (shift pressed around each capital or symbol), or null if any character can't be typed. */
export function hidSteps(text: string): { code: number; down: boolean }[] | null {
  const out: { code: number; down: boolean }[] = [];
  for (const ch of text) {
    const k = hidKey(ch);
    if (!k) return null;
    if (k.shift) out.push({ code: KEY_SHIFT, down: true });
    out.push({ code: k.code, down: true }, { code: k.code, down: false });
    if (k.shift) out.push({ code: KEY_SHIFT, down: false });
  }
  return out;
}

/** What a Simulator's screen is: device pixels and the points taps are given in. */
export interface ScreenInfo {
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  density: number;
}

const frame = (msg: Uint8Array) => {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
};

/** The companion binary, when it's installed. */
export function companionPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(":").concat(["/opt/homebrew/bin", "/usr/local/bin"]);
  for (const d of dirs) if (d && existsSync(`${d}/idb_companion`)) return `${d}/idb_companion`;
  return null;
}

/** One running companion for one Simulator, and the calls JamSesh makes on it. */
export class Companion {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private conn: http2.ClientHttp2Session | null = null;
  private dead = false;
  /** Set when the companion goes away (the device was shut down or deleted, or it crashed). */
  onExit: () => void = () => {};

  constructor(
    readonly udid: string,
    readonly sock: string,
  ) {}

  /** Starts the companion and waits for its socket. Resolves to an error in words, or null. */
  async start(bin = companionPath()): Promise<string | null> {
    if (!bin) return "idb_companion isn't installed (brew install facebook/fb/idb-companion).";
    mkdirSync(dirname(this.sock), { recursive: true });
    try {
      unlinkSync(this.sock);
    } catch {}
    this.proc = Bun.spawn([bin, "--udid", this.udid, "--grpc-domain-sock", this.sock, "--log-level", "info", "--terminate-offline", "1"], { stdout: "ignore", stderr: "ignore" });
    void this.proc.exited.then(() => {
      if (!this.dead) (this.stop(), this.onExit());
    });
    for (let i = 0; i < 100; i++) {
      if (this.dead) return "The companion stopped.";
      if (existsSync(this.sock) && (await this.describe().catch(() => null))) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.stop();
    return "The companion didn't start in time.";
  }

  stop() {
    this.dead = true;
    try {
      this.conn?.destroy();
    } catch {}
    this.conn = null;
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    try {
      unlinkSync(this.sock);
    } catch {}
  }

  private session() {
    if (this.dead) throw new Error("The companion has stopped.");
    if (!this.conn || this.conn.closed || this.conn.destroyed) {
      const c = http2.connect("http://localhost", { createConnection: () => net.connect(this.sock) });
      c.on("error", () => {});
      c.on("close", () => {
        if (this.conn === c) this.conn = null;
      });
      this.conn = c;
    }
    return this.conn;
  }

  /** One call: send these messages, collect every message that comes back. `onMessage` sees streamed ones as they arrive. */
  private call(method: string, sends: Uint8Array[], opts: { onMessage?: (m: Uint8Array) => void; timeoutMs?: number; keepOpen?: boolean } = {}) {
    return new Promise<{ messages: Uint8Array[]; cancel: () => void }>((resolve, reject) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session().request({ ":method": "POST", ":path": `/idb.CompanionService/${method}`, "content-type": "application/grpc", te: "trailers" });
      } catch (e) {
        return reject(e);
      }
      const messages: Uint8Array[] = [];
      let buf = new Uint8Array();
      // A call worked only if the companion answered (HTTP 200) and said so (grpc-status 0). A call cut off before
      // it said anything (the companion crashed mid-tap) may or may not have happened: that's a failure, never a success.
      let answered = false;
      let status: string | null = null;
      let message = "";
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else if (!answered || status === null) reject(new Error(`${method}: the Simulator's companion stopped before saying whether it worked.`));
        else if (status !== "0") reject(new Error(message || `gRPC status ${status}`));
        else resolve({ messages, cancel });
      };
      const cancel = () => {
        try {
          req.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
      };
      const timer = setTimeout(() => (cancel(), finish(new Error(`${method} timed out`))), opts.timeoutMs ?? 10_000);
      req.on("response", (h) => {
        answered = h[":status"] === 200;
        if (h["grpc-status"] != null) status = String(h["grpc-status"]);
        if (h["grpc-message"] != null) message = decodeURIComponent(String(h["grpc-message"]));
      });
      req.on("trailers", (h) => {
        if (h["grpc-status"] != null) status = String(h["grpc-status"]);
        if (h["grpc-message"] != null) message = decodeURIComponent(String(h["grpc-message"]));
      });
      req.on("data", (chunk: Buffer) => {
        buf = cat(buf, chunk);
        while (buf.length >= 5) {
          const n = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
          if (buf.length < 5 + n) break;
          const m = buf.slice(5, 5 + n);
          buf = buf.slice(5 + n);
          if (opts.onMessage) opts.onMessage(m);
          else messages.push(m);
        }
      });
      req.on("end", () => finish());
      req.on("error", (e) => finish(e));
      req.on("close", () => finish());
      for (const s of sends) req.write(frame(s));
      if (!opts.keepOpen) req.end();
      if (opts.keepOpen) resolve({ messages, cancel });
    });
  }

  async describe(): Promise<ScreenInfo | null> {
    const { messages } = await this.call("describe", [new Uint8Array()], { timeoutMs: 3000 });
    const first = messages[0];
    if (!first) return null;
    const td = bytes(fields(first), 1);
    const sd = td && bytes(fields(td), 3);
    if (!sd) return null;
    const f = fields(sd);
    const info = { widthPx: num(f, 1), heightPx: num(f, 2), density: num(f, 3), widthPt: num(f, 4), heightPt: num(f, 5) };
    return info.widthPx > 0 && info.heightPx > 0 && info.widthPt > 0 && info.heightPt > 0 ? info : null;
  }

  /** A tap at a point in the screen's points. */
  async tap(x: number, y: number) {
    const a = touchAction(x, y);
    await this.call("hid", [hidPress(a, false), hidPress(a, true)]);
  }

  /** A drag from one point to another in `seconds`. */
  async swipe(x1: number, y1: number, x2: number, y2: number, seconds = 0.3) {
    await this.call("hid", [lenField(2, cat(lenField(1, point(x1, y1)), lenField(2, point(x2, y2)), dblField(6, seconds)))]);
  }

  async button(name: keyof typeof BUTTON) {
    const a = buttonAction(BUTTON[name]);
    await this.call("hid", [hidPress(a, false), hidPress(a, true)]);
  }

  /** Types text (a US keyboard; throws on a character it can't type). */
  async type(text: string) {
    const steps = hidSteps(text);
    if (!steps) throw new Error("That text has characters a US keyboard can't type.");
    // Shift needs a beat on each side of the key, or the Simulator sees the key without it.
    const msgs: Uint8Array[] = [];
    for (const k of steps) {
      if (k.code === KEY_SHIFT && !k.down) msgs.push(hidDelay(SHIFT_BEAT));
      msgs.push(hidPress(lenField(3, intField(1, k.code)), !k.down));
      if (k.code === KEY_SHIFT && k.down) msgs.push(hidDelay(SHIFT_BEAT));
    }
    await this.call("hid", msgs, { timeoutMs: 10_000 + steps.length * 100 });
  }

  async key(name: keyof typeof NAMED_KEYS) {
    await this.call("hid", [true, false].map((down) => hidPress(lenField(3, intField(1, NAMED_KEYS[name])), !down)));
  }

  async orientation(o: number) {
    await this.call("hid", [lenField(5, intField(1, o))]);
  }
}
