import { expect, test } from "bun:test";
import { HelperRegistry, stopHelper, withParentWatch } from "../src/children";

/** Running: a killed process its new parent hasn't reaped yet (a zombie) holds nothing and counts as gone. */
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
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(100);
  }
  return fn();
}

/** A stand-in hub: a Bun process that starts `sleep 300` under the watcher and prints its pid. */
async function standInHub() {
  const code = `
    import { withParentWatch } from ${JSON.stringify(import.meta.dir + "/../src/children")};
    const p = Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(600);
    const kids = Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim();
    console.log(JSON.stringify({ wrapper: p.pid, sleeper: Number(kids.split("\\n")[0]) }));
    await Bun.sleep(300000);
  `;
  const hub = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
  const reader = hub.stdout.getReader();
  const { value } = await reader.read();
  const pids = JSON.parse(new TextDecoder().decode(value)) as { wrapper: number; sleeper: number };
  return { hub, ...pids };
}

test("a helper dies within seconds of its hub being killed outright", async () => {
  const { hub, wrapper, sleeper } = await standInHub();
  expect(alive(sleeper)).toBe(true);
  hub.kill("SIGKILL");
  expect(await until(() => !alive(sleeper) && !alive(wrapper), 5000)).toBe(true);
});

test("stopping the wrapper stops the helper at once", async () => {
  const p = Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(400);
  const sleeper = Number(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim().split("\n")[0]);
  expect(alive(sleeper)).toBe(true);
  p.kill();
  await p.exited;
  expect(await until(() => !alive(sleeper), 3000)).toBe(true);
});

test("a helper that exits on its own passes its exit status through", async () => {
  const p = Bun.spawn(withParentWatch(["sh", "-c", "exit 7"]), { stdio: ["ignore", "ignore", "ignore"] });
  expect(await p.exited).toBe(7);
});

test("stopping the wrapper returns only after the helper has let go", async () => {
  const p = Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(400);
  const sleeper = Number(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim().split("\n")[0]);
  p.kill();
  await p.exited;
  // No polling: the wrapper waited for it.
  expect(alive(sleeper)).toBe(false);
});

test("a helper that ignores SIGTERM is killed after the grace", async () => {
  const p = Bun.spawn(withParentWatch(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"]), { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(500);
  const hung = Number(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim().split("\n")[0]);
  expect(alive(hung)).toBe(true);
  const t0 = Date.now();
  await stopHelper(p, 600);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  expect(alive(hung)).toBe(false);
  expect(alive(p.pid)).toBe(false);
});

test("a helper that ignores SIGTERM dies after the grace when the hub is killed outright", async () => {
  const code = `
    import { withParentWatch } from ${JSON.stringify(import.meta.dir + "/../src/children")};
    const p = Bun.spawn(withParentWatch(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], process.pid, 500), { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(700);
    const kids = Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim();
    console.log(JSON.stringify({ wrapper: p.pid, hung: Number(kids.split("\\n")[0]) }));
    await Bun.sleep(300000);
  `;
  const hub = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
  const { value } = await hub.stdout.getReader().read();
  const { wrapper, hung } = JSON.parse(new TextDecoder().decode(value)) as { wrapper: number; hung: number };
  expect(alive(hung)).toBe(true);
  hub.kill("SIGKILL");
  expect(await until(() => !alive(hung) && !alive(wrapper), 8000)).toBe(true);
});

test("the wrapper itself kills a TERM-resistant helper after its own grace", async () => {
  const p = Bun.spawn(withParentWatch(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], process.pid, 400), { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(500);
  const hung = Number(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim().split("\n")[0]);
  expect(alive(hung)).toBe(true);
  p.kill(); // plain TERM to the wrapper, no stopHelper
  await p.exited;
  expect(alive(hung)).toBe(false);
});

test("stopHelper reports true only for an exit it saw: a TERM-ignoring helper after KILL, and false for one that never exits", async () => {
  const p = Bun.spawn(withParentWatch(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], process.pid, 60_000), { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(500);
  expect(await stopHelper(p, 500)).toBe(true);
  expect(alive(p.pid)).toBe(false);
  // A process whose exit never arrives (even after SIGKILL) is not reported as reaped.
  const kills: (string | undefined)[] = [];
  const stuck = { pid: 999999, exited: new Promise<number>(() => {}), kill: (sig?: any) => void kills.push(sig) };
  const t0 = Date.now();
  expect(await stopHelper(stuck, 200)).toBe(false);
  expect(kills).toEqual([undefined, "SIGKILL"]);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("a rejected exit promise is not an observed exit: stopHelper goes on to KILL and reports false", async () => {
  const kills: (string | undefined)[] = [];
  const failing = { pid: 999999, exited: Promise.reject(new Error("wait failed")) as Promise<number>, kill: (sig?: any) => void kills.push(sig) };
  failing.exited.catch(() => {});
  expect(await stopHelper(failing, 100)).toBe(false);
  expect(kills).toEqual([undefined, "SIGKILL"]);
});

test("the helper registry stops everything it tracks and says true only when every exit was seen", async () => {
  const reg = new HelperRegistry();
  const spawn = () => reg.track(Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] }));
  const a = spawn();
  const b = reg.track(Bun.spawn(withParentWatch(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], process.pid, 60_000), { stdio: ["ignore", "ignore", "ignore"] }));
  // One that exits by itself leaves the registry.
  const quick = reg.track(Bun.spawn(withParentWatch(["true"]), { stdio: ["ignore", "ignore", "ignore"] }));
  await quick.exited;
  await Bun.sleep(10);
  expect(reg.size).toBe(2);
  await Bun.sleep(400);
  expect(await reg.stopAll(500)).toBe(true);
  expect(alive(a.pid) || alive(b.pid)).toBe(false);
  expect(reg.size).toBe(0);
  // Closed: a helper started after stopAll (a start that was still pending) is stopped at once.
  const late = spawn();
  expect(await until(() => !alive(late.pid), 4000)).toBe(true);
  // One whose exit never arrives makes the result false, while the others are still stopped.
  const reg2 = new HelperRegistry();
  const c = reg2.track(Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] }));
  reg2.track({ pid: 999999, exited: new Promise<number>(() => {}), kill: () => {} });
  expect(await reg2.stopAll(200)).toBe(false);
  expect(alive(c.pid)).toBe(false);
});

