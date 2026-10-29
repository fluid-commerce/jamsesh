// Host commands: credentials never enter a build request, no wait on a command is unbounded, a
// command that can't be stopped is reported as still running (and keeps the preview locked), and
// output is kept as a tail.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../src/config";
import { CREDENTIALS_REFUSED, branchProblem, commandProblem, confine, credentialProblem, groups, HostControl, openProblem, redactSecrets, redactUrls, repoProblem, run, shellCommands, urlProblem } from "../src/hostctl";

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
  expect(r.status).toBe("ok");
  expect(r.out.length).toBeLessThanOrEqual(16_384);
  expect(r.out.endsWith("THE-END")).toBe(true);
});

test("run stops a command that outlives its deadline: a failed finish, not 'stuck'", async () => {
  const t0 = Date.now();
  const r = await run(["/bin/sh", "-c", "trap '' TERM; sleep 30"], 300);
  expect(Date.now() - t0).toBeLessThan(6_000);
  expect(r).toMatchObject({ status: "failed", code: -1 });
  expect(r.out).toContain("timed out");
  expect(r.status).not.toBe("stuck");
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
  expect(r.status).not.toBe("stuck");
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
  expect(r.status).toBe("ok");
  expect(r.status).not.toBe("stuck");
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
    expect(r.status).toBe("stuck");
    if (r.status !== "stuck") throw new Error("unreachable");
    expect(r.out).toContain("still running");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    let seen = false;
    void r.gone.then(() => (seen = true));
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
  expect(commandProblem("git clone https://ghp_tok@github.com/a/b && make")).toContain("passwords or tokens");
  expect(commandProblem("curl -u me:pw https://user:pw@host/x")).toContain("passwords or tokens");
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

test("one credential check for commands, open and repos: parsed the way a shell parses, URLs with the URL class", () => {
  for (const bad of [
    "git clone https://tok@github.com/a/b",
    "curl https://user:pw@example.com",
    "curl 'https://tok@example.com'",
    "curl https://%74ok@example.com/", // %-encoded user, still before an @
    "curl https://a%40b@example.com/",
    "curl https://example.com\\@evil.example/ https://x@y.example/",
    "wget ssh://deploy@host/a/b",
    "curl https://@example.com",
    "curl https://[::1",
    "curl \"https://example.com/a'b?token=1\"", // a quote inside a double-quoted URL
    "curl 'https://example.com/it\"s?api_key=zzz'",
    "curl https://example.com/a\"b?token=1\"",
    "curl -u me:pw https://example.com",
    "curl -sSu me:pw https://example.com",
    "curl --user me:pw https://example.com",
    "curl --user=me:pw https://example.com",
    "curl -H 'Authorization: Bearer abcdefghijkl' https://example.com",
    "curl -H \"Cookie: session=abc\" https://example.com",
    "wget --header='Authorization: Basic Zm9vOmJhcg==' https://example.com",
    "API_KEY=abc make",
    "make --password=hunter2",
    "TOKEN=abc npm publish",
    "make secret=abc",
    "echo ghp_abcdefghijklmnopqrstuvwxyz0123",
    "export K=sk-ant-abcdefghijklmnopqrstuvwxyz",
    "AWS=AKIAABCDEFGHIJKLMNOP true",
    "curl 'https://example.com/?a=1&api_key=zzz'",
    "open https://example.com/cb#access_token=abc&x=1",
    "curl https://example.com/x?token=abc",
    `curl https://${"a".repeat(3000)}@example.com/`,
    "env HOME=/x curl -u me:pw https://example.com", // wrappers
    "nice -n 5 curl --user me:pw https://example.com",
    "xargs curl -H 'Cookie: a=b'",
    "bash -c \"curl -u me:pw https://example.com\"",
    "sh -lc 'wget --password=hunter2 https://example.com'",
    "make test # curl -u me:pw https://example.com", // text in a comment
    "make # Authorization: Bearer abcdefghijklmnop",
    "make # TOKEN=abc",
    "eval \"curl -u me:pw https://example.com\"", // indirect forms
    "echo 'curl -u me:pw https://example.com' | sh",
    "echo $(curl -u me:pw https://example.com)",
    "echo `curl --user me:pw https://example.com`",
    "ssh host 'curl -H \"Authorization: Bearer abcdefghijklmnop\" https://x'",
    "make $(echo $(echo TOKEN=abc))",
  ])
    expect([bad, credentialProblem(bad)]).toEqual([bad, CREDENTIALS_REFUSED]);
  for (const ok of [
    "make && curl https://example.com/path?x=1#frag",
    "git clone git@github.com:a/b.git",
    "echo hello\nmake\ttest",
    "sort -u file",
    "git commit --author=Bob -m x",
    "curl https://example.com/?page=2&q=token",
    "curl https://example.com/?keyboard=1",
    "open http://localhost:3000/a@b",
    "ls -la; pwd",
    "npm run build -- --key-name x",
    "git clone https://github.com/a/b.git && cd b && make test",
    `curl https://${"a".repeat(3000)}.example.com/ok`,
  ])
    expect([ok, credentialProblem(ok)]).toEqual([ok, null]);
  // What the shell really sees: a tab or ; ends the word, so these are not one credentialed URL.
  expect(credentialProblem("git clone https://tok\t@github.com/a/b")).toBeNull();
  // A single value (open, repo, URL) is parsed whole and may hold no whitespace at all.
  for (const bad of ["https://user;password@example.com/path", "https://user&x=1@example.com/", "https://u:p@h/", "https://h/a'b?token=1", "https://h/a\"b#access_token=1", "https://h/a b", "https://h/\t", "https://tok\t@h/"])
    expect([bad, credentialProblem(bad, { single: true })]).toEqual([bad, expect.any(String)]);
  expect(credentialProblem("ssh://git@github.com/a/b.git", { single: true, allowGitUser: true })).toBeNull();
  expect(credentialProblem("ssh://git:pw@github.com/a/b.git", { single: true, allowGitUser: true })).not.toBeNull();
  expect(repoProblem("https://github.com/a/b\t.git")).not.toBeNull();
  expect(repoProblem("https://github.com/a/b.git?token=abc")).not.toBeNull();
  expect(repoProblem("git@github.com:ghp_abcdefghijklmnopqrstuvwxyz0123/b.git")).not.toBeNull(); // a token in a remote path
  expect(repoProblem("git@github.com:acme/b.git")).toBeNull();
  expect(openProblem("build/token=abc")).not.toBeNull(); // a credential assignment as an open path
  expect(openProblem("build/app.html?api_key=abc")).not.toBeNull();
  expect(openProblem("build/App.app")).toBeNull();
  expect(openProblem("https://example.com/?x=1;token=abc")).not.toBeNull(); // ; separated fields
  expect(openProblem("https://example.com/#a=1;access_token=abc")).not.toBeNull();
  expect(openProblem("https://example.com/?x=1;y=2")).toBeNull();
  expect(openProblem("https://tok\t@example.com/")).not.toBeNull();
  expect(openProblem("https://example.com/?token=abc")).not.toBeNull();
  expect(commandProblem("git push https://tok@github.com/a/b")).toBe(CREDENTIALS_REFUSED);
});

test("the shell splitter honours quotes, escapes and operators", () => {
  expect(shellCommands(`curl "a b" 'c d' e\\ f; ls | wc && x`)).toEqual([["curl", "a b", "c d", "e f"], ["ls"], ["wc"], ["x"]]);
  expect(shellCommands("a\nb # comment\nc")).toEqual([["a"], ["b"], ["c"]]);
  expect(shellCommands(`echo "it's" 'say "hi"'`)).toEqual([["echo", "it's", 'say "hi"']]);
});

test("a preview step that can't be stopped (the open step) ends it there, reports it, and holds the lock until the group is gone", async () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.builds = new Map();
  hc.session = { settings: () => ({ hostControl: true }) };
  const notes: string[] = [];
  hc.log = (x: string) => void notes.push(x);
  hc.onBuilt = (_l: string, ok: boolean, x: string) => void notes.push(`built:${ok}:${x}`);
  const repo = "https://example.invalid/acme/stuckopen.git";
  const slug = `stuckopen-${createHash("sha1").update(repo.toLowerCase().replace(/\.git$/, "")).digest("hex").slice(0, 8)}`;
  const co = join(dir, "previews", slug);
  mkdirSync(join(co, ".git"), { recursive: true });
  writeFileSync(join(co, "app.html"), "x");
  const real = Bun.spawn;
  const realAlive = groups.alive;
  const realSignal = groups.signal;
  const ran: string[] = [];
  let stuckAlive = true;
  const empty = () => new ReadableStream<Uint8Array>({ start() {} });
  const closed = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  (Bun as any).spawn = (cmd: string[]) => {
    const argv = cmd.slice(3);
    ran.push(argv.join(" "));
    return argv[0] === "open"
      ? { pid: 999999, exited: new Promise<number>(() => {}), stdout: empty(), stderr: empty(), kill: () => {} }
      : { pid: 111111, exited: Promise.resolve(0), stdout: closed(), stderr: closed(), kill: () => {} };
  };
  groups.alive = (g) => g === 999999 && stuckAlive;
  groups.signal = () => {};
  const was = HostControl.STEP_MS;
  try {
    HostControl.STEP_MS = 100;
    hc.preview({ repo, command: "true", open: "app.html", by: "T" });
    await Bun.sleep(3_000); // the open step times out and its group can't be emptied
    expect(ran.some((c) => c.startsWith("open "))).toBe(true);
    expect(notes.some((n) => n.startsWith("built:false:") && n.includes("still running a command that couldn't be stopped"))).toBe(true);
    expect(notes.some((n) => n.includes("is built and open"))).toBe(false); // never reported as a success
    expect(hc.builds.size).toBe(1); // locked
    stuckAlive = false;
    await Bun.sleep(900);
    expect(hc.builds.size).toBe(0); // released once the group was seen empty
  } finally {
    HostControl.STEP_MS = was;
    (Bun as any).spawn = real;
    groups.alive = realAlive;
    groups.signal = realSignal;
  }
}, 20_000);

test("open_url and the Simulator URL refuse credentials before anything runs or is logged", async () => {
  const hc: any = Object.create(HostControl.prototype);
  const logs: string[] = [];
  hc.log = (x: string) => void logs.push(x);
  hc.session = { settings: () => ({ hostControl: true }) };
  const was = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const real = Bun.spawn;
  let spawned = 0;
  (Bun as any).spawn = () => (spawned++, real(["true"]));
  try {
    expect(await hc.act({ action: "open_url", url: "https://tok@example.com/" })).toContain("passwords or tokens");
    expect(await hc.act({ action: "open_url", url: "https://user;pw@example.com/" })).toContain("passwords or tokens");
    const sim = await hc.simulatorUp(undefined, "https://u:p@example.com/");
    expect(sim).toMatchObject({ ok: false });
    expect(sim.msg).toContain("passwords or tokens");
    expect(spawned).toBe(0);
    expect(logs.join("\n")).not.toContain("tok@");
  } finally {
    (Bun as any).spawn = real;
    Object.defineProperty(process, "platform", { value: was });
  }
});

for (const [stuckStep, argvMatch] of [["list", "simctl list"], ["boot", "simctl boot"], ["open -a Simulator", "open -a Simulator"], ["install", "simctl install"], ["launch", "simctl launch"]] as const) {
  test(`a preview's Simulator step that can't be stopped (${stuckStep}) ends the preview there, reports it, and holds the lock`, async () => {
    const hc: any = Object.create(HostControl.prototype);
    hc.builds = new Map();
    hc.session = { settings: () => ({ hostControl: true }) };
    hc.log = () => {};
    const notes: string[] = [];
    hc.onBuilt = (_l: string, ok: boolean, x: string) => void notes.push(`built:${ok}:${x}`);
    const repo = `https://example.invalid/acme/stucksim-${stuckStep.replace(/\W+/g, "")}.git`;
    const slug = `stucksim-${stuckStep.replace(/\W+/g, "")}-${createHash("sha1").update(repo.toLowerCase().replace(/\.git$/, "")).digest("hex").slice(0, 8)}`;
    const co = join(dir, "previews", slug);
    mkdirSync(join(co, ".git"), { recursive: true });
    mkdirSync(join(co, "App.app"), { recursive: true });
    const real = Bun.spawn;
    const realAlive = groups.alive;
    const realSignal = groups.signal;
    const ran: string[] = [];
    let stuckAlive = true;
    const empty = () => new ReadableStream<Uint8Array>({ start() {} });
    const text = (x: string) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode(x)), c.close()) });
    const devices = JSON.stringify({ devices: { ios: [{ state: stuckStep === "boot" ? "Shutdown" : "Booted", name: "iPhone 15", udid: "U1" }] } });
    (Bun as any).spawn = (cmd: string[]) => {
      const argv = cmd.slice(3);
      const line = argv.join(" ");
      ran.push(line);
      if (line.includes(argvMatch)) return { pid: 999997, exited: new Promise<number>(() => {}), stdout: empty(), stderr: empty(), kill: () => {} };
      return { pid: 111111, exited: Promise.resolve(0), stdout: text(line.includes("simctl list") ? devices : line.includes("defaults read") ? "com.example.app\n" : ""), stderr: text(""), kill: () => {} };
    };
    groups.alive = (g) => g === 999997 && stuckAlive;
    groups.signal = () => {};
    const was = HostControl.STEP_MS;
    const wasSim = HostControl.SIM_MS;
    try {
      HostControl.STEP_MS = 100;
      HostControl.SIM_MS = 100;
      hc.preview({ repo, command: "true", open: "simulator:App.app", by: "T" });
      await Bun.sleep(3_000);
      expect(ran.some((c) => c.includes(argvMatch))).toBe(true);
      expect(notes.some((n) => n.startsWith("built:false:") && n.includes("couldn't be stopped"))).toBe(true);
      expect(notes.some((n) => n.includes("is running in the Simulator"))).toBe(false);
      if (stuckStep !== "launch") expect(ran.some((c) => c.includes("simctl launch"))).toBe(false); // nothing after the stuck step
      expect(hc.builds.size).toBe(1);
      stuckAlive = false;
      await Bun.sleep(900);
      expect(hc.builds.size).toBe(0);
    } finally {
      HostControl.STEP_MS = was;
      HostControl.SIM_MS = wasSim;
      (Bun as any).spawn = real;
      groups.alive = realAlive;
      groups.signal = realSignal;
    }
  }, 20_000);
}

