// Context that carries over (SPEC 12.7). A project keeps one plain JSON file, projects/<slug>/context.json,
// with what its latest session settled: facts, workstreams, the brief and people's roles. It is
// written while a session runs and when it ends (ProjectKeeper), and a new session of the project
// is seeded from it, each carried item marked with the session it came from. Phase 7's wiki ingests
// this same file.
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "./projects";
import type { Session } from "./session";
import { z } from "zod";
import { newId } from "./store";
import { buildBrief, glossaryOf, goalOf, hasBrief } from "./brief";
import type { Fact, Workstream } from "./types";

export interface ProjectContext {
  version: 1;
  updatedAt: number;
  /** When the writing session last did something (its newest event, fact or workstream): a session less recent than this doesn't overwrite the file. */
  activeAt: number;
  /** The session that wrote the file. */
  fromSession: string;
  /** The session brief as the brain last wrote it (goal, owners, repositories, terms). */
  brief: string;
  /** The brief's structured parts, so the next session's brief starts from the goal and terms rather than from prose. */
  goal: string;
  glossary: { term: string; meaning: string }[];
  facts: { kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number; /** The session that first settled it. */ session: string }[];
  workstreams: { title: string; brief: string; status: Workstream["status"]; session: string }[];
  people: { name: string; role: string }[];
}

const MAX_FACTS = 300;
const MAX_WORKSTREAMS = 40;

const text = (max: number) => z.string().max(max);
const when = z.number().finite().nonnegative();
/** The whole file, every field: one bad value and the file isn't used at all (nothing half-read seeds a session). */
const contextSchema = z.object({
  version: z.literal(1),
  updatedAt: when,
  activeAt: when.optional(),
  fromSession: text(200).min(1),
  brief: text(40_000),
  goal: text(2000),
  glossary: z.array(z.object({ term: text(200).min(1), meaning: text(2000) })).max(300),
  facts: z.array(z.object({ kind: z.enum(["decision", "requirement", "constraint", "preference", "question", "fact"]), text: text(4000).min(1), workstream: text(200), by: text(200), note: text(4000), ts: when, session: text(200) })).max(MAX_FACTS),
  workstreams: z.array(z.object({ title: text(200).min(1), brief: text(8000), status: z.enum(["active", "paused", "done"]), session: text(200) })).max(MAX_WORKSTREAMS),
  people: z.array(z.object({ name: text(200).min(1), role: text(200) })).max(500),
});

export const contextFile = (home: string, slug: string) => join(projectsDir(home), slug, "context.json");

/** The project's context file, or null when there is none or any part of it is malformed. */
export function readProjectContext(home: string, slug: string): ProjectContext | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(contextFile(home, slug), "utf8"));
  } catch {
    return null;
  }
  const r = contextSchema.safeParse(raw);
  if (!r.success) return null;
  return { ...r.data, activeAt: r.data.activeAt ?? r.data.updatedAt };
}

/** Whether this session changed an item since it was carried in (a person retired or rewrote it here). */
const changedHere = (x: { updatedAt: number; carriedFrom?: { at: number } }) => !x.carriedFrom || x.updatedAt > x.carriedFrom.at;

/** When this session last did something: its newest event, or a fact or workstream it made or changed. */
export function lastActive(s: Session) {
  const newest = s.store.recentEvents({ limit: 1 })[0]?.ts ?? 0;
  const changed = [...s.store.all("facts"), ...s.store.all("workstreams")].filter(changedHere).reduce((m, x) => Math.max(m, x.updatedAt || 0), 0);
  return Math.max(newest, changed);
}

/** This session retired something settled (its own or carried): settled-on-nothing is then the news, and the file says so. */
const retiredHere = (s: Session) => [...s.store.all("facts"), ...s.store.all("workstreams")].some((x) => changedHere(x) && x.status !== "active" && x.status !== "paused");

const clip = (t: unknown, n: number) => String(t ?? "").slice(0, n);

