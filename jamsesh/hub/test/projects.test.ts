import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { projectsRoute } from "../src/projects-api";
import { linkSecretFile, takeNewSessionMark, cleanName, createProject, defaultProject, findProject, isSlug, listProjects, listSessions, migrateLegacy, openSession, readProject, saveThumbnail, slugify, touchSession } from "../src/projects";

const homes: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jam-projects-"));
  homes.push(d);
  return d;
};
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

const DAY = 86_400_000;
const noon = new Date(2026, 5, 10, 12, 0, 0).getTime();

/** A session directory as the single-session hub left it: a database with a name, events and a docs row. */
function legacy(dir: string, name: string, speakers: string[], when: number) {
  mkdirSync(dir, { recursive: true });
  const store = new Store(dir);
  store.setSetting("sessionName", name);
  store.put("people", { id: "p1", name: speakers[0] ?? "x", role: "", weight: 1, color: "#fff", hasVoiceprint: false, voiceSamples: 0, createdAt: when } as any, false);
  for (const [i, who] of speakers.entries()) store.addEvent({ kind: "speech", authorType: "person", authorName: who, text: `line ${i}`, ts: when + i * 1000 });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  mkdirSync(join(dir, "renders"));
  writeFileSync(join(dir, "renders", "a.png"), "png");
  store.db.close();
}

describe("project storage", () => {
  test("names and slugs are tidy", () => {
    expect(cleanName("  Pass\u0000port \n  redesign  ")).toBe("Pass port redesign");
    expect(cleanName("x".repeat(200)).length).toBe(80);
    expect(slugify("Passport: the account menu!")).toBe("passport-the-account-menu");
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("project");
    expect(isSlug("../etc")).toBe(false);
    expect(isSlug("passport-2")).toBe(true);
  });

  test("a project needs only a name, and a taken slug gets a number", () => {
    const home = tmp();
    const a = createProject(home, "Passport", noon);
    const b = createProject(home, "passport", noon);
    expect([a.slug, b.slug]).toEqual(["passport", "passport-2"]);
    expect(() => createProject(home, "   ")).toThrow("name");
    expect(readProject(home, "passport")?.name).toBe("Passport");
    createProject(home, "Billing", noon);
    expect(findProject(home, "BILLING")?.slug).toBe("billing");
    expect(findProject(home, "nothing like it")).toBeNull();
  });

  test("opening a project resumes today's session and starts a new one on another day, or on request", () => {
    const home = tmp();
    createProject(home, "Passport", noon);
    const first = openSession(home, "passport", { now: noon });
    expect(first.resumed).toBe(false);
    expect(first.dir).toBe(join(home, "projects", "passport", "sessions", first.sessionId));
    const again = openSession(home, "passport", { now: noon + 3600_000 });
    expect([again.resumed, again.sessionId]).toEqual([true, first.sessionId]);
    expect(openSession(home, "passport", { now: noon + 3600_000, fresh: true }).sessionId).not.toBe(first.sessionId);
    const tomorrow = openSession(home, "passport", { now: noon + DAY });
    expect(tomorrow.resumed).toBe(false);
    expect(listSessions(home, "passport").length).toBe(3);
    expect(() => openSession(home, "nope")).toThrow();
  });

  test("the list is recent first, with people, sessions, thumbnail and whether today's session continues", () => {
    const home = tmp();
    createProject(home, "Old", noon - 5 * DAY);
    createProject(home, "New", noon - 4 * DAY);
    const s = openSession(home, "old", { now: noon });
    touchSession(home, "old", s.sessionId, [{ name: "Britt", color: "#f00" }, { name: "Chey" }], noon);
    touchSession(home, "old", s.sessionId, [{ name: "britt" }, { name: "Felipe" }], noon + 1000);
    saveThumbnail(home, "old", new Uint8Array([137, 80, 78, 71]));
    const list = listProjects(home, noon + 2000);
    expect(list.map((p) => p.slug)).toEqual(["old", "new"]);
    expect(list[0].people.map((p) => p.name)).toEqual(["britt", "Felipe", "Chey"]);
    expect([list[0].sessions, list[0].resumable, list[1].sessions, list[1].resumable]).toEqual([1, true, 0, false]);
    expect(list[0].thumbnailAt).toBeGreaterThan(0);
    expect(list[1].thumbnailAt).toBeNull();
    expect(listProjects(home, noon + 2 * DAY)[0].resumable).toBe(false);
  });

  test("a hand-made or damaged project folder never breaks the list", () => {
    const home = tmp();
    mkdirSync(join(home, "projects", "broken"), { recursive: true });
    writeFileSync(join(home, "projects", "broken", "project.json"), "{nope");
    mkdirSync(join(home, "projects", "Not A Slug"), { recursive: true });
    expect(listProjects(home)).toEqual([]);
    expect(defaultProject(home).name).toBe("My project");
  });

  test("thumbnails are only saved for projects that exist", () => {
    const home = tmp();
    saveThumbnail(home, "ghost", new Uint8Array([1]));
    saveThumbnail(home, "../escape", new Uint8Array([1]));
    expect(existsSync(join(home, "projects"))).toBe(false);
  });
});