test("a shell request is refused at filing for every wrapper and comment trick", () => {
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  for (const c of ["env X=1 curl -u me:pw https://example.com", "make # curl -u me:pw x", "bash -c 'curl --user a:b https://x'"]) expect([c, hc.requestShell(c, "brain")]).toEqual([c, CREDENTIALS_REFUSED]);
  expect(hc.requests.size).toBe(0);
  expect(typeof hc.requestShell("make test", "brain")).toBe("object");
});

test("a branch is checked when the request is filed and again before it runs", () => {
  expect(branchProblem("feature/login-2")).toBeNull();
  expect(branchProblem("ghp_abcdefghijklmnopqrstuvwxyz0123")).not.toBeNull();
  expect(branchProblem("-oProxyCommand")).not.toBeNull();
  expect(branchProblem("a b")).not.toBeNull();
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  hc.session = { settings: () => ({ hostControl: true }) };
  const base = { agentId: "a", agentName: "A", ownerName: "J", repo: "https://github.com/a/b.git", command: "make" };
  expect(typeof hc.request({ ...base, branch: "ghp_abcdefghijklmnopqrstuvwxyz0123" })).toBe("string");
  expect(hc.requests.size).toBe(0);
  expect(typeof hc.preview({ ...base, branch: "ghp_abcdefghijklmnopqrstuvwxyz0123", by: "T" })).toBe("string");
  expect(hc.builds).toBeUndefined(); // refused before a lock was ever taken
});