/** What this session has settled right now: its accepted facts (a proposal on the Tasks board is not one yet), live workstreams, brief and people's titles. Every field fits the reader's limits. */
export function snapshotContext(s: Session, sessionId: string): ProjectContext {
  const now = Date.now();
  const facts = s.store
    .all("facts")
    .filter((f) => f.status === "active" && f.text.trim())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FACTS)
    .map((f) => ({ kind: f.kind, text: clip(f.text, 4000), workstream: clip(f.workstream, 200), by: clip(f.by, 200), note: clip(f.note, 4000), ts: Math.max(0, Number(f.ts) || 0), session: clip(f.carriedFrom?.sessionId ?? sessionId, 200) }));
  const workstreams = s.store
    .all("workstreams")
    .filter((w) => w.status !== "done" && w.title.trim())
    .slice(0, MAX_WORKSTREAMS)
    .map((w) => ({ title: clip(w.title, 200), brief: clip(w.brief, 8000), status: w.status, session: clip(w.carriedFrom?.sessionId ?? sessionId, 200) }));
  const carried = s.store.setting<{ brief?: string } | null>("carried", null);
  return {
    goal: clip(goalOf(s), 2000),
    glossary: glossaryOf(s).filter((g) => g.term.trim()).slice(0, 300).map((g) => ({ term: clip(g.term, 200), meaning: clip(g.meaning, 2000) })),
    version: 1,
    updatedAt: now,
    activeAt: lastActive(s),
    fromSession: clip(sessionId, 200),
    brief: clip(hasBrief(s) ? buildBrief(s).full : carried?.brief || "", 40_000),
    facts,
    workstreams,
    people: s.people().filter((p) => p.role && p.name.trim()).slice(0, 500).map((p) => ({ name: clip(p.name, 200), role: clip(p.role, 200) })),
  };
}

/**
 * Writes the project's context file. A session that has settled nothing never empties a file that has something
 * (unless it retired what was there), and a session that was last active before the one that wrote the file never
 * overwrites it (an older session left open doesn't undo a newer one). Returns whether it wrote.
 */
export function writeProjectContext(home: string, slug: string, sessionId: string, s: Session): boolean {
  return saveProjectContext(home, slug, sessionId, s) === "written";
}

/**
 * `writeProjectContext` with the reason it didn't write: "skipped" is a choice (nothing settled, or a newer session
 * owns the file), "failed" is a save that should have happened and didn't (a lock that stayed held, a snapshot the
 * reader couldn't take, a file that couldn't be written), which the keeper reports so shutdown doesn't call it clean.
 */
export function saveProjectContext(home: string, slug: string, sessionId: string, s: Session): CommitOutcome {
  const ctx = snapshotContext(s, sessionId);
  const empty = !ctx.facts.length && !ctx.workstreams.length && !ctx.brief && !ctx.goal;
  return commitContextOutcome(home, slug, ctx, { allowEmpty: !empty || retiredHere(s) });
}

export type CommitOutcome = "written" | "skipped" | "failed";

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const LOCK_STALE_MS = 10_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLock = (lock: string): { token: string; pid: number } | null => {
  try {
    const [pid, token] = readFileSync(lock, "utf8").trim().split(" ");
    return token && Number.isInteger(Number(pid)) ? { pid: Number(pid), token } : null;
  } catch {
    return null;
  }
};

/**
 * Takes the lock file (O_EXCL) and returns the token that proves ownership, or null when it stays held. The owner's
 * pid and token are written in it. A lock is taken over only when it is old AND its owner is gone (the process is dead,
 * or it is this process, which can't be mid-write: the write is synchronous); a writer that is only paused (stopped,
 * or starved for longer than the threshold) keeps its lock. An old lock with nothing readable in it is an owner that
 * died between creating and filling it. The takeover moves the lock aside and puts it back if it wasn't the one judged
 * stale, so a lock somebody else just took is not removed.
 */
