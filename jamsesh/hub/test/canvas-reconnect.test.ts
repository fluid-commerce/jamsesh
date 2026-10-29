// People's canvases rejoin when the host publishes the canvas again, and the host starts the
// canvas server again when it stops (it crashed, or something killed it).
import { expect, test } from "bun:test";
import { Canvas } from "../src/canvas/canvas";

test("each announcement of the canvas is a new generation, so people's canvases fetch their link again", () => {
  const session = {
    canvas: { status: "off", generation: 0 } as any,
    setCanvas(info: any) {
      this.canvas = { ...this.canvas, ...info };
    },
  };
  const announce = (Canvas.prototype as any).announce;
  announce.call({ session }, "figcraft://join?host=10.0.0.2:47900&file=a&token=t", "figcraft://join?host=10.0.0.2:47900&file=a&token=v");
  expect(session.canvas.generation).toBe(1);
  expect(session.canvas.status).toBe("live");
  announce.call({ session }, "figcraft://join?host=10.0.0.2:47900&file=b&token=t", "figcraft://join?host=10.0.0.2:47900&file=b&token=v");
  expect(session.canvas.generation).toBe(2);
});

function fakeCanvas(serverUrl: string) {
  const calls: string[] = [];
  return {
    calls,
    canvas: {
      host: { alive: true, command: async () => ({ status: "live", peers: [] }) },
      polling: false,
      agents: new Map(),
      session: { canvas: { status: "live" } },
      serverUrl,
      revive: async () => void calls.push("revive"),
      resync: async (why: string) => void calls.push(`resync: ${why}`),
    },
  };
}

test("the watchdog starts the canvas server again when it stopped answering", async () => {
  const { canvas, calls } = fakeCanvas("http://127.0.0.1:1");
  await (Canvas.prototype as any).watchdog.call(canvas);
  expect(calls).toEqual(["revive"]);
});

test("a canvas server that answers is left alone", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const { canvas, calls } = fakeCanvas(`http://127.0.0.1:${server.port}`);
    await (Canvas.prototype as any).watchdog.call(canvas);
    expect(calls).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("a dead host canvas process is started again; if that fails the canvas says so", async () => {
  const calls: string[] = [];
  const session = { canvas: { status: "live" } as any, setCanvas(info: any) { this.canvas = { ...this.canvas, ...info }; } };
  const dead = { alive: false, close: () => void calls.push("close") };
  const canvas: any = { host: dead, polling: false, stopped: false, recovering: false, session, agents: new Map(), serverUrl: "http://127.0.0.1:1" };
  canvas.restartHost = (Canvas.prototype as any).restartHost;
  canvas.recover = (Canvas.prototype as any).recover;
  canvas.startHost = async () => {
    calls.push("startHost");
    canvas.host = { alive: true };
  };
  await (Canvas.prototype as any).watchdog.call(canvas);
  expect(calls).toEqual(["close", "startHost"]);
  expect(canvas.host.alive).toBe(true);
  // It can't come back: the canvas is marked failed instead of looking live.
  canvas.host = dead;
  canvas.startHost = async () => {
    throw new Error("figcraft-cli exited");
  };
  await (Canvas.prototype as any).watchdog.call(canvas);
  expect(session.canvas.status).toBe("failed");
  expect(session.canvas.reason).toContain("didn't come back");
  expect(canvas.recovering).toBe(false);
  // A stopped canvas is left alone.
  calls.length = 0;
  canvas.stopped = true;
  await (Canvas.prototype as any).watchdog.call(canvas);
  expect(calls).toEqual([]);
});

test("a canvas server that runs but never gets healthy is stopped, and start() fails instead of hanging", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { config } = await import("../src/config");
  const dir = mkdtempSync(join(tmpdir(), "jam-canvas-start-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "bin"));
  const bin = join(dir, "bin", "figcraft-server");
  // Alive, holding stderr open, never answering /healthz.
  writeFileSync(bin, "#!/bin/sh\necho 'listening failed: address in use' >&2\nexec sleep 60\n");
  chmodSync(bin, 0o755);
  const was = { bin: config.figcraftServerBin, data: config.dataDir, tries: Canvas.START_TRIES };
  (config as any).figcraftServerBin = bin;
  (config as any).dataDir = dir;
  Canvas.START_TRIES = 2;
  const settings = new Map<string, unknown>();
  const session: any = { canvas: { status: "off" }, setCanvas(i: any) { this.canvas = { ...this.canvas, ...i }; }, store: { setting: (k: string, d: unknown) => settings.get(k) ?? d, setSetting: (k: string, v: unknown) => void settings.set(k, v) } };
  try {
    const canvas: any = new Canvas(session);
    const t0 = Date.now();
    await canvas.start();
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(session.canvas.status).toBe("failed");
    expect(session.canvas.reason).toContain("didn't start: listening failed: address in use");
    expect(canvas.serverProc).toBeNull();
    // No watchdog or reaper left running for a canvas that never started.
    expect(canvas.timers).toEqual([]);
  } finally {
    (config as any).figcraftServerBin = was.bin;
    (config as any).dataDir = was.data;
    Canvas.START_TRIES = was.tries;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("stop() clears the watchdog and the reaper", () => {
  const cleared: unknown[] = [];
  const real = globalThis.clearInterval;
  globalThis.clearInterval = ((t: any) => (cleared.push(t), real(t))) as any;
  try {
    const a = setInterval(() => {}, 60_000);
    const b = setInterval(() => {}, 30_000);
    const canvas: any = { poller: null, timers: [a, b], agents: new Map(), host: null, serverProc: null };
    (Canvas.prototype as any).stop.call(canvas);
    expect(cleared).toEqual([a, b]);
    expect(canvas.stopped).toBe(true);
    expect(canvas.timers).toEqual([]);
  } finally {
    globalThis.clearInterval = real;
  }
});

test("a failed canvas server restart marks the canvas failed instead of leaving it live, and is retried", async () => {
  const session = { canvas: { status: "live", editLink: "x" } as any, setCanvas(info: any) { this.canvas = { ...this.canvas, ...info }; }, store: { setting: () => null } };
  let starts = 0;
  const canvas: any = { host: { alive: true }, polling: false, stopped: false, recovering: false, session, agents: new Map(), serverUrl: "http://127.0.0.1:1", serverProc: null };
  for (const k of ["watchdog", "revive", "recover"]) canvas[k] = (Canvas.prototype as any)[k];
  canvas.startServer = async () => {
    starts++;
    throw new Error("figcraft-server didn't start: address in use");
  };
  await canvas.watchdog();
  expect(session.canvas.status).toBe("failed");
  expect(session.canvas.reason).toContain("didn't start");
  // Still down on the next round: tried again, not left for dead.
  await canvas.watchdog();
  expect(starts).toBe(2);
  // One recovery at a time.
  let release!: () => void;
  canvas.startServer = () => new Promise<void>((r) => (release = () => r()));
  const first = canvas.revive();
  await canvas.revive();
  release();
  await first;
  expect(canvas.recovering).toBe(false);
});