test("what a command printed is masked before the room sees it", () => {
  const out = redactSecrets("ok\nAPI_KEY=abc123\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123\nAuthorization: Bearer abcdefghijklmnopqrst\nfetch https://u:p@host/x\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\ndone");
  for (const secret of ["abc123", "ghp_abcdef", "abcdefghijklmnopqrst", "u:p@", "MIIB"]) expect(out).not.toContain(secret);
  expect(out).toContain("ok");
  expect(out).toContain("done");
});

test("JSON and quoted secret fields are refused and masked; a bad percent escape is refused cleanly", () => {
  for (const bad of [`curl -d '{"user":"a","password":"hunter2"}' https://x.com`, `curl -d "{'api_key': 'zz'}" https://x.com`, `make token="abc"`])
    expect([bad, credentialProblem(bad)]).toEqual([bad, CREDENTIALS_REFUSED]);
  expect(credentialProblem("git commit -m 'update password reset page'")).toBeNull();
  expect(redactSecrets('{"password": "hunter2", "ok": 1}')).not.toContain("hunter2");
  expect(() => openProblem("https://example.com/?%E0%A4%A=1")).not.toThrow();
  const hc: any = Object.create(HostControl.prototype);
  hc.requests = new Map();
  hc.onRequest = () => {};
  expect(hc.requestShell(`curl -d '{"password":"x"}' https://example.com`, "brain")).toBe(CREDENTIALS_REFUSED);
  expect(hc.requests.size).toBe(0);
});
