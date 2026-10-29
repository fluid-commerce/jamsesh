import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { projectsRoute } from "../src/projects-api";
import { cleanName, createProject, defaultProject, findProject, isSlug, listProjects, listSessions, migrateLegacy, openSession, readProject, saveThumbnail, slugify, touchSession } from "../src/projects";

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