export function acquireLock(lock: string, waitMs = 2000): string | null {
  const token = crypto.randomUUID();
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid} ${token}`);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch {
      try {
        const held = readLock(lock);
        const old = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        if (old && (held ? held.pid === process.pid || !alive(held.pid) : true)) {
          const aside = `${lock}.stale-${crypto.randomUUID().slice(0, 8)}`;
          renameSync(lock, aside);
          const moved = readLock(aside);
          if (held && moved && moved.token !== held.token) {
            // Not the lock we judged: a live one was taken between the check and the move. Give it back.
            try {
              linkSync(aside, lock);
            } catch {}
          }
          rmSync(aside, { force: true });
        }
      } catch {}
      if (Date.now() > until) return null;
      sleepSync(25);
    }
  }
}

/** Removes the lock only if it is still ours. */
export function releaseLock(lock: string, token: string) {
  if (readLock(lock)?.token === token) rmSync(lock, { force: true });
}

/**
 * The compare-and-replace, under a lock file made with O_EXCL so two hub processes (two sessions of one project)
 * can't both pass the activeAt check and the older one rename last (see `acquireLock` for who may take a lock over).
 * The snapshot is checked against the reader's schema first: a file the next session couldn't read is never written.
 * A file that can't be read is kept beside the new one. The lock is checked again just before the rename.
 */
export function commitContext(home: string, slug: string, ctx: ProjectContext, opts: { allowEmpty?: boolean; waitMs?: number } = {}): boolean {
  return commitContextOutcome(home, slug, ctx, opts) === "written";
}

export function commitContextOutcome(home: string, slug: string, ctx: ProjectContext, opts: { allowEmpty?: boolean; waitMs?: number } = {}): CommitOutcome {
  if (!contextSchema.safeParse(ctx).success) {
    console.error("project context: the snapshot doesn't fit the file's limits; not written");
    return "failed";
  }
  const empty = !ctx.facts.length && !ctx.workstreams.length && !ctx.brief && !ctx.goal;
  const file = contextFile(home, slug);
  mkdirSync(join(projectsDir(home), slug), { recursive: true });
  const lock = `${file}.lock`;
  const token = acquireLock(lock, opts.waitMs);
  if (!token) return "failed";
  try {
    if (existsSync(file)) {
      if (empty && !opts.allowEmpty) return "skipped";
      const cur = readProjectContext(home, slug);
      if (cur && cur.fromSession !== ctx.fromSession && cur.activeAt > ctx.activeAt) return "skipped";
      if (!cur) renameSync(file, `${file}.unreadable-${Date.now()}`);
    }
    const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, JSON.stringify(ctx, null, 2));
    } finally {
      closeSync(fd);
    }
    if (readLock(lock)?.token !== token) {
      rmSync(tmp, { force: true });
      return "failed";
    }
    renameSync(tmp, file);
    return "written";
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * A new session starts from the project's context file: facts and workstreams come in marked
 * `carriedFrom`, the brief is kept for the briefing until the brain writes a new one, and people
 * without a title get the one they had. Done once per session; a session that is resumed, or that
 * already has facts or workstreams of its own, is left alone. Returns how many items came in.
 */
export function seedFromProject(home: string, slug: string, sessionId: string, s: Session): number {
  if (s.store.setting("carried", null)) return 0;
  // A session reopened with context of its own keeps it: another session's file never mixes into it.
  if (s.store.all("facts").some((f) => !f.carriedFrom) || s.store.all("workstreams").some((w) => !w.carriedFrom)) return 0;
  const ctx = readProjectContext(home, slug);
  if (!ctx || ctx.fromSession === sessionId) return 0;
  const now = Date.now();
  let n = 0;
  const haveFact = new Set(s.store.all("facts").map((f) => f.text.trim().toLowerCase()));
  for (const f of ctx.facts) {
    if (haveFact.has(f.text.trim().toLowerCase())) continue;
    s.store.put("facts", { id: newId("fact"), ts: f.ts || now, updatedAt: now, kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, status: "active", note: f.note, sourceEventIds: [], carriedFrom: { sessionId: f.session || ctx.fromSession, at: now } }, false);
    n++;
  }
  const haveWs = new Set(s.store.all("workstreams").map((w) => w.title.toLowerCase()));
  for (const w of ctx.workstreams) {
    if (haveWs.has(w.title.toLowerCase())) continue;
    s.store.put("workstreams", { id: newId("w"), title: w.title, ownerAgentId: null, status: w.status === "paused" ? "paused" : "active", brief: w.brief, updatedAt: now, carriedFrom: { sessionId: w.session || ctx.fromSession, at: now } }, false);
    n++;
  }
  for (const p of ctx.people) {
    const person = s.personByName(p.name);
    if (person && !person.role && p.role) s.store.put("people", { ...person, role: p.role }, false);
  }
  s.store.setSetting("carried", { fromSession: ctx.fromSession, at: now, brief: ctx.brief, goal: ctx.goal, glossary: ctx.glossary, items: n });
  return n;
}
