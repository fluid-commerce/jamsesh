// The canvas relay holds frames only briefly and only up to a cap, so a stalled canvas server
// can't make the hub's memory grow.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { FRAME_OVERHEAD } from "../src/relay";
import { RELAY_LIMITS, queueRelayFrame, relayDown, relayUp, startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-relay-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
// A canvas server that accepts connections and never answers the WebSocket handshake.
const stalled = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
(hub.canvas as any).port = stalled.port;
afterAll(() => {
  server.stop(true);
  stalled.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/?x=1`);
  const closed = new Promise<{ code: number }>((r) => (ws.onclose = (e) => r({ code: e.code })));
  const opened = new Promise<void>((r) => (ws.onopen = () => r()));
  return { ws, closed, opened };
}

test("frames are held up to the frame and byte caps, then refused", () => {
  const data = {} as any;
  for (let i = 0; i < RELAY_LIMITS.frames; i++) expect(queueRelayFrame(data, "x")).toBe(true);
  expect(queueRelayFrame(data, "x")).toBe(false);
  const big = {} as any;
  expect(queueRelayFrame(big, Buffer.alloc(RELAY_LIMITS.bytes - FRAME_OVERHEAD))).toBe(true);
  expect(queueRelayFrame(big, "")).toBe(false); // even an empty frame is over: each costs its overhead
  expect(queueRelayFrame({} as any, Buffer.alloc(RELAY_LIMITS.bytes))).toBe(false); // too big even alone
});

test("a client that keeps sending while the canvas server is stalled is closed with a retryable code", async () => {
  const was = RELAY_LIMITS.frames;
  RELAY_LIMITS.frames = 20;
  try {
    const { ws, closed, opened } = client();
    await opened;
    for (let i = 0; i < 100; i++) ws.send("frame");
    expect((await closed).code).toBe(1013);
  } finally {
    RELAY_LIMITS.frames = was;
  }
});

test("a canvas server that never opens ends the relay after the deadline, even when the client is quiet", async () => {
  const was = RELAY_LIMITS.openMs;
  RELAY_LIMITS.openMs = 300;
  try {
    const { closed, opened } = client();
    await opened;
    const t = Date.now();
    expect((await closed).code).toBe(1013);
    expect(Date.now() - t).toBeLessThan(3000);
  } finally {
    RELAY_LIMITS.openMs = was;
  }
});

test("a client that leaves before the canvas server opens leaves no timer or queue behind", async () => {
  const was = RELAY_LIMITS.openMs;
  RELAY_LIMITS.openMs = 400;
  try {
    const { ws, closed, opened } = client();
    await opened;
    ws.send("frame");
    ws.close();
    await closed;
    await Bun.sleep(700); // the deadline passes with nobody to close; nothing throws
    // The server is unharmed by the stale deadline: a new client still gets its own relay.
    const again = client();
    await again.opened;
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    again.ws.close();
    await again.closed;
  } finally {
    RELAY_LIMITS.openMs = was;
  }
});

/** What a fake socket records, standing in for the Bun server socket and its upstream. */
function fakeRelay(opts: { sendResult?: number; buffered?: number; refuse?: boolean; open?: boolean }) {
  const log = { closed: [] as (number | undefined)[], upClosed: 0, sent: 0, upSent: 0 };
  const up = { open: opts.open !== false, send() { log.upSent++; return !opts.refuse; }, close() { log.upClosed++; } };
  const ws: any = { data: { upstream: up, collab: "/x" }, send() { log.sent++; return opts.sendResult ?? 1; }, getBufferedAmount: () => opts.buffered ?? 0, close(code?: number) { log.closed.push(code); } };
  return { ws, log };
}

test("after the canvas server opens, a client frame ends the relay once the upstream says it is holding too much", () => {
  const ok = fakeRelay({});
  relayUp(ok.ws, "frame");
  expect(ok.log).toMatchObject({ upSent: 1, closed: [], upClosed: 0 });
  const stuck = fakeRelay({ refuse: true });
  relayUp(stuck.ws, "frame");
  expect(stuck.log).toMatchObject({ closed: [1013], upClosed: 1 });
});

test("a client that stopped draining ends the relay (a dropped send, or too much held)", () => {
  const fine = fakeRelay({});
  relayDown(fine.ws, "x");
  expect(fine.log.closed).toEqual([]);
  const dropped = fakeRelay({ sendResult: 0 });
  relayDown(dropped.ws, new Uint8Array(4));
  expect(dropped.log).toMatchObject({ closed: [1013], upClosed: 1 });
  const held = fakeRelay({ buffered: RELAY_LIMITS.bytes + 1 });
  relayDown(held.ws, "x");
  expect(held.log).toMatchObject({ closed: [1013], upClosed: 1 });
});

test("frames and messages cross the relay both ways, large and binary ones intact", async () => {
  const echo = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })), websocket: { message: (ws, m) => void ws.send(m) } });
  const was = (hub.canvas as any).port;
  (hub.canvas as any).port = echo.port;
  try {
    const { ws, opened } = client();
    ws.binaryType = "arraybuffer";
    const got: any[] = [];
    ws.onmessage = (e) => got.push(e.data);
    await opened;
    const big = "y".repeat(300_000);
    const bin = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
    ws.send("hello");
    ws.send(big);
    ws.send(bin);
    for (let i = 0; i < 100 && got.length < 3; i++) await Bun.sleep(50);
    expect(got[0]).toBe("hello");
    expect(got[1]).toBe(big);
    expect(new Uint8Array(got[2])).toEqual(bin);
    ws.close();
  } finally {
    (hub.canvas as any).port = was;
    echo.stop(true);
  }
});

test("a canvas server that completes the handshake and then stops reading ends the relay with a retryable close", async () => {
  // A raw upstream: answers the WebSocket upgrade, then stops reading its socket.
  const sockets: import("node:net").Socket[] = [];
  const upstream = createServer((sock) => {
    sockets.push(sock);
    sock.once("data", (buf) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buf.toString())?.[1] ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sock.pause();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as any).port;
  const was = { port: (hub.canvas as any).port, bytes: RELAY_LIMITS.bytes };
  (hub.canvas as any).port = port;
  RELAY_LIMITS.bytes = 256 * 1024;
  try {
    const { ws, closed, opened } = client();
    await opened;
    await Bun.sleep(300); // the handshake completes: the queue is out of the picture
    const chunk = "x".repeat(512 * 1024);
    for (let i = 0; i < 80 && ws.readyState === WebSocket.OPEN; i++) {
      ws.send(chunk);
      await Bun.sleep(10);
    }
    expect((await closed).code).toBe(1013);
  } finally {
    RELAY_LIMITS.bytes = was.bytes;
    (hub.canvas as any).port = was.port;
    for (const s of sockets) s.destroy();
    upstream.close();
  }
}, 20_000);

test("empty frames count against the cap too, after the canvas server has opened", async () => {
  const sockets: import("node:net").Socket[] = [];
  const upstream = createServer((sock) => {
    sockets.push(sock);
    sock.once("data", (buf) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buf.toString())?.[1] ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sock.pause();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const was = { port: (hub.canvas as any).port, bytes: RELAY_LIMITS.bytes };
  (hub.canvas as any).port = (upstream.address() as any).port;
  RELAY_LIMITS.bytes = 64 * 1024; // the kernel buffers more than this, so only the count of held frames can end it
  try {
    const { Upstream } = await import("../src/relay");
    // Direct: the held count rises by the overhead for each empty frame until send() refuses.
    const up = new Upstream((upstream.address() as any).port, "/", { open() {}, message() {}, close() {} }, () => RELAY_LIMITS.bytes);
    for (let i = 0; i < 200 && !up.open; i++) await Bun.sleep(10);
    expect(up.open).toBe(true);
    // Fill the kernel's buffers first (a paused peer takes a few hundred KB), then empty frames must hit the cap.
    const big = new Uint8Array(32 * 1024);
    let refused = false;
    for (let i = 0; i < 100_000 && !refused; i++) {
      if (!up.send(i < 400 ? big : "")) refused = true;
    }
    expect(refused).toBe(true);
    expect(up.held).toBeLessThanOrEqual(RELAY_LIMITS.bytes);
    up.close();
  } finally {
    RELAY_LIMITS.bytes = was.bytes;
    (hub.canvas as any).port = was.port;
    for (const s of sockets) s.destroy();
    upstream.close();
  }
}, 20_000);
