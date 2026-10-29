import { expect, test } from "bun:test";
import { stopHelper, withParentWatch } from "../src/children";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