describe("migration from the single-session layout", () => {
  function oldHome() {
    const home = tmp();
    legacy(join(home, "host"), "Passport", ["Britt", "Chey"], noon);
    legacy(join(home, "host-2026-05-01-0930"), "Passport", ["Felipe"], noon - 30 * DAY);
    legacy(join(home, "host-2026-04-01-0930"), "Billing", ["Emily"], noon - 60 * DAY);
    return home;
  }
  const bytes = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort().map((f) => `${f}:${statSync(join(dir, f)).size}`).join(",");
  const lockFile = (home: string) => join(home, "projects", ".migration-lock.db");
  /** Holds the migration lock as another start would: an exclusive transaction on the lock file. */
  function holdLock(home: string) {
    const db = new Database(lockFile(home));
    db.exec("BEGIN EXCLUSIVE");
    return db;
  }
  /** Another process that takes the lock, says so, then sits on it (a migration that takes long, or one about to be killed). */
  function holderProcess(home: string) {
    const code = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(lockFile(home))}); db.exec("BEGIN EXCLUSIVE"); console.log("held"); setInterval(() => {}, 1000);`;
    return Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_SILENT: "1" } });
  }
  async function waitForLine(p: ReturnType<typeof holderProcess>) {
    const reader = p.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toContain("held");
  }
  /** A whole start in its own process; its migration records. */
  async function starter(home: string) {
    const src = join(import.meta.dir, "..", "src", "projects.ts");
    const p = Bun.spawn(["bun", "-e", `const { migrateLegacy } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(migrateLegacy(${JSON.stringify(home)})));`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_SILENT: "1" } });
    await p.exited;
    return JSON.parse((await new Response(p.stdout).text()).trim().split("\n").pop()!);
  }

  test("copies each session into a project named from its name, and leaves the originals exactly as they were", () => {
    const home = oldHome();
    const before = ["host", "host-2026-05-01-0930", "host-2026-04-01-0930"].map((d) => bytes(join(home, d)));
    const records = migrateLegacy(home);
    expect(records.length).toBe(3);
    expect(records.every((r) => r.verified)).toBe(true);
    expect(["host", "host-2026-05-01-0930", "host-2026-04-01-0930"].map((d) => bytes(join(home, d)))).toEqual(before);

    const list = listProjects(home);
    expect(list.map((p) => [p.name, p.sessions]).sort()).toEqual([["Billing", 1], ["Passport", 2]]);
    const passport = list.find((p) => p.name === "Passport")!;
    expect(passport.people.map((p) => p.name).sort()).toEqual(["Britt", "Chey", "Felipe"]);
    // The copy is a working session: its database opens and has the same events, and its renders came along.
    const dir = join(home, "projects", passport.slug, "sessions", "last-session");
    const db = new Database(join(dir, "jamsesh.db"), { readonly: true });
    expect((db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(2);
    db.close();
    expect(readFileSync(join(dir, "renders", "a.png"), "utf8")).toBe("png");
  });

  test("runs once; a second start changes nothing", () => {
    const home = oldHome();
    migrateLegacy(home);
    const after = bytes(join(home, "projects"));
    expect(migrateLegacy(home).length).toBe(3);
    expect(bytes(join(home, "projects"))).toBe(after);
  });

  test("a home with no old sessions just gets an empty projects folder", () => {
    const home = tmp();
    expect(migrateLegacy(home)).toEqual([]);
    expect(listProjects(home)).toEqual([]);
  });

  test("a damaged old session is reported and skipped, the rest still move over", () => {
    const home = oldHome();
    writeFileSync(join(home, "host-2026-04-01-0930", "jamsesh.db"), "this is not a database");
    const records = migrateLegacy(home);
    expect(records.filter((r) => !r.verified).length).toBe(1);
    expect(records.filter((r) => r.verified).length).toBe(2);
    expect(readFileSync(join(home, "host-2026-04-01-0930", "jamsesh.db"), "utf8")).toBe("this is not a database");
  });

  test("a copy that fails leaves nothing behind and is tried again at the next start", () => {
    const home = oldHome();
    const locked = join(home, "host-2026-04-01-0930", "renders", "a.png");
    chmodSync(locked, 0o000);
    try {
      const first = migrateLegacy(home);
      expect(first.filter((r) => !r.verified).map((r) => r.from)).toEqual([join(home, "host-2026-04-01-0930")]);
      // Billing had only that session: no empty project, no half-made session directory.
      expect(listProjects(home).map((p) => p.name)).toEqual(["Passport"]);
      expect(readdirSync(join(home, "projects")).filter((d) => !d.startsWith(".")).length).toBe(1);
    } finally {
      chmodSync(locked, 0o644);
    }
    const passport = listProjects(home)[0].slug;
    const untouched = bytes(join(home, "projects", passport));
    const second = migrateLegacy(home);
    expect(second.length).toBe(3);
    expect(second.every((r) => r.verified)).toBe(true);
    expect(listProjects(home).map((p) => [p.name, p.sessions]).sort()).toEqual([["Billing", 1], ["Passport", 2]]);
    // What came over the first time is left as it was.
    expect(bytes(join(home, "projects", passport))).toBe(untouched);
    expect(migrateLegacy(home)).toEqual(second);
  });

  test("two hubs starting together migrate once: one waits for the other, and nothing is copied twice", async () => {
    const home = oldHome();
    const src = join(import.meta.dir, "..", "src", "projects.ts");
    const run = () => Bun.spawn(["bun", "-e", `const { migrateLegacy } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(migrateLegacy(${JSON.stringify(home)})));`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_SILENT: "1" } });
    const both = [run(), run()];
    const outs = await Promise.all(both.map(async (p) => ((await p.exited), JSON.parse((await new Response(p.stdout).text()).trim().split("\n").pop()!))));
    for (const records of outs) {
      expect(records.length).toBe(3);
      expect(records.every((r: any) => r.verified)).toBe(true);
    }
    expect(listProjects(home).map((p) => [p.name, p.sessions]).sort()).toEqual([["Billing", 1], ["Passport", 2]]);
    const passport = listProjects(home).find((p) => p.name === "Passport")!;
    expect(readdirSync(join(home, "projects", passport.slug, "sessions")).sort()).toEqual(["host-2026-05-01-0930", "last-session"]);
  }, 30_000);

  test("a start that outwaits a live migration fails instead of going on with unfinished projects", () => {
    const home = oldHome();
    mkdirSync(join(home, "projects"), { recursive: true });
    // Another start holds the lock (here, another connection in this process).
    const other = holdLock(home);
    expect(() => migrateLegacy(home, 100)).toThrow(/still bringing the old sessions/);
    // Nothing was listed as done, and the other start still holds its lock.
    expect(existsSync(join(home, "projects", ".migration.json"))).toBe(false);
    expect(() => migrateLegacy(home, 50)).toThrow(/still bringing the old sessions/);
    other.close();
    expect(migrateLegacy(home, 100).filter((r) => r.verified).length).toBe(3);
  });

  test("a start cut off after publishing a copy adopts it on retry: no duplicate, and `host` doesn't strand", () => {
    const home = oldHome();
    migrateLegacy(home);
    const passport = listProjects(home).find((p) => p.name === "Passport")!;
    const sessions = join(home, "projects", passport.slug, "sessions");
    const before = readdirSync(sessions).sort();
    expect(before).toEqual(["host-2026-05-01-0930", "last-session"]);
    // The process stopped (or the project write failed) before the marker was written.
    rmSync(join(home, "projects", ".migration.json"));
    const again = migrateLegacy(home);
    expect(again.length).toBe(3);
    expect(again.every((r) => r.verified)).toBe(true);
    expect(readdirSync(sessions).sort()).toEqual(before);
    expect(again.find((r) => r.from === join(home, "host"))!.to).toBe(join(sessions, "last-session"));
    // And once more, as the marker can be lost again.
    rmSync(join(home, "projects", ".migration.json"));
    expect(migrateLegacy(home).every((r) => r.verified)).toBe(true);
    expect(readdirSync(sessions).sort()).toEqual(before);
    // Using the session afterwards keeps the record of where it came from.
    touchSession(home, passport.slug, "last-session");
    rmSync(join(home, "projects", ".migration.json"));
    migrateLegacy(home);
    expect(readdirSync(sessions).sort()).toEqual(before);
  });

  test("a copy is named by where it's going: an occupied last-session sends `host` to a free name", () => {
    const home = oldHome();
    const first = migrateLegacy(home);
    const passport = listProjects(home).find((p) => p.name === "Passport")!;
    const sessions = join(home, "projects", passport.slug, "sessions");
    // A different session already holds last-session (no record of coming from `host`); `host` is still to do.
    const session = JSON.parse(readFileSync(join(sessions, "last-session", "session.json"), "utf8"));
    delete session.migratedFrom;
    writeFileSync(join(sessions, "last-session", "session.json"), JSON.stringify(session));
    writeFileSync(join(home, "projects", ".migration.json"), JSON.stringify({ at: 1, records: first.filter((r) => r.from !== join(home, "host")) }));
    const records = migrateLegacy(home);
    expect(records.every((r) => r.verified)).toBe(true);
    expect(readdirSync(sessions).sort()).toEqual(["host-2026-05-01-0930", "last-session", "last-session-copy"]);
    expect(records.find((r) => r.from === join(home, "host"))!.to).toBe(join(sessions, "last-session-copy"));
  });

  test("a lock its holder left behind by dying is free at once; two starters racing for it migrate once", async () => {
    const home = oldHome();
    mkdirSync(join(home, "projects"), { recursive: true });
    // A start that took the lock and was killed mid-migration: the lock file stays, its hold doesn't.
    const dead = holderProcess(home);
    await waitForLine(dead);
    dead.kill("SIGKILL");
    await dead.exited;
    expect(existsSync(join(home, "projects", ".migration-lock.db"))).toBe(true);
    // Two starts at once against that leftover lock: each sees every session migrated, and nothing is copied twice.
    const outs = await Promise.all([starter(home), starter(home)]);
    for (const records of outs) {
      expect(records.length).toBe(3);
      expect(records.every((r: any) => r.verified)).toBe(true);
    }
    expect(listProjects(home).map((p) => [p.name, p.sessions]).sort()).toEqual([["Billing", 1], ["Passport", 2]]);
    const passport = listProjects(home).find((p) => p.name === "Passport")!;
    expect(readdirSync(join(home, "projects", passport.slug, "sessions")).sort()).toEqual(["host-2026-05-01-0930", "last-session"]);
  }, 30_000);

  test("a live migration keeps its lock however long it takes: another start never takes it, and goes ahead once the holder is gone", async () => {
    const home = oldHome();
    mkdirSync(join(home, "projects"), { recursive: true });
    // A long migration in another process, holding the lock.
    const holder = holderProcess(home);
    await waitForLine(holder);
    const lock = join(home, "projects", ".migration-lock.db");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(lock, hourAgo, hourAgo);
    const src = join(import.meta.dir, "..", "src", "projects.ts");
    const second = Bun.spawn(["bun", "-e", `const { migrateLegacy } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(migrateLegacy(${JSON.stringify(home)}, 300)));`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_SILENT: "1" } });
    expect(await second.exited).not.toBe(0);
    expect(listProjects(home)).toEqual([]);
    // The holder dies without letting go: the next start takes over and migrates.
    holder.kill("SIGKILL");
    await holder.exited;
    expect(migrateLegacy(home, 300).filter((r) => r.verified).length).toBe(3);
  }, 30_000);

  test("a session its hub is still writing, with rows only in the WAL and checkpoints mid-copy, comes over whole", async () => {
    const home = tmp();
    legacy(join(home, "host"), "Passport", ["Chey"], noon);
    const store = join(import.meta.dir, "..", "src", "store.ts");
    // The live hub: 50 committed rows left in the WAL, then a write and a full checkpoint every few milliseconds.
    const code = `const { Store } = await import(${JSON.stringify(store)}); const st = new Store(${JSON.stringify(join(home, "host"))});
      st.db.exec("PRAGMA wal_autocheckpoint = 0");
      for (let i = 0; i < 50; i++) st.addEvent({ kind: "speech", authorType: "person", authorName: "Chey", text: "wal " + i });
      console.log("ready");
      setInterval(() => { st.addEvent({ kind: "speech", authorType: "person", authorName: "Chey", text: "more" }); st.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }, 3);`;
    const writer = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_SILENT: "1" } });
    try {
      const reader = writer.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      reader.releaseLock();
      const records = migrateLegacy(home);
      expect(records.map((r) => r.verified)).toEqual([true]);
      const copy = new Database(join(records[0].to, "jamsesh.db"), { readonly: true });
      // Every row committed before the migration began (the WAL-only ones too), and a sound database.
      expect((copy.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBeGreaterThanOrEqual(51);
      expect((copy.query("SELECT COUNT(*) AS n FROM events WHERE text LIKE 'wal %'").get() as any).n).toBe(50);
      expect((copy.query("PRAGMA integrity_check").get() as any).integrity_check).toBe("ok");
      copy.close();
    } finally {
      writer.kill();
      await writer.exited;
    }
  }, 30_000);

  test("a copy cut off part way never counts as a session", () => {
    const home = tmp();
    const meta = createProject(home, "Passport");
    mkdirSync(join(home, "projects", meta.slug, "sessions", ".host.partial"), { recursive: true });
    expect(listSessions(home, meta.slug)).toEqual([]);
  });
});

describe("project routes", () => {
  const req = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:4747${path}`, init);
  const call = (home: string, path: string, init: RequestInit = {}, hostWindow = true) => projectsRoute(req(path, init), new URL(req(path).url), { local: true, hostWindow }, home);
  const post = (body: unknown, type = "application/json") => ({ method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

  test("only the host's window sees them", async () => {
    const home = tmp();
    expect((await call(home, "/api/projects", {}, false))!.status).toBe(403);
    expect(await call(home, "/api/sessions")).toBeNull();
  });

  test("list, create, thumbnail and open", async () => {
    const home = tmp();
    const created = await call(home, "/api/projects", post({ name: "  Passport " }));
    expect(created!.status).toBe(201);
    expect(((await created!.json()) as any).project.slug).toBe("passport");
    expect((await call(home, "/api/projects", post({ name: "" })))!.status).toBe(400);
    expect((await call(home, "/api/projects", post({ name: "x" }, "text/plain")))!.status).toBe(415);

    const listed = (await (await call(home, "/api/projects"))!.json()) as any;
    expect(listed.projects.map((p: any) => p.name)).toEqual(["Passport"]);

    expect((await call(home, "/api/projects/passport/thumbnail.png"))!.status).toBe(404);
    saveThumbnail(home, "passport", new Uint8Array([137, 80, 78, 71]));
    const png = await call(home, "/api/projects/passport/thumbnail.png");
    expect([png!.status, png!.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await call(home, "/api/projects/..%2F..%2Fx/thumbnail.png"))!.status).toBe(404);

    const opened = (await (await call(home, "/api/projects/open", post({ name: "Billing" })))!.json()) as any;
    expect([opened.switched, opened.project.slug, opened.command]).toEqual([false, "billing", "jamsesh host --project billing"]);
    expect((await call(home, "/api/projects/open", post({ slug: "nope" })))!.status).toBe(404);
  });
});

