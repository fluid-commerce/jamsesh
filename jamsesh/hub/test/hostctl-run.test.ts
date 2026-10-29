// Host commands: credentials never enter a build request, no wait on a command is unbounded, a
// command that can't be stopped is reported as still running (and keeps the preview locked), and
// output is kept as a tail.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../src/config";
import { commandProblem, confine, groups, HostControl, openProblem, redactUrls, repoProblem, run } from "../src/hostctl";

const dir = mkdtempSync(join(tmpdir(), "jam-hostctl-"));
const homeWas = config.home;
(config as any).home = dir; // previews go under a temp home, never ~/.jamsesh
afterAll(() => {
  (config as any).home = homeWas;
  rmSync(dir, { recursive: true, force: true });
});

test("a repository URL with a username, token or password is refused; plain https, ssh and git@ are fine", () => {
  for (const ok of ["https://github.com/acme/app.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app.git"]) expect([ok, repoProblem(ok)]).toEqual([ok, null]);
  for (const bad of ["https://ghp_abc123@github.com/acme/app.git", "https://user:pw@github.com/acme/app.git", "https://x-access-token:abc@github.com/a/b", "ssh://deploy@host/a/b", "ssh://u:p@host/a/b", "git@@evil:x", "http://github.com/a/b", "-oProxyCommand=x", "https://a/b c"])
    expect([bad, repoProblem(bad)]).toEqual([bad, expect.any(String)]);
});

test("request() keeps credentials out of the stored request", () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  const r = hc.request({ agentId: "a1", agentName: "A", ownerName: "Jo", repo: "https://tok@github.com/acme/app.git", branch: "main", command: "make" });
  expect(typeof r).toBe("string");
  expect(hc.requests.size).toBe(0);
});

test("redactUrls hides the userinfo of any URL in a note", () => {
  expect(redactUrls("fatal: unable to access 'https://ghp_secret:x@github.com/a/b/'")).toBe("fatal: unable to access 'https://***@github.com/a/b/'");
  expect(redactUrls("plain https://github.com/a/b")).toBe("plain https://github.com/a/b");
});

test("run keeps only the tail of a command's output", async () => {
  const r = await run(["/bin/sh", "-c", "i=0; while [ $i -lt 4000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo THE-END"], 20_000);
  expect(r.code).toBe(0);
  expect(r.out.length).toBeLessThanOrEqual(16_384);
  expect(r.out.endsWith("THE-END")).toBe(true);
});

test("run stops a command that outlives its deadline: a failed finish, not 'stuck'", async () => {
  const t0 = Date.now();
  const r = await run(["/bin/sh", "-c", "trap '' TERM; sleep 30"], 300);
  expect(Date.now() - t0).toBeLessThan(6_000);
  expect(r).toMatchObject({ code: -1 });
  expect(r.out).toContain("timed out");
  expect(r.stuck).toBeUndefined();
});

/** Replaces Bun.spawn with a process whose group never empties, until `exit()`. */
async function withUnstoppable<T>(fn: (signals: string[], exit: () => void) => Promise<T>) {
  const real = Bun.spawn;
  const realAlive = groups.alive;
  const realSignal = groups.signal;
  const signals: string[] = [];
  let alive = true;
  const empty = () => new ReadableStream<Uint8Array>({ start() {} }); // never closes
  (Bun as any).spawn = () => ({ pid: 999999, exited: new Promise<number>(() => {}), exitCode: null, stdout: empty(), stderr: empty(), kill: () => {} });
  groups.alive = () => alive;
  groups.signal = (_g, sig) => void signals.push(sig);
  try {
    return await fn(signals, () => (alive = false));
  } finally {
    (Bun as any).spawn = real;
    groups.alive = realAlive;
    groups.signal = realSignal;
  }
}

