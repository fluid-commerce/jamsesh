// Context that carries over (SPEC 12.7). A project's settled context lives in its own SQLite file,
// projects/<slug>/context.db, one row per accepted fact and workstream, each with a version, plus the
// brief and people's titles. A retired fact stays as a tombstone row. A session writes only what it
// changed in meaning (wording, kind, workstream, status; not the lines a fact cites) since it last saw the
// row, saying which version it saw; inside one IMMEDIATE transaction each row is merged on its own: a
// change based on the row's current version applies, a retirement always applies, a tombstone is never
// made active again, and two edits made without seeing each other keep the later one. SQLite's write lock
// belongs to the connection holding it and is released when that process exits, so a paused writer keeps
// it and the others wait. After each write, the committed state is exported (read under the write lock,
// written to a temporary file and renamed) as projects/<slug>/context.json for Phase 7's wiki; it is a
// derived view, never written ahead of what committed. A database that turns out not to be one is left
// where it is and the next generation (context-1.db, context-2.db, ...) is started from the export, which
// every process that finds the damage does the same way.
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "./projects";
import type { Session } from "./session";
import { z } from "zod";
import { newId } from "./store";
import { buildBrief, glossaryOf, goalOf, hasBrief } from "./brief";
import type { Fact, Workstream } from "./types";

export interface ProjectContext {
  version: 1;
  /** How many saves the database has taken: the export says which one it shows. */
  generation: number;
  /** The newest change in it. */
  updatedAt: number;
  /** The session that wrote the brief it holds ("" when none has). */
  fromSession: string;
  /** The session brief as the brain last wrote it (goal, owners, repositories, terms). */
  brief: string;
  /** The brief's structured parts, so the next session's brief starts from the goal and terms rather than from prose. */
  goal: string;
  glossary: { term: string; meaning: string }[];
  /** Every active fact, with its project id and version: none is left out for size. */
  facts: { id: string; version: number; kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number; session: string }[];
  workstreams: { id: string; version: number; title: string; brief: string; status: Workstream["status"]; session: string }[];
  people: { name: string; role: string }[];
  /** Every row as stored, tombstones and versions included: the export is a full copy, and recovery restores it exactly. */
  rows: { items: ItemRow[]; meta: MetaRow[] };
}

type ItemRow = { id: string; type: "fact" | "workstream"; status: string; data: string; version: number; changed_at: number; session: string };
type MetaRow = { key: string; value: string; changed_at: number; session: string };

type FactChange = { id: string; base: number | null; changedAt: number; status: Fact["status"]; kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number };
type WsChange = { id: string; base: number | null; changedAt: number; title: string; brief: string; status: Workstream["status"] };

/** What one session changed since it last saw each row (`base`: the version it saw, null for its own new items). */
export interface ContextChanges {
  session: string;
  facts: FactChange[];
  workstreams: WsChange[];
  /** The session's own brief, when it has one, and when it last changed. */
  brief: { changedAt: number; brief: string; goal: string; glossary: { term: string; meaning: string }[] } | null;
  people: { name: string; role: string }[];
}

export type CommitOutcome = "written" | "skipped" | "failed";

/** What a save did, row by row: the versions it wrote, the changes another session's newer ones won over, and why it failed. */
export interface CommitResult {
  applied: Map<string, number>;
  /** A change not applied, with the row that stands: a tombstone, or a later edit made without seeing this one. */
  superseded: Map<string, ItemRow>;
  /** The save committed but the export didn't (it is written again by the next save), or why nothing was written. */
  reason?: string;
  committed?: boolean;
}