describe("compatibility", () => {
  test("a host-link secret kept in host/ is copied to the new path and left where it was", () => {
    const home = tmp();
    mkdirSync(join(home, "host"));
    writeFileSync(join(home, "host", "host-link.secret"), "x-jam-link-secret: old\n");
    const file = linkSecretFile(home);
    expect(file).toBe(join(home, "host-link.secret"));
    expect(readFileSync(file, "utf8")).toBe("x-jam-link-secret: old\n");
    expect(readFileSync(join(home, "host", "host-link.secret"), "utf8")).toBe("x-jam-link-secret: old\n");
    writeFileSync(file, "new");
    linkSecretFile(home);
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  test("jamsesh new leaves a mark that the next start uses once", () => {
    const home = tmp();
    expect(takeNewSessionMark(home)).toBe(false);
    mkdirSync(join(home, "projects"));
    writeFileSync(join(home, "projects", ".new-session"), "");
    expect(takeNewSessionMark(home)).toBe(true);
    expect(takeNewSessionMark(home)).toBe(false);
  });

  test("jamsesh new (the script) leaves the mark", () => {
    const home = tmp();
    mkdirSync(join(home, "host"));
    writeFileSync(join(home, "host", "host-link.secret"), "x-jam-link-secret: old\n");
    const run = (...a: string[]) => Bun.spawnSync(["bash", join(import.meta.dir, "../../bin/jamsesh"), ...a], { env: { ...process.env, JAMSESH_HOME: home, JAMSESH_PORT: "1" } });
    expect(run("new").exitCode).toBe(0);
    expect(existsSync(join(home, "projects", ".new-session"))).toBe(true);
  });
});