test("a command's background child dies with it on a timeout (the whole process group is stopped)", async () => {
  const pidFile = join(dir, "bg.pid");
  const t0 = Date.now();
  const r = await run(["/bin/sh", "-c", `sleep 300 & echo $! > ${pidFile}; sleep 300`], 600);
  expect(r.out).toContain("timed out");
  expect(r.stuck).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(8_000);
  const bg = Number(readFileSync(pidFile, "utf8").trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    return !Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z");
  };
  for (let i = 0; i < 20 && alive(bg); i++) await Bun.sleep(100);
  expect(alive(bg)).toBe(false);
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z");
};

test("a command that exits 0 leaving a background child: the child is stopped too, and the run is done only then", async () => {
  const t0 = Date.now();
  const pidFile2 = join(dir, "bg2.pid");
  const r = await run(["/bin/sh", "-c", `echo done-line; sleep 300 & echo $! > ${pidFile2}`], 20_000);
  expect(r.code).toBe(0);
  expect(r.stuck).toBeUndefined();
  expect(r.out).toContain("done-line");
  expect(Date.now() - t0).toBeLessThan(5_000);
  const bg = Number(readFileSync(pidFile2, "utf8").trim());
  expect(isAlive(bg)).toBe(false); // gone by the time run returned (the group was seen empty)
});

test("a preview's lock frees only after what its build left behind is gone", async () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.builds = new Map();
  hc.session = { settings: () => ({ hostControl: true }) };
  hc.log = () => {};
  const done = new Promise<string>((r) => (hc.onBuilt = (_l: string, _ok: boolean, t: string) => r(t)));
  const pidFile3 = join(dir, "bg3.pid");
  // The checkout already exists, with a local bare repo as its origin, so the fetch works offline.
  const bare = join(dir, "remote.git");
  const work = join(dir, "work");
  const sh = (...c: string[]) => Bun.spawnSync(c);
  sh("git", "init", "-q", "--bare", bare);
  sh("git", "init", "-q", work);
  sh("git", "-C", work, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  sh("git", "-C", work, "push", "-q", bare, "HEAD:refs/heads/main");
  const repo = "https://example.invalid/acme/lockapp.git";
  const slug = `lockapp-main-${createHash("sha1").update(repo.toLowerCase().replace(/\.git$/, "")).digest("hex").slice(0, 8)}`;
  const co = join(dir, "previews", slug);
  mkdirSync(co, { recursive: true });
  sh("git", "init", "-q", co);
  sh("git", "-C", co, "remote", "add", "origin", bare);
  hc.preview({ repo, branch: "main", command: `sleep 300 & echo $! > ${pidFile3}`, by: "T" });
  expect(hc.builds.size).toBe(1);
  const text = await done;
  expect(text).toContain("is built on the host");
  const bg = Number(readFileSync(pidFile3, "utf8").trim());
  expect(isAlive(bg)).toBe(false); // gone before the room is told it finished
  await Bun.sleep(30);
  expect(hc.builds.size).toBe(0);
}, 40_000);

test("run reports a command it couldn't stop as still running, with a way to see its exit", () =>
  withUnstoppable(async (signals, exit) => {
    const r = await run(["sleep", "1"], 100);
    expect(r.stuck).toBe(true);
    expect(r.out).toContain("still running");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    let seen = false;
    void r.gone!.then(() => (seen = true));
    await Bun.sleep(20);
    expect(seen).toBe(false);
    exit();
    await Bun.sleep(700);
    expect(seen).toBe(true);
  }));

test("a preview whose command can't be stopped stays locked until its exit is seen, and says so", () =>
  withUnstoppable(async (_kills, exit) => {
    const was = HostControl.GIT_MS;
    HostControl.GIT_MS = 100;
    try {
      const notes: string[] = [];
      const hc: any = Object.create(HostControl.prototype);
      hc.builds = new Map();
      hc.session = { settings: () => ({ hostControl: true }) };
      hc.log = (t: string) => void notes.push(t);
      hc.onBuilt = (_l: string, ok: boolean, t: string) => void notes.push(`built:${ok}:${t}`);
      const o = { repo: "https://github.com/acme/app.git", command: "make", by: "T" };
      expect(typeof hc.preview(o)).toBe("string");
      expect(hc.preview(o)).toContain("already building");
      await Bun.sleep(4_500); // the clone times out, can't be stopped
      expect(notes.some((n) => n.startsWith("built:false:") && n.includes("still running"))).toBe(true);
      expect(hc.builds.size).toBe(1); // reported, but still locked
      expect(hc.preview(o)).toContain("already building");
      exit();
      await Bun.sleep(800);
      expect(hc.builds.size).toBe(0); // released once the exit was seen
    } finally {
      HostControl.GIT_MS = was;
    }
  }), 15_000);

test("a preview that fails normally releases the lock at once", async () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.builds = new Map();
  hc.session = { settings: () => ({ hostControl: true }) };
  hc.log = () => {};
  const done = new Promise<string>((r) => (hc.onBuilt = (_l: string, _ok: boolean, t: string) => r(t)));
  hc.preview({ repo: "https://127.0.0.1:1/none.git", command: "true", by: "T" });
  expect(await done).toContain("build failed");
  await Bun.sleep(20);
  expect(hc.builds.size).toBe(0);
}, 30_000);

