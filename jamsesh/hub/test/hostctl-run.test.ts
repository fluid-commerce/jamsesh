// Host commands: credentials never enter a build request, no wait on a command is unbounded, a
// command that can't be stopped is reported as still running (and keeps the preview locked), and
// output is kept as a tail.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { HostControl, redactUrls, repoProblem, run } from "../src/hostctl";

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

/** Replaces Bun.spawn with a process whose exit is never seen. */
async function withUnstoppable<T>(fn: (kills: (string | undefined)[], exit: () => void) => Promise<T>) {
  const real = Bun.spawn;
  const kills: (string | undefined)[] = [];
  let exit!: () => void;
  const exited = new Promise<number>((r) => (exit = () => r(0)));
  const empty = () => new ReadableStream<Uint8Array>({ start() {} }); // never closes
  (Bun as any).spawn = () => ({ pid: 999999, exited, exitCode: null, stdout: empty(), stderr: empty(), kill: (sig?: any) => void kills.push(sig) });
  try {
    return await fn(kills, exit);
  } finally {
    (Bun as any).spawn = real;
  }
}

test("run reports a command it couldn't stop as still running, with a way to see its exit", () =>
  withUnstoppable(async (kills, exit) => {
    const r = await run(["sleep", "1"], 100);
    expect(r.stuck).toBe(true);
    expect(r.out).toContain("still running");
    expect(kills).toContain("SIGKILL");
    let seen = false;
    void r.gone!.then(() => (seen = true));
    await Bun.sleep(20);
    expect(seen).toBe(false);
    exit();
    await Bun.sleep(20);
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
      await Bun.sleep(2_500); // the clone times out, can't be stopped
      expect(notes.some((n) => n.startsWith("built:false:") && n.includes("still running"))).toBe(true);
      expect(hc.builds.size).toBe(1); // reported, but still locked
      expect(hc.preview(o)).toContain("already building");
      exit();
      await Bun.sleep(50);
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