const text = (max: number) => z.string().max(max);
const when = z.number().finite().nonnegative();
const version = z.number().int().positive();
const KIND = z.enum(["decision", "requirement", "constraint", "preference", "question", "fact"]);
const FACT_STATUS = z.enum(["active", "resolved", "superseded"]);
const WS_STATUS = z.enum(["active", "paused", "done"]);
/** Limits well above what the Tasks board and curation write (2000 characters): an accepted fact is never cut, and one past them fails the save. */
const factRow = z.object({ kind: KIND, text: text(20_000).min(1), workstream: text(2000), by: text(2000), note: text(20_000), ts: when });
const wsRow = z.object({ title: text(2000).min(1), brief: text(20_000) });
const briefRow = z.object({ brief: text(40_000), goal: text(2000), glossary: z.array(z.object({ term: text(200).min(1), meaning: text(2000) })).max(300) });
/** Every change is checked before anything is written: a row the next session couldn't read is never written, and no accepted item is cut to fit. */
const changesSchema = z.object({
  session: text(200).min(1),
  facts: z.array(factRow.extend({ id: text(200).min(1), base: version.nullable(), changedAt: when, status: FACT_STATUS })),
  workstreams: z.array(wsRow.extend({ id: text(200).min(1), base: version.nullable(), changedAt: when, status: WS_STATUS })),
  brief: briefRow.extend({ changedAt: when }).nullable(),
  people: z.array(z.object({ name: text(200).min(1), role: text(200).min(1) })),
});

const dirOf = (home: string, slug: string) => join(projectsDir(home), slug);
const dbName = (n: number) => (n ? `context-${n}.db` : "context.db");
/** The database generations on disk, oldest first. */
function generations(home: string, slug: string): number[] {
  let names: string[] = [];
  try {
    names = readdirSync(dirOf(home, slug));
  } catch {}
  return names.map((f) => f.match(/^context(?:-(\d+))?\.db$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => Number(m[1] ?? 0)).sort((a, b) => a - b);
}
/** The current database: the newest generation. */
export const contextFile = (home: string, slug: string) => join(dirOf(home, slug), dbName(generations(home, slug).at(-1) ?? 0));
/** The plain-JSON export (and the only file builds before the database wrote, read once into a new one). */
export const contextExport = (home: string, slug: string) => join(dirOf(home, slug), "context.json");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL);
`;

const busy = (e: unknown) => /SQLITE_BUSY|database is locked/.test(`${(e as { code?: string })?.code ?? ""} ${e instanceof Error ? e.message : ""}`);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const damaged = (e: unknown) => /SQLITE_(NOTADB|CORRUPT)/.test(String((e as { code?: string })?.code ?? ""));

/**
 * Opens the newest generation for writing. One that isn't a database stays where it is (nothing is moved, so two
 * processes that both find it can't move each other's files) and the next generation is opened instead; every process
 * that finds the damage opens the same next file. A new database takes in the export (or an old context.json) once.
 */
function openForWrite(home: string, slug: string, waitMs: number): Database {
  mkdirSync(dirOf(home, slug), { recursive: true });
  let n = generations(home, slug).at(-1) ?? 0;
  const until = Date.now() + waitMs;
  for (let tries = 0; ; tries++) {
    let db: Database | null = null;
    try {
      db = new Database(join(dirOf(home, slug), dbName(n)), { create: true });
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))};`);
      if ((db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null)?.journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA);
      const d = db;
      d.transaction(() => {
        if (d.query("SELECT 1 FROM meta WHERE key = 'imported'").get()) return;
        importJson(d, contextExport(home, slug));
        d.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES ('imported', '1', 0, '')").run();
      }).immediate();
      return d;
    } catch (e) {
      db?.close();
      // Setting up a new file can find it busy without waiting (SQLite doesn't always call the busy handler there): try again until the wait is up.
      if (busy(e) && Date.now() < until) {
        sleepSync(20);
        continue;
      }
      if (!damaged(e) || tries >= 8) throw e;
      console.error(`project context: ${dbName(n)} isn't a database any more; starting ${dbName(n + 1)} from the export`);
      n++;
    }
  }
}