test("build and shell command text with a credentialed URL is refused at filing, and redacted anywhere shown", () => {
  expect(commandProblem("git clone https://ghp_tok@github.com/a/b && make")).toContain("username or token");
  expect(commandProblem("curl -u me:pw https://user:pw@host/x")).toContain("username or token");
  expect(commandProblem("make test && curl https://example.com/x")).toBeNull();
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  expect(typeof hc.request({ agentId: "a", agentName: "A", ownerName: "J", repo: "https://github.com/a/b.git", branch: "", command: "git push https://tok@github.com/a/b" })).toBe("string");
  expect(typeof hc.requestShell("curl https://u:p@h/x", "brain")).toBe("string");
  expect(hc.requests.size).toBe(0);
  expect(typeof hc.preview).toBe("function");
});

test("a preview that throws before its work starts can't strand the lock", async () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.builds = new Map();
  hc.session = { settings: () => ({ hostControl: true }) };
  hc.log = () => {
    throw new Error("log failed");
  };
  hc.onBuilt = () => {};
  hc.preview({ repo: "https://github.com/acme/other.git", command: "make", by: "T" });
  await Bun.sleep(100);
  expect(hc.builds.size).toBe(0);
});

test("what a build opens: no credentialed URL, no scheme but http(s), and only paths inside the checkout", () => {
  for (const ok of [undefined, "", "build/App.app", "simulator:build/App.app", "https://localhost:3000/", "docs/index.html"]) expect([ok, openProblem(ok)]).toEqual([ok, null]);
  for (const bad of ["https://tok@example.com/", "https://u:p@example.com/", "file:///etc/passwd", "x-apple.systempreferences:", "/etc/passwd", "~/secret", "../../etc/passwd", "a/../../b", "-a Calculator", "simulator:/Applications/X.app", "simulator:../x.app", "simulator:https://example.com", "a\0b"])
    expect([bad, openProblem(bad)]).toEqual([bad, expect.any(String)]);
});

test("a symlink inside the checkout can't lead outside it", () => {
  const co = join(dir, "checkout");
  mkdirSync(join(co, "build"), { recursive: true });
  writeFileSync(join(co, "build", "ok.txt"), "x");
  writeFileSync(join(dir, "outside.txt"), "x");
  symlinkSync(join(dir, "outside.txt"), join(co, "build", "link.txt"));
  symlinkSync(dir, join(co, "up"));
  expect(confine(co, "build/ok.txt")).toBe(join(realpathSync(co), "build", "ok.txt"));
  expect(confine(co, "build/link.txt")).toBeNull();
  expect(confine(co, "up/outside.txt")).toBeNull();
  expect(confine(co, "missing")).toBeNull();
});

test("request() refuses an open that carries credentials or escapes the checkout, so the card never shows one", () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  const base = { agentId: "a", agentName: "A", ownerName: "J", repo: "https://github.com/a/b.git", branch: "", command: "make" };
  expect(typeof hc.request({ ...base, open: "https://tok@example.com/" })).toBe("string");
  expect(typeof hc.request({ ...base, open: "../../etc/passwd" })).toBe("string");
  expect(typeof hc.request({ ...base, open: "build/App.app" })).toBe("object");
});
