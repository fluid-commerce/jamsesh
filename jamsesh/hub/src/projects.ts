// Projects: ~/.jamsesh/projects/<slug>/ holds many sessions (SPEC 3.6). Each session directory is a
// hub data directory of its own (jamsesh.db, renders, snapshots), so everything below the project
// layer works as it always has; the project adds a name, the people who came, and a thumbnail.
//
//   projects/<slug>/project.json     name, created, lastUsed, people
//   projects/<slug>/thumbnail.png    the canvas, small, saved while a session runs and when it ends
//   projects/<slug>/sessions/<id>/   one session's data (session.json says when it began and was last active)
//
// The folder is also the project's wiki folder (jamsesh-wiki-proposal.md): WIKI.md, wiki/ and raw/
// sit beside sessions/, so sessions never share a name with them.
//
// This file takes the home directory as an argument and imports nothing from config, so tests and
// the migration can point it at a temp directory.
import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProjectPerson {
  name: string;
  color?: string;
}

export interface ProjectMeta {
  name: string;
  slug: string;
  created: number;
  lastUsed: number;
  /** Everyone who came to any of its sessions, most recent first. */
  people: ProjectPerson[];
}

export interface ProjectSummary extends ProjectMeta {
  sessions: number;
  /** When the thumbnail was saved, or null when the canvas has never been drawn. */
  thumbnailAt: number | null;
  /** A session from today exists: opening the project continues it instead of starting a new one. */
  resumable: boolean;
}

export interface SessionMeta {
  id: string;
  startedAt: number;
  lastActive: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PEOPLE = 24;

export const projectsDir = (home: string) => join(home, "projects");
export const isSlug = (s: unknown): s is string => typeof s === "string" && SLUG.test(s);

/** The name as typed, tidied: one line, no control characters, at most 80 characters. */
export function cleanName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "project";
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Written beside the target and renamed over it, so a crash never leaves half a file. */
function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

const dirOf = (home: string, slug: string) => join(projectsDir(home), slug);

export function readProject(home: string, slug: string): ProjectMeta | null {
  if (!isSlug(slug)) return null;
  const m = readJson<Partial<ProjectMeta>>(join(dirOf(home, slug), "project.json"));
  if (!m || typeof m.name !== "string") return null;
  return {
    name: m.name,
    slug,
    created: Number(m.created) || 0,
    lastUsed: Number(m.lastUsed) || 0,
    people: Array.isArray(m.people) ? m.people.filter((p) => p && typeof p.name === "string").slice(0, MAX_PEOPLE) : [],
  };
}

export function writeProject(home: string, meta: ProjectMeta) {
  const dir = dirOf(home, meta.slug);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "project.json"), { name: meta.name, created: meta.created, lastUsed: meta.lastUsed, people: meta.people.slice(0, MAX_PEOPLE) });
}