/** An export's last two fields: the checksum of everything before them, then the marker that the file was written whole. */
const seal = (body: object) => ({ ...body, checksum: createHash("sha256").update(JSON.stringify(body)).digest("hex"), complete: true });
function sealedOk(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const { checksum, complete, ...body } = raw as Record<string, unknown>;
  return complete === true && typeof checksum === "string" && checksum === createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** context.json as written by the export or by builds before the database: checked whole before any of it is taken in. */
const rowsSchema = z.object({
  items: z.array(z.object({ id: text(200).min(1), type: z.enum(["fact", "workstream"]), status: z.string(), data: z.string(), version, changed_at: when, session: text(200) })),
  meta: z.array(z.object({ key: text(400).min(1), value: z.string(), changed_at: when, session: text(200) })),
});
const jsonSchema = z.object({
  generation: z.number().int().nonnegative().optional(),
  rows: rowsSchema.optional(),
  updatedAt: when.optional(),
  fromSession: text(200).optional(),
  brief: text(40_000).optional(),
  goal: text(2000).optional(),
  glossary: briefRow.shape.glossary.optional(),
  facts: z.array(factRow.extend({ id: text(200).min(1).optional(), version: version.optional(), session: text(200).optional() })),
  workstreams: z.array(wsRow.extend({ id: text(200).min(1).optional(), version: version.optional(), status: WS_STATUS, session: text(200).optional() })),
  people: z.array(z.object({ name: text(200).min(1), role: text(200) })),
});

/** An export that exists but can't be taken in: the database being set up from it must not be called initialized. */
export class ExportRejected extends Error {}
const reject = (why: string): never => {
  console.error(`project context: ${why}`);
  throw new ExportRejected(why);
};

/**
 * context.json into an empty database, ids and versions kept. No file: nothing to take in (a genuinely new project). A file
 * with any malformed value, or an export that isn't sealed: ExportRejected, so the caller doesn't mark the database
 * imported and the start fails rather than going on empty.
 */
function importJson(db: Database, file: string) {
  if (db.query("SELECT 1 FROM items LIMIT 1").get()) return;
  if (!existsSync(file)) return;
  let parsed: z.infer<typeof jsonSchema>;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // An export (it has the rows) counts only when sealed; the plain file older builds wrote has no rows and no seal.
    if (raw?.rows && !sealedOk(raw)) return reject("context.json isn't a complete export; not taken in");
    const r = jsonSchema.safeParse(raw);
    if (!r.success) return reject("context.json is malformed; not taken in");
    parsed = r.data;
  } catch (e) {
    if (e instanceof ExportRejected) throw e;
    return reject("context.json can't be read; not taken in");
  }
  const put = db.query("INSERT OR IGNORE INTO items (id, type, status, data, version, changed_at, session) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const meta = db.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES (?, ?, ?, ?)");
  // An export: every row back exactly as it was (tombstones and versions too), after checking each would read back.
  if (parsed.rows) {
    const check = new Database(":memory:");
    try {
      check.exec(SCHEMA);
      for (const r of parsed.rows.items) check.query("INSERT INTO items (id, type, status, data, version, changed_at, session) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.id, r.type, r.status, r.data, r.version, r.changed_at, r.session);
      for (const m of parsed.rows.meta) check.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES (?, ?, ?, ?)").run(m.key, m.value, m.changed_at, m.session);
      readAll(check);
    } catch {
      return reject("context.json's rows are malformed; not taken in");
    } finally {
      check.close();
    }
    for (const r of parsed.rows.items) put.run(r.id, r.type, r.status, r.data, r.version, r.changed_at, r.session);
    for (const m of parsed.rows.meta) if (m.key !== "imported") meta.run(m.key, m.value, m.changed_at, m.session);
    return;
  }
  const at = parsed.updatedAt ?? 0;
  const session = parsed.fromSession || "earlier";
  parsed.facts.forEach(({ id, version: v, session: from, ...f }, i) => put.run(id ?? `legacy-f${i}`, "fact", "active", JSON.stringify(f), v ?? 1, at, from || session));
  parsed.workstreams.forEach(({ id, version: v, session: from, status, ...w }, i) => put.run(id ?? `legacy-w${i}`, "workstream", status, JSON.stringify(w), v ?? 1, at, from || session));
  const brief = { brief: parsed.brief ?? "", goal: parsed.goal ?? "", glossary: parsed.glossary ?? [] };
  if (brief.brief || brief.goal || brief.glossary.length) meta.run("brief", JSON.stringify(brief), at, session);
  for (const p of parsed.people) if (p.role) meta.run(`person:${p.name}`, p.role, at, session);
  // Saves go on counting from the export's, so the next export replaces it.
  if (parsed.generation) meta.run("generation", String(parsed.generation), at, session);
}

/** Every row, checked: one value the reader can't use and none of it is used (nothing half-read seeds a session). */
function readAll(db: Database): ProjectContext {
  const items = db.query("SELECT id, type, status, data, version, changed_at, session FROM items ORDER BY rowid").all() as ItemRow[];
  const facts: ProjectContext["facts"] = [];
  const workstreams: ProjectContext["workstreams"] = [];
  let updatedAt = 0;
  for (const row of items) {
    updatedAt = Math.max(updatedAt, row.changed_at);
    const data = JSON.parse(row.data);
    const v = version.parse(row.version);
    if (row.type === "fact") {
      const f = factRow.parse(data);
      if (FACT_STATUS.parse(row.status) === "active") facts.push({ id: row.id, version: v, ...f, session: row.session });
    } else if (row.type === "workstream") {
      const status = WS_STATUS.parse(row.status);
      if (status !== "done") workstreams.push({ id: row.id, version: v, ...wsRow.parse(data), status, session: row.session });
    } else throw new Error(`a row of unknown type ${row.type}`);
  }
  const meta = db.query("SELECT key, value, changed_at, session FROM meta ORDER BY key").all() as MetaRow[];
  const b = meta.find((m) => m.key === "brief");
  const brief = b ? briefRow.parse(JSON.parse(b.value)) : { brief: "", goal: "", glossary: [] };
  const people = meta.filter((m) => m.key.startsWith("person:")).map((m) => ({ name: m.key.slice(7), role: text(200).parse(m.value) }));
  for (const m of meta) updatedAt = Math.max(updatedAt, m.changed_at);
  const generation = Number(meta.find((m) => m.key === "generation")?.value ?? 0);
  facts.sort((x, y) => x.ts - y.ts);
  return { version: 1, generation, updatedAt, fromSession: b?.session ?? "", ...brief, facts, workstreams, people, rows: { items, meta } };
}

export class ContextUnavailable extends Error {}

/**
 * The project's settled context, or null when there is none or any part of it is malformed. Throws ContextUnavailable
 * when it exists but can't be read yet (another process is still setting the database up and held its lock for the
 * whole wait): not "no context", so nothing is seeded from it.
 */
export function readProjectContext(home: string, slug: string, waitMs = 2000): ProjectContext | null {
  if (!generations(home, slug).length) {
    // Nothing saved by this build yet: an old context.json, read the way a new database would take it in.
    if (!existsSync(contextExport(home, slug))) return null;
    const mem = new Database(":memory:");
    try {
      mem.exec(SCHEMA);
      importJson(mem, contextExport(home, slug));
      const ctx = readAll(mem);
      return ctx.facts.length || ctx.workstreams.length || ctx.brief || ctx.goal || ctx.glossary.length || ctx.people.length ? ctx : null;
    } catch (e) {
      if (e instanceof ExportRejected) throw new ContextUnavailable(`the project's saved context can't be read: ${e.message}`);
      return null;
    } finally {
      mem.close();
    }
  }
  let db: Database | null = null;
  try {
    try {
      db = new Database(contextFile(home, slug), { readonly: true });
    } catch (e) {
      // A file mid-setup (no tables or WAL files yet) can't be opened read-only either: it's finished below, like an unimported one.
      if (!/unable to open/.test(e instanceof Error ? e.message : "")) throw e;
    }
    if (db) db.exec(`PRAGMA busy_timeout = ${waitMs};`);
    const ctx = db ? readImported(db) : null;
    if (ctx) return ctx;
    // A database whose setup hasn't finished (a new generation still importing, or one whose creator died first): finish it
    // under the write lock, then read that. Reading it as it stands would seed a session with nothing.
    db?.close();
    db = null;
    db = openForWrite(home, slug, waitMs);
    return readImported(db);
  } catch (e) {
    db?.close();
    db = null;
    if (busy(e)) throw new ContextUnavailable(`the project's context is busy: ${e instanceof Error ? e.message : e}`);
    if (e instanceof ExportRejected) throw new ContextUnavailable(`the project's saved context can't be read: ${e.message}`);
    if (!damaged(e)) {
      console.error("project context:", e instanceof Error ? e.message : e);
      return null;
    }
    // The newest database is damaged: recover first (the next generation, from the export, under its write lock), then read that.
    try {
      db = openForWrite(home, slug, waitMs);
      return readImported(db);
    } catch (e2) {
      if (busy(e2)) throw new ContextUnavailable(`the project's context is busy: ${e2 instanceof Error ? e2.message : e2}`);
      if (e2 instanceof ExportRejected) throw new ContextUnavailable(`the project's saved context can't be read: ${e2.message}`);
      console.error("project context: recovery failed:", e2 instanceof Error ? e2.message : e2);
      return null;
    }
  } finally {
    db?.close();
  }
}

/** Every row in one read transaction (one snapshot), and only once the database has taken in its export; null before that. */
function readImported(db: Database): ProjectContext | null {
  try {
    return db.transaction(() => (db.query("SELECT 1 FROM meta WHERE key = 'imported'").get() ? readAll(db) : null)).deferred();
  } catch (e) {
    if (/no such table|unable to open/.test(e instanceof Error ? e.message : "")) return null;
    throw e;
  }
}

/** What a fact or workstream means, without the bookkeeping (cited lines, notes, timestamps): a change to this is a change to save. */
const factSig = (f: { status: string; kind: string; text: string; workstream: string }) => JSON.stringify([f.status, f.kind, f.text, f.workstream]);
const wsSig = (w: { status: string; title: string; brief: string }) => JSON.stringify([w.status, w.title, w.brief]);
/** Per project id: the version this session last saw (carried in, or saved) and what the item meant then. */
type Bases = Record<string, { v: number; sig: string }>;
const basesOf = (s: Session) => s.store.setting<Bases>("carryBase", {});
const projectId = (x: { id: string; carriedFrom?: { id?: string } }) => x.carriedFrom?.id ?? x.id;

/**
 * What this session changed: accepted facts (a proposal on the Tasks board is not one yet) and workstreams whose
 * meaning differs from the version it last saw (or that it made and never saved), each with that version. An item it
 * only carried in, or whose cited lines alone changed, isn't included. Its brief, once it has one, and people's titles.
 */
export function snapshotContext(s: Session, sessionId: string): ContextChanges {
  const bases = basesOf(s);
  const facts = s.store
    .all("facts")
    .filter((f) => f.text.trim() && bases[projectId(f)]?.sig !== factSig(f))
    .map((f) => ({ id: projectId(f), base: bases[projectId(f)]?.v ?? null, changedAt: f.updatedAt, status: f.status, kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: Math.max(0, Number(f.ts) || 0) }));
  const workstreams = s.store
    .all("workstreams")
    .filter((w) => w.title.trim() && bases[projectId(w)]?.sig !== wsSig(w))
    .map((w) => ({ id: projectId(w), base: bases[projectId(w)]?.v ?? null, changedAt: w.updatedAt, title: w.title, brief: w.brief, status: w.status }));
  const changedAt = Math.max(s.store.digest("brief-parts")?.updated ?? 0, s.store.digest("session")?.updated ?? 0);
  return {
    session: sessionId,
    facts,
    workstreams,
    // The brief is the brain's own summary, not an accepted item: it is cut to the reader's limits.
    brief: hasBrief(s) ? { changedAt, brief: buildBrief(s).full.slice(0, 40_000), goal: goalOf(s).slice(0, 2000), glossary: glossaryOf(s).filter((g) => g.term.trim()).slice(0, 300).map((g) => ({ term: g.term.slice(0, 200), meaning: g.meaning.slice(0, 2000) })) } : null,
    people: s.people().filter((p) => p.role.trim() && p.name.trim()).map((p) => ({ name: p.name.slice(0, 200), role: p.role.slice(0, 200) })),
  };
}

/**
 * Saves what this session changed into the project's context. Only a change the merge applied counts as saved; one a
 * newer change in another session won over (a retirement, or a later edit) is brought in here as that row stands, and
 * the wording that lost goes on the Tasks board for a person to accept again or dismiss. "failed" (the keeper reports
 * it) when it should have saved and didn't, including a save that committed but whose export wasn't written.
 */
export function saveProjectContext(home: string, slug: string, sessionId: string, s: Session, waitMs?: number): CommitOutcome {
  const ch = snapshotContext(s, sessionId);
  const result: CommitResult = { applied: new Map(), superseded: new Map() };
  const out = commitChanges(home, slug, ch, { waitMs, result });
  if (!result.committed) return out;
  const bases = { ...basesOf(s) };
  for (const f of ch.facts) if (result.applied.has(f.id)) bases[f.id] = { v: result.applied.get(f.id)!, sig: factSig(f) };
  for (const w of ch.workstreams) if (result.applied.has(w.id)) bases[w.id] = { v: result.applied.get(w.id)!, sig: wsSig(w) };
  const now = Date.now();
  for (const [id, row] of result.superseded) {
    const data = JSON.parse(row.data);
    const local = s.store.all("facts").find((f) => projectId(f) === id);
    if (local) {
      const lost = { text: local.text, kind: local.kind, workstream: local.workstream };
      const status = FACT_STATUS.parse(row.status);
      const next: Fact = { ...local, status, kind: data.kind, text: data.text, workstream: data.workstream, note: status === "active" ? "Changed in another session" : "Retired in another session", updatedAt: now };
      s.store.put("facts", next);
      bases[id] = { v: row.version, sig: factSig(next) };
      s.board.proposeContext({ text: lost.text, kind: lost.kind, workstream: lost.workstream, by: "Carry-over", note: `Not saved for the project: another session ${status === "active" ? "changed" : "retired"} this fact first. Add it again to keep this wording.` });
      continue;
    }
    const ws = s.store.all("workstreams").find((w) => projectId(w) === id);
    if (ws) {
      const next: Workstream = { ...ws, title: data.title, brief: data.brief, status: WS_STATUS.parse(row.status), updatedAt: now };
      s.store.put("workstreams", next);
      bases[id] = { v: row.version, sig: wsSig(next) };
    }
  }
  s.store.setSetting("carryBase", bases);
  return out;
}

/** Edit A was made after edit B: by time, then by session id, so two edits in one millisecond still have an order. */
const later = (a: { changedAt: number; session: string }, b: { changed_at: number; session: string }) => a.changedAt > b.changed_at || (a.changedAt === b.changed_at && a.session > b.session);

/**
 * Writes the changes in one IMMEDIATE transaction, merging each row on its own (see the top of this file), then
 * exports the committed state. `result` says row by row what happened. A lock held past `waitMs`, anything that
 * doesn't fit, or an export that couldn't be written is a failed save; with nothing to write, an export left behind
 * by an earlier save is written now.
 */
export function commitChanges(home: string, slug: string, ch: ContextChanges, opts: { waitMs?: number; result?: CommitResult } = {}): CommitOutcome {
  const result: CommitResult = opts.result ?? { applied: new Map(), superseded: new Map() };
  const fail = (reason: string) => {
    result.reason = reason;
    console.error("project context:", reason);
    return "failed" as const;
  };
  const valid = changesSchema.safeParse(ch);
  if (!valid.success) return fail(`a change doesn't fit the file's limits; nothing written (${valid.error.issues[0]?.path.join(".")})`);
  const nothing = !ch.facts.length && !ch.workstreams.length && !ch.brief && !ch.people.length;
  if (nothing && !generations(home, slug).length) return "skipped";
  let db: Database | null = null;
  try {
    db = openForWrite(home, slug, opts.waitMs ?? 2000);
    const d = db;
    if (!nothing) {
      d.transaction(() => apply(d, ch, result)).immediate();
      result.committed = true;
    }
  } catch (e) {
    db?.close();
    return fail(e instanceof Error ? e.message : String(e));
  }
  try {
    exportJson(db, contextExport(home, slug));
    return nothing ? "skipped" : "written";
  } catch (e) {
    return fail(`${result.committed ? "saved, but " : ""}the JSON export wasn't written: ${e instanceof Error ? e.message : e}`);
  } finally {
    db.close();
  }
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

function apply(db: Database, ch: ContextChanges, result: CommitResult) {
  const get = db.query("SELECT id, type, status, data, version, changed_at, session FROM items WHERE id = ?");
  const put = db.query("INSERT OR REPLACE INTO items (id, type, status, data, version, changed_at, session) VALUES (?, ?, ?, ?, ?, ?, ?)");
  type Row = ItemRow;
  for (const f of ch.facts) {
    const row = get.get(f.id) as Row | null;
    const retiring = f.status !== "active";
    // A tombstone is final: no write makes a retired fact active again. A retirement always applies; an edit applies when
    // it was made on the current version, or (made without seeing the other) when it is the later of the two.
    const ok = !row || (row.status === "active" && (f.base === row.version || retiring || later({ ...f, session: ch.session }, row)));
    const v = ok ? (row?.version ?? 0) + 1 : row!.version;
    if (ok) put.run(f.id, "fact", f.status, JSON.stringify({ kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: f.ts }), v, f.changedAt, ch.session);
    if (ok) result.applied.set(f.id, v);
    else result.superseded.set(f.id, row!);
    // Retiring a fact the file also holds under another id (the same fact accepted twice, or carried in before items had
    // ids) retires those too: the same kind, workstream and wording.
    if (ok && retiring) {
      const twins = db.query("SELECT id, data, version FROM items WHERE type = 'fact' AND status = 'active' AND id != ?").all(f.id) as { id: string; data: string; version: number }[];
      for (const t of twins) {
        const o = JSON.parse(t.data);
        if (o.kind === f.kind && norm(o.text) === norm(f.text) && norm(o.workstream) === norm(f.workstream)) db.query("UPDATE items SET status = ?, version = ?, changed_at = ?, session = ? WHERE id = ?").run(f.status, t.version + 1, f.changedAt, ch.session, t.id);
      }
    }
  }
  for (const w of ch.workstreams) {
    const row = get.get(w.id) as Row | null;
    const ok = !row || w.base === row.version || later({ ...w, session: ch.session }, row);
    const v = ok ? (row?.version ?? 0) + 1 : row!.version;
    if (ok) put.run(w.id, "workstream", w.status, JSON.stringify({ title: w.title, brief: w.brief }), v, w.changedAt, ch.session);
    if (ok) result.applied.set(w.id, v);
    else result.superseded.set(w.id, row!);
  }
  const meta = db.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES (?, ?, ?, ?)");
  if (ch.brief) {
    const row = db.query("SELECT changed_at, session FROM meta WHERE key = 'brief'").get() as { changed_at: number; session: string } | null;
    if (!row || row.session === ch.session || later({ changedAt: ch.brief.changedAt, session: ch.session }, row)) meta.run("brief", JSON.stringify({ brief: ch.brief.brief, goal: ch.brief.goal, glossary: ch.brief.glossary }), ch.brief.changedAt, ch.session);
  }
  const now = Date.now();
  for (const p of ch.people) meta.run(`person:${p.name}`, p.role, now, ch.session);
  const gen = Number((db.query("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string } | null)?.value ?? 0);
  meta.run("generation", String(gen + 1), now, ch.session);
}

/**
 * The export: read and written while this connection holds the write lock, after the save committed, so exports are
 * written one at a time, each from committed state, and one never replaces a newer one. It holds every row (tombstones
 * and versions too) besides the readable lists. Temporary file, then rename; a failure is thrown to the save.
 */
function exportJson(db: Database, file: string) {
  db.transaction(() => {
    const ctx = readAll(db);
    let shown = -1;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      // Complete only with the marker and the checksum of the body, both written last: a partial or edited file isn't an export.
      if (sealedOk(raw)) shown = raw.generation ?? -1;
      else console.error("project context: context.json isn't a complete export; writing it again");
    } catch {}
    // Exports are written from committed state under this lock, so a valid export is never ahead of the database. One that
    // claims to be (or isn't a count at all) is ignored and written over from the database.
    if (!Number.isSafeInteger(shown) || shown < -1 || shown > ctx.generation) {
      if (shown !== -1) console.error(`project context: context.json's generation (${String(shown)}) isn't valid for this database (${ctx.generation}); writing it again`);
      shown = -1;
    }
    if (shown === ctx.generation) return;
    const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      const fd = openSync(tmp, "wx");
      try {
        writeSync(fd, JSON.stringify(seal(ctx), null, 2));
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }).immediate();
}

/** How long a new session waits for another process still setting the project's context up. */
const SEED_WAIT_MS = 30_000;

/**
 * A new session starts from the project's context: every active fact and unfinished workstream comes in marked
 * `carriedFrom` with its project id, and the version seen is remembered, so only what this session then changes is
 * saved. The brief is kept for the briefing until the brain writes a new one, and people without a title get the one
 * they had. Done once per session; a session that is resumed, or that already has facts or workstreams of its own, is
 * left alone. Returns how many items came in.
 */
export function seedFromProject(home: string, slug: string, sessionId: string, s: Session): number {
  if (s.store.setting("carried", null)) return 0;
  if (s.store.all("facts").some((f) => !f.carriedFrom) || s.store.all("workstreams").some((w) => !w.carriedFrom)) return 0;
  // Waits for another process still setting the context up; if it never finishes this throws, and the session doesn't start empty.
  const ctx = readProjectContext(home, slug, SEED_WAIT_MS);
  if (!ctx) return 0;
  const now = Date.now();
  let n = 0;
  const bases: Bases = { ...basesOf(s) };
  // The same fact saved twice (same kind, workstream and wording) comes in once; anything else that differs comes in.
  const key = (f: { kind: string; workstream: string; text: string }) => JSON.stringify([f.kind, norm(f.workstream), norm(f.text)]);
  const haveFact = new Set(s.store.all("facts").map(key));
  const haveId = new Set(s.store.all("facts").map(projectId));
  for (const f of ctx.facts) {
    if (haveId.has(f.id) || haveFact.has(key(f))) continue;
    haveFact.add(key(f));
    const fact: Fact = { id: newId("fact"), ts: f.ts || now, updatedAt: now, kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, status: "active", note: f.note, sourceEventIds: [], carriedFrom: { sessionId: f.session, at: now, id: f.id } };
    s.store.put("facts", fact, false);
    bases[f.id] = { v: f.version, sig: factSig(fact) };
    n++;
  }
  const haveWs = new Set(s.store.all("workstreams").map((w) => w.title.toLowerCase()));
  for (const w of ctx.workstreams) {
    if (haveWs.has(w.title.toLowerCase())) continue;
    haveWs.add(w.title.toLowerCase());
    const ws: Workstream = { id: newId("w"), title: w.title, ownerAgentId: null, status: w.status === "paused" ? "paused" : "active", brief: w.brief, updatedAt: now, carriedFrom: { sessionId: w.session, at: now, id: w.id } };
    s.store.put("workstreams", ws, false);
    bases[w.id] = { v: w.version, sig: wsSig(w) };
    n++;
  }
  for (const p of ctx.people) {
    const person = s.personByName(p.name);
    if (person && !person.role && p.role) s.store.put("people", { ...person, role: p.role }, false);
  }
  s.store.setSetting("carryBase", bases);
  s.store.setSetting("carried", { fromSession: ctx.fromSession, at: now, brief: ctx.brief, goal: ctx.goal, glossary: ctx.glossary, items: n });
  return n;
}
