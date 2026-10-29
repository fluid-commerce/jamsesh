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
    // No watchdog or reaper yet for a canvas that never started; a retry is scheduled instead.
    expect(canvas.timers).toEqual([]);
    expect(canvas.startRetry).not.toBeNull();
    canvas.stop();
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

test("a resync that works after a failed one makes the canvas live again, under a new generation", async () => {
  const session = { canvas: { status: "live", generation: 3, editLink: "figcraft://join?host=10.0.0.2:47900&file=a&token=t", viewLink: "figcraft://join?host=10.0.0.2:47900&file=a&token=v" } as any, setCanvas(info: any) { this.canvas = { ...this.canvas, ...info }; } };
  let live = false;
  const host = { alive: true, command: async (cmd: string) => (cmd === "collab.peers" ? { status: live ? "live" : "failed", reason: "gone" } : {}) };
  const canvas: any = { host, polling: false, stopped: false, recovering: false, session, agents: new Map(), port: 47900 };
  for (const k of ["resync", "recover", "backLive", "announce", "localLink", "loopLink"]) canvas[k] = (Canvas.prototype as any)[k];
  await canvas.resync("test: first try");
  expect(session.canvas.status).toBe("failed");
  live = true;
  await canvas.resync("test: second try");
  expect(session.canvas.status).toBe("live");
  expect(session.canvas.generation).toBe(4);
  expect(session.canvas.reason).toBeNull();
  // A resync while live leaves the generation alone: people's canvases don't rejoin for nothing.
  await canvas.resync("test: routine");
  expect(session.canvas.generation).toBe(4);
}, 60_000);

test("the watchdog makes a failed canvas live again once the server answers and the host is in the session", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const session = { canvas: { status: "failed", generation: 1, editLink: "e", viewLink: "v", reason: "x" } as any, setCanvas(info: any) { this.canvas = { ...this.canvas, ...info }; } };
    const canvas: any = { host: { alive: true, command: async () => ({ status: "live", peers: [] }) }, polling: false, stopped: false, recovering: false, session, agents: new Map(), serverUrl: `http://127.0.0.1:${server.port}`, revive: async () => {}, resync: async () => {} };
    for (const k of ["watchdog", "backLive", "announce"]) canvas[k] = (Canvas.prototype as any)[k];
    await canvas.watchdog();
    expect(session.canvas).toMatchObject({ status: "live", generation: 2, reason: null });
  } finally {
    server.stop(true);
  }
});

/** A stand-in for start()'s collaborators: each step can fail. */
function startable(steps: { server?: () => Promise<void>; host?: () => Promise<void> }) {
  const log: string[] = [];
  const session = { canvas: { status: "off" } as any, setCanvas(info: any) { this.canvas = { ...this.canvas, ...info }; } };
  const canvas: any = { session, stopped: false, startFailures: 0, startRetry: null, timers: [], poller: null, agents: new Map(), host: null, serverProc: null };
  for (const k of ["start", "stop"]) canvas[k] = (Canvas.prototype as any)[k];
  canvas.poll = () => {};
  canvas.reapIdleAgents = () => {};
  canvas.watchdog = async () => {};
  canvas.startServer = async () => {
    log.push("server");
    // The server process this start spawned.
    canvas.serverProc = { pid: 1, exited: Promise.resolve(0), kill: () => void log.push("server stopped") };
    await steps.server?.();
  };
  canvas.startHost = async () => {
    log.push("host");
    canvas.host = { alive: true, close: () => void log.push("host closed") };
    await steps.host?.();
  };
  return { canvas, session, log };
}

