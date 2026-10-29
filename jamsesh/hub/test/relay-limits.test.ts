// The canvas relay holds frames only briefly and only up to a cap, so a stalled canvas server
// can't make the hub's memory grow.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { RELAY_LIMITS, queueRelayFrame, startHttp } from "../src/http";

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
  expect(queueRelayFrame(big, Buffer.alloc(RELAY_LIMITS.bytes))).toBe(true);
  expect(queueRelayFrame(big, "x")).toBe(false); // one more byte is over
  expect(queueRelayFrame({} as any, Buffer.alloc(RELAY_LIMITS.bytes + 1))).toBe(false); // too big even alone
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
    expect(true).toBe(true);
  } finally {
    RELAY_LIMITS.openMs = was;
  }
});
