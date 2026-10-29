// Every helper process the hub starts is in one registry that Hub.stop walks, local whisper included,
// and none outlives a hub that is killed outright.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { Hub } from "../src/hub";

const dir = mkdtempSync(join(tmpdir(), "jam-reap-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A whisper-server stand-in: answers HTTP on --port, records its pid, and can ignore SIGTERM. */
function fakeWhisper(name: string, ignoreTerm = false) {
  const script = join(dir, `${name}.ts`);
  const pidFile = join(dir, `${name}.pid`);
  writeFileSync(script, `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
`);
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "model.bin"), "");
  return { bin, pidFile };
}
const freePort = () => {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z");
};
async function until(fn: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await Bun.sleep(100);
  return fn();
}
function withWhisper<T>(bin: string, run: () => Promise<T>) {
  const was = { bin: config.whisperServerBin, model: config.whisperModel };
  (config as any).whisperServerBin = bin;
  (config as any).whisperModel = join(dir, "model.bin");
  return run().finally(() => {
    (config as any).whisperServerBin = was.bin;
    (config as any).whisperModel = was.model;
  });
}

test("Hub.stop stops a local whisper the hub started (one that ignores SIGTERM too), and is true only when every exit was seen", () =>
  withWhisper(fakeWhisper("whisper-a", true).bin, async () => {
    const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "a") });
    expect(await hub.transcriber.startLocal(freePort())).toBe(true);
    const pid = Number(readFileSync(join(dir, "whisper-a.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    expect(hub.helpers.size).toBe(1);
    expect(await hub.stop()).toBe(true);
    expect(await until(() => !alive(pid), 2_000)).toBe(true); // SIGKILL lands a few ms after the wrapper's exit is seen
    expect(hub.helpers.size).toBe(0);
  }), 30_000);

test("Hub.stop says false when one helper's exit is never seen, and still stops the rest", () =>
  withWhisper(fakeWhisper("whisper-b").bin, async () => {
    const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "b") });
    expect(await hub.transcriber.startLocal(freePort())).toBe(true);
    const pid = Number(readFileSync(join(dir, "whisper-b.pid"), "utf8"));
    hub.helpers.track({ pid: 999999, exited: new Promise<number>(() => {}), kill: () => {} });
    expect(await hub.stop()).toBe(false);
    expect(alive(pid)).toBe(false);
  }), 30_000);

test("a local whisper dies within seconds of its hub being killed outright", async () => {
  const { bin, pidFile } = fakeWhisper("whisper-c");
  const code = `
    import { config } from ${JSON.stringify(import.meta.dir + "/../src/config")};
    import { Transcriber } from ${JSON.stringify(import.meta.dir + "/../src/audio/transcribe")};
    config.whisperServerBin = ${JSON.stringify(bin)};
    config.whisperModel = ${JSON.stringify(join(dir, "model.bin"))};
    console.log(await new Transcriber({} as any).startLocal(${freePort()}));
    await Bun.sleep(300000);
  `;
  const hub = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit", env: { ...process.env, JAMSESH_SILENT: "1", JAMSESH_OFFLINE: "1" } });
  try {
    const { value } = await hub.stdout.getReader().read();
    expect(new TextDecoder().decode(value).trim()).toBe("true");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    hub.kill("SIGKILL");
    expect(await until(() => !alive(pid), 8000)).toBe(true);
  } finally {
    hub.kill("SIGKILL");
  }
}, 30_000);

test("whisper can't start during or after Hub.stop, and no process is left", () =>
  withWhisper(fakeWhisper("whisper-d").bin, async () => {
    const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
    const during = hub.transcriber.startLocal(freePort()); // blocked on its ping
    const stopping = hub.stop(); // closes the registry before the start gets to spawn
    expect(await during).toBe(false);
    expect(await stopping).toBe(true);
    expect(await hub.transcriber.startLocal(freePort())).toBe(false); // after stop
    expect(hub.helpers.size).toBe(0);
    expect(existsSync(join(dir, "whisper-d.pid"))).toBe(false); // never ran
  }), 30_000);