export function listSessions(home: string, slug: string): SessionMeta[] {
  const root = join(dirOf(home, slug), "sessions");
  if (!existsSync(root)) return [];
  const out: SessionMeta[] = [];
  for (const id of readdirSync(root)) {
    // A copy still being made (migration) has a hidden name.
    if (id.startsWith(".")) continue;
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const m = readJson<Partial<SessionMeta>>(join(dir, "session.json"));
    const st = statSync(dir);
    out.push({ id, startedAt: Number(m?.startedAt) || st.birthtimeMs, lastActive: Number(m?.lastActive) || st.mtimeMs });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function listProjects(home: string, now = Date.now()): ProjectSummary[] {
  const root = projectsDir(home);
  if (!existsSync(root)) return [];
  const out: ProjectSummary[] = [];
  for (const slug of readdirSync(root)) {
    const meta = readProject(home, slug);
    if (!meta) continue;
    const sessions = listSessions(home, slug);
    let thumbnailAt: number | null = null;
    try {
      thumbnailAt = statSync(join(dirOf(home, slug), "thumbnail.png")).mtimeMs;
    } catch {}
    out.push({ ...meta, sessions: sessions.length, thumbnailAt, resumable: !!sessions[0] && sameDay(sessions[0].lastActive, now) });
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

/** Makes a project folder; the slug gets a number when the name is taken. */
export function createProject(home: string, rawName: string, now = Date.now()): ProjectMeta {
  const name = cleanName(rawName);
  if (!name) throw new Error("Give the project a name.");
  const base = slugify(name);
  let slug = base;
  for (let n = 2; existsSync(dirOf(home, slug)); n++) slug = `${base.slice(0, 44)}-${n}`;
  const meta: ProjectMeta = { name, slug, created: now, lastUsed: now, people: [] };
  writeProject(home, meta);
  return meta;
}

/** A project by slug, or by name (case-insensitive); null when there's none. */
export function findProject(home: string, key: string): ProjectMeta | null {
  const bySlug = readProject(home, key);
  if (bySlug) return bySlug;
  const want = cleanName(key).toLowerCase();
  return want ? (listProjects(home).find((p) => p.name.toLowerCase() === want) ?? null) : null;
}

export interface OpenedSession {
  project: ProjectMeta;
  sessionId: string;
  dir: string;
  resumed: boolean;
}

/**
 * Opening a project: continue today's session when there is one, else begin a new one. `fresh`
 * always begins a new one. The session directory is created here and stamped in session.json.
 */
export function openSession(home: string, slug: string, opts: { fresh?: boolean; now?: number } = {}): OpenedSession {
  const now = opts.now ?? Date.now();
  const project = readProject(home, slug);
  if (!project) throw new Error("That project isn't here.");
  const latest = listSessions(home, slug)[0];
  let id: string;
  let resumed = false;
  if (latest && !opts.fresh && sameDay(latest.lastActive, now)) {
    id = latest.id;
    resumed = true;
  } else {
    const d = new Date(now);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stem = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    id = stem;
    for (let n = 2; existsSync(join(dirOf(home, slug), "sessions", id)); n++) id = `${stem}-${n}`;
  }
  const dir = join(dirOf(home, slug), "sessions", id);
  mkdirSync(dir, { recursive: true });
  const prior = readJson<Partial<SessionMeta>>(join(dir, "session.json"));
  writeJson(join(dir, "session.json"), { id, startedAt: Number(prior?.startedAt) || now, lastActive: now } satisfies SessionMeta);
  writeProject(home, { ...project, lastUsed: now });
  return { project, sessionId: id, dir, resumed };
}

/** Marks the session active now; the project's last-used date follows. */
export function touchSession(home: string, slug: string, sessionId: string, people: ProjectPerson[] = [], now = Date.now()) {
  const dir = join(dirOf(home, slug), "sessions", sessionId);
  const prior = readJson<Partial<SessionMeta>>(join(dir, "session.json"));
  if (existsSync(dir)) writeJson(join(dir, "session.json"), { id: sessionId, startedAt: Number(prior?.startedAt) || now, lastActive: now } satisfies SessionMeta);
  const project = readProject(home, slug);
  if (!project) return;
  const seen = new Set<string>();
  const merged = [...people, ...project.people].filter((p) => {
    const k = p.name.toLowerCase();
    return !seen.has(k) && !!seen.add(k);
  });
  writeProject(home, { ...project, lastUsed: now, people: merged });
}

export function saveThumbnail(home: string, slug: string, png: Uint8Array) {
  if (!isSlug(slug) || !existsSync(dirOf(home, slug))) return;
  const file = join(dirOf(home, slug), "thumbnail.png");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, file);
}

export function thumbnailPath(home: string, slug: string): string | null {
  if (!isSlug(slug)) return null;
  const file = join(dirOf(home, slug), "thumbnail.png");
  return existsSync(file) ? file : null;
}

/** The project the hub opens when nothing says which: the last used, or a first one. */
export function defaultProject(home: string): ProjectMeta {
  const first = listProjects(home)[0];
  return first ? (readProject(home, first.slug) ?? createProject(home, "My project")) : createProject(home, "My project");
}

// ---- migration from the single-session layout ----

export interface MigrationRecord {
  from: string;
  to: string;
  project: string;
  events: number;
  docs: number;
  verified: boolean;
  note?: string;
}

const MIGRATION_FILE = ".migration.json";

/** `host` (the last session) and `host-YYYY-MM-DD-HHMM` (archived by `jamsesh new`) under the home directory. */
function legacySessions(home: string): string[] {
  if (!existsSync(home)) return [];
  return readdirSync(home)
    .filter((d) => d === "host" || /^host-\d{4}-\d{2}-\d{2}-\d{4}$/.test(d))
    .map((d) => join(home, d))
    .filter((d) => existsSync(join(d, "jamsesh.db")));
}

function counts(db: Database) {
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
  return { events: one("SELECT COUNT(*) AS n FROM events"), docs: one("SELECT COUNT(*) AS n FROM docs") };
}

/**
 * Brings the old sessions into projects. Nothing is moved or deleted: each old directory is copied
 * into projects/<name>/sessions/ (the database through a private copy and VACUUM INTO, so the
 * original is never opened), counted against the copy, and left where it was. Sessions with the same
 * name become one project. projects/.migration.json records each source; one copied and verified is
 * done, and any other is tried again at the next start. A copy is built under a hidden name and only
 * takes its real one once verified, so a failed or cut-off copy never shows as a session.
 */
export function migrateLegacy(home: string, waitMs = 60_000): MigrationRecord[] {
  // One migration at a time per home: two hubs starting together would copy the same sessions and
  // overwrite each other's record. The other start waits, then finds the work done.
  const root = projectsDir(home);
  mkdirSync(root, { recursive: true });
  const lock = join(root, MIGRATION_LOCK);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockAbandoned(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      // Still busy after the wait: leave it to that start (this one tries again next time).
      if (Date.now() > until) return readJson<{ records: MigrationRecord[] }>(join(root, MIGRATION_FILE))?.records ?? [];
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return migrateNow(home);
  } finally {
    rmSync(lock, { force: true });
  }
}

const MIGRATION_LOCK = ".migration.lock";

/** A lock left by a process that's gone (or one far older than any migration takes). */
function lockAbandoned(lock: string) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) return true;
    const pid = Number(readFileSync(lock, "utf8"));
    // Being written right now: not abandoned yet.
    if (!pid) return Date.now() - statSync(lock).mtimeMs > 5_000;
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function migrateNow(home: string): MigrationRecord[] {
  const root = projectsDir(home);
  const marker = join(root, MIGRATION_FILE);
  const before = readJson<{ records: MigrationRecord[] }>(marker)?.records ?? [];
  const done = new Map(before.filter((r) => r.verified).map((r) => [r.from, r]));
  const pending = legacySessions(home).filter((src) => !done.has(src));
  if (existsSync(marker) && !pending.length) return before;
  const records: MigrationRecord[] = [];
  // Projects this migration made before (by name), so a retried session joins its siblings.
  const byName = new Map<string, ProjectMeta>();
  for (const r of before) {
    const p = r.project ? readProject(home, r.project) : null;
    if (p) byName.set(p.name.toLowerCase(), p);
  }
  for (const src of pending) {
    const scratch = mkdtempSync(join(tmpdir(), "jamsesh-migrate-"));
    let made: ProjectMeta | null = null;
    let project: ProjectMeta | null = null;
    let staging = "";
    try {
      for (const f of ["jamsesh.db", "jamsesh.db-wal", "jamsesh.db-shm"]) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(scratch, f));
      const work = new Database(join(scratch, "jamsesh.db"));
      try {
        const setting = (key: string) => {
          const row = work.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
          try {
            return row ? JSON.parse(row.value) : null;
          } catch {
            return null;
          }
        };
        const name = cleanName(setting("sessionName")) || "Jam session";
        project = byName.get(name.toLowerCase()) ?? null;
        if (!project) {
          project = made = createProject(home, name, statSync(src).mtimeMs);
          byName.set(name.toLowerCase(), project);
        }
        const span = work.query("SELECT MIN(ts) AS a, MAX(ts) AS b FROM events").get() as { a: number | null; b: number | null };
        const mtime = statSync(join(src, "jamsesh.db")).mtimeMs;
        const lastActive = Math.max(span.b ?? 0, mtime);
        const startedAt = span.a ?? statSync(src).birthtimeMs;
        const sessions = join(dirOf(home, project.slug), "sessions");
        const id = (existsSync(join(sessions, basenameOf(src))) ? `${basenameOf(src)}-copy` : basenameOf(src)).replace(/^host$/, "last-session");
        const dest = join(sessions, id);
        // Private to this attempt: nothing else ever writes or removes it.
        staging = join(sessions, `.${id}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.partial`);
        mkdirSync(staging, { recursive: true });
        cpSync(src, staging, { recursive: true, filter: (f) => !/jamsesh\.db(-wal|-shm)?$|host-link\.secret$/.test(f) });
        work.exec(`VACUUM INTO '${join(staging, "jamsesh.db").replace(/'/g, "''")}'`);
        const was = counts(work);
        const copy = new Database(join(staging, "jamsesh.db"), { readonly: true });
        const after = counts(copy);
        copy.close();
        const verified = was.events === after.events && was.docs === after.docs;
        if (!verified) throw new Error(`counts differ (${was.events}/${was.docs} vs ${after.events}/${after.docs}); the copy was removed`);
        writeJson(join(staging, "session.json"), { id, startedAt, lastActive } satisfies SessionMeta);
        renameSync(staging, dest);
        staging = "";
        const names = (work.query("SELECT DISTINCT author_name AS n FROM events WHERE author_type = 'person' ORDER BY id DESC LIMIT 40").all() as { n: string }[]).map((r) => ({ name: r.n }));
        const cur = readProject(home, project.slug) ?? project;
        const seen = new Set(cur.people.map((p) => p.name.toLowerCase()));
        const merged = { ...cur, lastUsed: Math.max(cur.lastUsed, lastActive), people: [...cur.people, ...names.filter((p) => !seen.has(p.name.toLowerCase()))] };
        writeProject(home, merged);
        byName.set(name.toLowerCase(), merged);
        records.push({ from: src, to: dest, project: project.slug, ...after, verified: true });
      } finally {
        work.close();
      }
    } catch (e) {
      if (staging) rmSync(staging, { recursive: true, force: true });
      // A project made only for this session, which didn't come over, goes too.
      if (made && !listSessions(home, made.slug).length) {
        rmSync(dirOf(home, made.slug), { recursive: true, force: true });
        byName.delete(made.name.toLowerCase());
        project = null;
      }
      records.push({ from: src, to: "", project: project?.slug ?? "", events: 0, docs: 0, verified: false, note: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const all = [...done.values(), ...records];
  writeJson(marker, { at: Date.now(), records: all });
  return all;
}

const basenameOf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/**
 * Where a terminal hub keeps its host-link secret: `<home>/host-link.secret`. Installs from before
 * projects kept it in `<home>/host/`; when only that one exists it is copied to the new path (never
 * moved, an older hub or app may still read it there).
 */
export function linkSecretFile(home: string): string {
  const file = join(home, "host-link.secret");
  const old = join(home, "host", "host-link.secret");
  if (!existsSync(file) && existsSync(old)) {
    try {
      copyFileSync(old, file);
    } catch {}
  }
  return file;
}

/** `jamsesh new` leaves this behind: the next hub start begins a new session, then removes it. */
export function takeNewSessionMark(home: string): boolean {
  const mark = join(projectsDir(home), ".new-session");
  if (!existsSync(mark)) return false;
  rmSync(mark, { force: true });
  return true;
}
