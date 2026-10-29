import { expect, test } from "bun:test";
import { stopHelper, withParentWatch, withStdinWatch } from "../src/children";

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

// ---- withStdinWatch: the hub holds the helper's stdin ----

const sleeperUnder = (pid: number) => Number(Bun.spawnSync(["pgrep", "-P", String(pid), "-x", "sleep"]).stdout.toString().trim().split("\n")[0]);

test("a stdin-watched helper dies at once when its hub is killed outright", async () => {
  const code = `
    import { withStdinWatch } from ${JSON.stringify(import.meta.dir + "/../src/children")};
    const p = Bun.spawn(withStdinWatch(["sleep", "300"]), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(500);
    const kid = Bun.spawnSync(["pgrep", "-P", String(p.pid), "-x", "sleep"]).stdout.toString().trim();
    console.log(JSON.stringify({ wrapper: p.pid, sleeper: Number(kid.split("\\n")[0]) }));
    await Bun.sleep(300000);
  `;
  const hub = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
  const { value } = await hub.stdout.getReader().read();
  const { wrapper, sleeper } = JSON.parse(new TextDecoder().decode(value)) as { wrapper: number; sleeper: number };
  expect(sleeper).toBeGreaterThan(0);
  expect(alive(sleeper)).toBe(true);
  hub.kill("SIGKILL");
  expect(await until(() => !alive(sleeper) && !alive(wrapper), 2000)).toBe(true);
});

test("a stdin-watched helper: stopping the wrapper stops it, leaving nothing behind, and its own exit status comes through", async () => {
  const p = Bun.spawn(withStdinWatch(["sleep", "300"]), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(400);
  const sleeper = sleeperUnder(p.pid);
  expect(sleeper).toBeGreaterThan(0);
  expect(alive(sleeper)).toBe(true);
  await stopHelper(p);
  expect(alive(sleeper)).toBe(false);
  expect(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim()).toBe("");
  const own = Bun.spawn(withStdinWatch(["sh", "-c", "exit 7"]), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  expect(await own.exited).toBe(7);
});