test("a helper tracked while stopAll runs is part of the same stop and its result", async () => {
  const reg = new HelperRegistry();
  let late: { pid: number } | null = null;
  let exit!: (n: number) => void;
  // Stopping the first one starts another (a spawn landing mid-shutdown).
  const first = { pid: 999998, exited: new Promise<number>((r) => (exit = r)), kill: () => { exit(0); late ??= reg.track(Bun.spawn(withParentWatch(["sleep", "300"]), { stdio: ["ignore", "ignore", "ignore"] })); } };
  reg.track(first);
  expect(await reg.stopAll(500)).toBe(true);
  expect(late).not.toBeNull();
  expect(alive(late!.pid)).toBe(false);
});

test("the registry keeps a helper whose exit promise rejects: stopAll tries to stop it and says false", async () => {
  const reg = new HelperRegistry();
  const kills: (string | undefined)[] = [];
  const failing = { pid: 999999, exited: Promise.reject(new Error("wait failed")) as Promise<number>, kill: (sig?: any) => void kills.push(sig) };
  reg.track(failing);
  await Bun.sleep(10);
  expect(reg.size).toBe(1); // not forgotten
  expect(await reg.stopAll(100)).toBe(false);
  expect(kills).toEqual([undefined, "SIGKILL"]);
});

test("once stopAll has begun, nothing new may be spawned (assertOpen), so its result covers every helper", async () => {
  const reg = new HelperRegistry();
  reg.assertOpen(); // open: fine
  const p = reg.stopAll(100); // closes synchronously, before it first awaits
  expect(() => reg.assertOpen()).toThrow(/stopping/);
  expect(await p).toBe(true);
  expect(() => reg.assertOpen()).toThrow(/stopping/); // and after it returned
});

test("a stop that arrives the instant the wrapper starts never leaves the helper running", async () => {
  for (let n = 0; n < 5; n++) {
    const secs = `299.${n}7${Date.now() % 1000}`;
    const p = Bun.spawn(withParentWatch(["sleep", secs]), { stdio: ["ignore", "ignore", "ignore"] });
    p.kill(); // before the wrapper has got as far as launching the helper
    await p.exited;
    await Bun.sleep(300);
    expect(Bun.spawnSync(["pgrep", "-f", `sleep ${secs}`]).stdout.toString().trim()).toBe("");
  }
}, 20_000);
