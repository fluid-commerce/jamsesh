// The project layer through real hub processes, each on a temp JAMSESH_HOME and its own port.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKeeper } from "../src/projectkeeper";
import { createProject, listProjects, openSession, readProject } from "../src/projects";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => res(port));
    });
  });

const KEY = "ab".repeat(32);

async function start(home: string, env: Record<string, string>) {
  const port = await freePort();
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["JAMSESH_DATA", "JAMSESH_TEAM", "JAMSESH_PROJECT", "JAMSESH_NEW_PROJECT", "JAMSESH_NEW_SESSION", "JAMSESH_LOBBY"]) delete base[k];
  const proc = Bun.spawn(["bun", "run", "hub/src/index.ts", "--no-canvas", "--no-whisper"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...base,
      JAMSESH_HOME: home,
      JAMSESH_PORT: String(port),
      JAMSESH_FIGCRAFT_PORT: String(await freePort()),
      JAMSESH_DEV_PORT_START: String(await freePort()),
      JAMSESH_OFFLINE: "1",
      JAMSESH_SILENT: "1",
      JAMSESH_WINDOW_LINKS: "stdin",
      JAMSESH_BONJOUR_SERVICE: "_jamsesh-test._tcp",
      ...env,
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanup.push(() => proc.kill("SIGKILL"));
  proc.stdin.write(`key ${KEY}\n`);
  proc.stdin.flush();
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok).catch(() => false)) return { proc, origin };
    await Bun.sleep(100);
  }
  throw new Error("the hub didn't start");
}
const asWindow = { headers: { cookie: `jam_window=${KEY}` } };

test("the lobby lists projects for the host's window only and opens no session", async () => {
  const home = mkdtempSync(join(tmpdir(), "jam-lobby-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  createProject(home, "Passport");
  const { proc, origin } = await start(home, { JAMSESH_LOBBY: "1" });
  expect((await fetch(`${origin}/api/projects`)).status).toBe(403);
  const body = (await (await fetch(`${origin}/api/projects`, asWindow)).json()) as any;
  expect([body.projects.map((p: any) => p.name), body.lobby, body.current]).toEqual([["Passport"], true, null]);
  expect((await fetch(`${origin}/api/pair/code`, asWindow)).status).toBe(200);
  expect((await fetch(`${origin}/api/state`, asWindow)).status).toBe(409);
  expect(listProjects(home)[0].sessions).toBe(0);
  proc.kill("SIGTERM");
}, 30_000);

test("a hub opened on a project keeps its session there, resumes it, and records it when it ends", async () => {
  const home = mkdtempSync(join(tmpdir(), "jam-host-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const first = await start(home, { JAMSESH_NEW_PROJECT: "Passport" });
  const meta = listProjects(home);
  expect(meta.map((p) => p.name)).toEqual(["Passport"]);
  const slug = meta[0].slug;
  const sessions = join(home, "projects", slug, "sessions");
  expect(existsSync(join(sessions, readdirOnly(sessions), "jamsesh.db"))).toBe(true);
  first.proc.kill("SIGTERM");
  await first.proc.exited;
  expect(readProject(home, slug)?.lastUsed).toBeGreaterThan(0);

  // Hosting the project again the same day continues that session instead of making another.
  const second = await start(home, { JAMSESH_PROJECT: slug });
  expect(listProjects(home)[0].sessions).toBe(1);
  second.proc.kill("SIGTERM");
  await second.proc.exited;
  const third = await start(home, { JAMSESH_PROJECT: slug, JAMSESH_NEW_SESSION: "1" });
  expect(listProjects(home)[0].sessions).toBe(2);
  third.proc.kill("SIGTERM");
  await third.proc.exited;
}, 60_000);

function readdirOnly(dir: string) {
  return require("node:fs").readdirSync(dir)[0] as string;
}

test("the keeper records who came and the thumbnail, and does nothing without a project", async () => {
  const home = mkdtempSync(join(tmpdir(), "jam-keeper-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const meta = createProject(home, "Passport");
  const opened = openSession(home, meta.slug);
  const hub: any = {
    store: { speakers: () => ["Britt", "Chey"] },
    session: { personByName: (n: string) => (n === "Britt" ? { color: "#ff6b4a" } : undefined) },
    canvas: { thumbnail: async () => new Uint8Array([137, 80, 78, 71]) },
  };
  await new ProjectKeeper(hub, home, { slug: meta.slug, sessionId: opened.sessionId }).save();
  expect(readProject(home, meta.slug)?.people).toEqual([{ name: "Britt", color: "#ff6b4a" }, { name: "Chey" }]);
  expect(readFileSync(join(home, "projects", meta.slug, "thumbnail.png")).length).toBe(4);

  hub.canvas.thumbnail = async () => {
    throw new Error("canvas is down");
  };
  await new ProjectKeeper(hub, home, { slug: meta.slug, sessionId: opened.sessionId }).save();
  expect(existsSync(join(home, "projects", meta.slug, "thumbnail.png"))).toBe(true);
  await new ProjectKeeper(hub, home, null).save();
});