test("a failed first start cleans up what it started and is tried again, backing off, until it works", async () => {
  const was = Canvas.START_RETRY_MS;
  Canvas.START_RETRY_MS = 20;
  try {
    let hostFails = 2;
    const { canvas, session, log } = startable({ host: async () => void (hostFails-- > 0 && (() => { throw new Error("figcraft-cli exited"); })()) });
    await canvas.start();
    expect(session.canvas).toMatchObject({ status: "failed", reason: "figcraft-cli exited" });
    expect(log).toEqual(["server", "host", "host closed", "server stopped"]);
    expect(canvas.host).toBeNull();
    expect(canvas.serverProc).toBeNull();
    expect(canvas.timers).toEqual([]);
    await Bun.sleep(150); // retried at 20 ms, failed again, then at 40 ms, which works
    expect(log.filter((l) => l === "server")).toHaveLength(3);
    expect(canvas.timers).toHaveLength(2);
    expect(canvas.startFailures).toBe(0);
    canvas.stop();
  } finally {
    Canvas.START_RETRY_MS = was;
  }
});

test("a server that fails to start is retried a bounded number of times, and stop() cancels the retry", async () => {
  const was = { ms: Canvas.START_RETRY_MS, n: Canvas.START_RETRIES };
  Canvas.START_RETRY_MS = 5;
  Canvas.START_RETRIES = 2;
  try {
    const { canvas, log } = startable({ server: async () => { throw new Error("no free port"); } });
    await canvas.start();
    await Bun.sleep(150);
    expect(log.filter((l) => l === "server")).toHaveLength(3); // the first try and 2 retries
    expect(canvas.startRetry).toBeNull();
    const again = startable({ server: async () => { throw new Error("no free port"); } });
    await again.canvas.start();
    again.canvas.stop();
    await Bun.sleep(50);
    expect(again.log.filter((l) => l === "server")).toHaveLength(1);
  } finally {
    Canvas.START_RETRY_MS = was.ms;
    Canvas.START_RETRIES = was.n;
  }
});

test("a healthy canvas server's stderr is drained the whole time it runs, keeping only the latest", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { config } = await import("../src/config");
  const dir = mkdtempSync(join(tmpdir(), "jam-canvas-log-"));
  mkdirSync(join(dir, "bin"));
  // Healthy on its port, and writing far more to stderr than a pipe holds.
  const server = join(dir, "bin", "server.ts");
  writeFileSync(server, `const port = Number(process.argv[process.argv.indexOf("--listen") + 1].split(":")[1]);
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
let n = 0;
setInterval(() => { for (let i = 0; i < 50; i++) process.stderr.write("line " + (n++) + " " + "x".repeat(200) + "\\n"); }, 5);
`);
  const bin = join(dir, "bin", "figcraft-server");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
  chmodSync(bin, 0o755);
  const was = { bin: config.figcraftServerBin, data: config.dataDir, port: config.figcraftPort };
  (config as any).figcraftServerBin = bin;
  (config as any).dataDir = dir;
  (config as any).figcraftPort = 47_000 + Math.floor(Math.random() * 2000);
  const settings = new Map<string, unknown>();
  const session: any = { canvas: { status: "off" }, setCanvas(i: any) { this.canvas = { ...this.canvas, ...i }; }, store: { setting: (k: string, d: unknown) => settings.get(k) ?? d, setSetting: (k: string, v: unknown) => void settings.set(k, v) } };
  const canvas: any = new Canvas(session);
  try {
    await canvas.startServer();
    await Bun.sleep(1500); // well past what a pipe buffer holds
    const healthy = await fetch(`http://127.0.0.1:${canvas.port}/healthz`).then((r) => r.ok).catch(() => false);
    expect(healthy).toBe(true);
    expect(canvas.serverLog.length).toBeLessThanOrEqual(Canvas.SERVER_LOG_MAX);
    const lines = [...canvas.serverLog.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...lines)).toBeGreaterThan(1000); // it kept writing, and we kept the latest
  } finally {
    canvas.stop();
    if (canvas.serverProc) await canvas.serverProc.exited;
    (config as any).figcraftServerBin = was.bin;
    (config as any).dataDir = was.data;
    (config as any).figcraftPort = was.port;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
