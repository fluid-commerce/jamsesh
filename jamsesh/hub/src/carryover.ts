// Context that carries over (SPEC 12.7). A project's settled context lives in its own SQLite file,
// projects/<slug>/context.db, one row per accepted fact and workstream plus the brief and people's roles.
// A session writes only what it changed (what it settled, rewrote or retired), never a whole copy, so two
// sessions of one project that overlap both keep their changes; when both changed the same item, the later
// change wins, whichever saves last. Every write is one IMMEDIATE transaction: SQLite's write lock belongs
// to the connection holding it and is released when that process exits, so a paused writer keeps it, the
// others wait, and no file renaming can hand it to someone else. It is written while a session runs and
// when it ends (ProjectKeeper); a new session of the project is seeded from it, each carried item marked
// with its project id. After each write the whole context is also exported as projects/<slug>/context.json
// (plain JSON, every active item), which Phase 7's wiki ingests.
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "./projects";
import type { Session } from "./session";
import { z } from "zod";
import { newId } from "./store";
import { buildBrief, glossaryOf, goalOf, hasBrief } from "./brief";
import type { Fact, Workstream } from "./types";

export interface ProjectContext {
  version: 1;
  /** The newest change in it. */
  updatedAt: number;
  activeAt: number;
  /** The session that wrote the brief it holds ("" when none has). */
  fromSession: string;
  /** The session brief as the brain last wrote it (goal, owners, repositories, terms). */
  brief: string;
  /** The brief's structured parts, so the next session's brief starts from the goal and terms rather than from prose. */
  goal: string;
  glossary: { term: string; meaning: string }[];
  /** Every active fact, with its project id: none is left out for size. */
  facts: { id: string; kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number; session: string }[];
  workstreams: { id: string; title: string; brief: string; status: Workstream["status"]; session: string }[];
  people: { name: string; role: string }[];
}

/** What one session changed since it was carried in: the only rows it may write. */
export interface ContextChanges {
  session: string;
  facts: { id: string; changedAt: number; status: Fact["status"]; kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number }[];
  workstreams: { id: string; changedAt: number; title: string; brief: string; status: Workstream["status"] }[];
  /** The session's own brief, when it has one, and when it last changed. */
  brief: { changedAt: number; brief: string; goal: string; glossary: { term: string; meaning: string }[] } | null;
  people: { name: string; role: string }[];
}

export type CommitOutcome = "written" | "skipped" | "failed";

const text = (max: number) => z.string().max(max);
const when = z.number().finite().nonnegative();
const KIND = z.enum(["decision", "requirement", "constraint", "preference", "question", "fact"]);
const WS_STATUS = z.enum(["active", "paused", "done"]);
/** Limits well above what the Tasks board and curation write (2000 characters): an accepted fact is never cut, and one past them fails the save. */
const factRow = z.object({ kind: KIND, text: text(20_000).min(1), workstream: text(2000), by: text(2000), note: text(20_000), ts: when });
const wsRow = z.object({ title: text(2000).min(1), brief: text(20_000) });
const briefRow = z.object({ brief: text(40_000), goal: text(2000), glossary: z.array(z.object({ term: text(200).min(1), meaning: text(2000) })).max(300) });
/** Every change is checked before anything is written: a row the next session couldn't read is never written, and no accepted item is cut to fit. */
const changesSchema = z.object({
  session: text(200).min(1),
  facts: z.array(factRow.extend({ id: text(200).min(1), changedAt: when, status: z.enum(["active", "resolved", "superseded"]) })),
  workstreams: z.array(wsRow.extend({ id: text(200).min(1), changedAt: when, status: WS_STATUS })),
  brief: briefRow.extend({ changedAt: when }).nullable(),
  people: z.array(z.object({ name: text(200).min(1), role: text(200).min(1) })),
});

export const contextFile = (home: string, slug: string) => join(projectsDir(home), slug, "context.db");
/** The plain-JSON export (and the only file earlier builds wrote, read once into a new database). */
export const contextExport = (home: string, slug: string) => join(projectsDir(home), slug, "context.json");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL);
`;

function open(home: string, slug: string, waitMs: number): Database {
  mkdirSync(join(projectsDir(home), slug), { recursive: true });
  const db = new Database(contextFile(home, slug), { create: true });
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** Every row, checked: one value the reader can't use and none of it is used (nothing half-read seeds a session). */
function readAll(db: Database): ProjectContext {
  const items = db.query("SELECT id, type, status, data, changed_at, session FROM items ORDER BY rowid").all() as { id: string; type: string; status: string; data: string; changed_at: number; session: string }[];
  const facts: ProjectContext["facts"] = [];
  const workstreams: ProjectContext["workstreams"] = [];
  let updatedAt = 0;
  for (const row of items) {
    updatedAt = Math.max(updatedAt, row.changed_at);
    const data = JSON.parse(row.data);
    if (row.type === "fact") {
      const f = factRow.parse(data);
      if (row.status === "active") facts.push({ id: row.id, ...f, session: row.session });
    } else if (row.type === "workstream") {
      const status = WS_STATUS.parse(row.status);
      if (status !== "done") workstreams.push({ id: row.id, ...wsRow.parse(data), status, session: row.session });
    } else throw new Error(`a row of unknown type ${row.type}`);
  }
  const meta = db.query("SELECT key, value, changed_at, session FROM meta").all() as { key: string; value: string; changed_at: number; session: string }[];
  const b = meta.find((m) => m.key === "brief");
  const brief = b ? briefRow.parse(JSON.parse(b.value)) : { brief: "", goal: "", glossary: [] };
  const people = meta.filter((m) => m.key.startsWith("person:")).map((m) => ({ name: m.key.slice(7), role: text(200).parse(m.value) }));
  for (const m of meta) updatedAt = Math.max(updatedAt, m.changed_at);
  facts.sort((x, y) => x.ts - y.ts);
  return { version: 1, updatedAt, activeAt: updatedAt, fromSession: b?.session ?? "", ...brief, facts, workstreams, people };
}

/** The project's settled context, or null when there is none or any part of it is malformed. */
export function readProjectContext(home: string, slug: string): ProjectContext | null {
  if (!existsSync(contextFile(home, slug))) {
    const ch = legacyChanges(home, slug);
    return ch ? { version: 1, updatedAt: ch.brief?.changedAt ?? 0, activeAt: ch.brief?.changedAt ?? 0, fromSession: ch.session, brief: ch.brief?.brief ?? "", goal: ch.brief?.goal ?? "", glossary: ch.brief?.glossary ?? [], facts: ch.facts.map(({ changedAt: _c, status: _s, ...f }) => ({ ...f, session: ch.session })), workstreams: ch.workstreams.filter((w) => w.status !== "done").map(({ changedAt: _c, ...w }) => ({ ...w, session: ch.session })), people: ch.people } : null;
  }
  let db: Database | null = null;
  try {
    db = new Database(contextFile(home, slug), { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000;");
    return readAll(db);
  } catch (e) {
    console.error("project context:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    db?.close();
  }
}

/** A context.json from before the database, as changes from the session that wrote it (each item gets an id here). */
function legacyChanges(home: string, slug: string): ContextChanges | null {
  try {
    const raw = JSON.parse(readFileSync(contextExport(home, slug), "utf8"));
    const at = Math.max(0, Number(raw.updatedAt) || 0);
    const ch: ContextChanges = {
      session: String(raw.fromSession || "earlier"),
      facts: (raw.facts ?? []).map((f: any, i: number) => ({ id: String(f.id ?? `legacy-f${i}`), changedAt: at, status: "active", kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: f.ts })),
      workstreams: (raw.workstreams ?? []).map((w: any, i: number) => ({ id: String(w.id ?? `legacy-w${i}`), changedAt: at, title: w.title, brief: w.brief, status: w.status })),
      brief: raw.brief || raw.goal || raw.glossary?.length ? { changedAt: at, brief: raw.brief ?? "", goal: raw.goal ?? "", glossary: raw.glossary ?? [] } : null,
      people: (raw.people ?? []).filter((p: any) => p?.role !== ""),
    };
    return changesSchema.safeParse(ch).success ? ch : null;
  } catch {
    return null;
  }
}

/** Whether this session changed an item since it was carried in (a person retired or rewrote it here). */
const changedHere = (x: { updatedAt: number; carriedFrom?: { at: number } }) => !x.carriedFrom || x.updatedAt > x.carriedFrom.at;

/**
 * What this session changed: its accepted facts (a proposal on the Tasks board is not one yet) and workstreams, active
 * or retired, each under the project id it was carried in with (its own id for its own). Items it only carried in aren't
 * included, so saving can't undo another session's change to them. Its brief, once it has one, and people's titles.
 */
export function snapshotContext(s: Session, sessionId: string): ContextChanges {
  const facts = s.store
    .all("facts")
    .filter((f) => changedHere(f) && f.text.trim())
    .map((f) => ({ id: f.carriedFrom?.id ?? f.id, changedAt: f.updatedAt, status: f.status, kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: Math.max(0, Number(f.ts) || 0) }));
  const workstreams = s.store
    .all("workstreams")
    .filter((w) => changedHere(w) && w.title.trim())
    .map((w) => ({ id: w.carriedFrom?.id ?? w.id, changedAt: w.updatedAt, title: w.title, brief: w.brief, status: w.status }));
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

/** Saves what this session changed into the project's context. "failed" (the keeper reports it) when it should have saved and didn't. */
export function saveProjectContext(home: string, slug: string, sessionId: string, s: Session, waitMs?: number): CommitOutcome {
  return commitChanges(home, slug, snapshotContext(s, sessionId), { waitMs });
}

/**
 * Writes the changes in one IMMEDIATE transaction. A row is written only when its change is at least as new as the one
 * there, so an item two sessions both changed keeps the later change whichever saves last. A lock held past `waitMs`,
 * or anything that doesn't fit, is a failed save with nothing written; a database that isn't one is moved aside.
 */
export function commitChanges(home: string, slug: string, ch: ContextChanges, opts: { waitMs?: number } = {}): CommitOutcome {
  const valid = changesSchema.safeParse(ch);
  if (!valid.success) {
    console.error("project context: a change doesn't fit the file's limits; nothing written:", valid.error.issues[0]?.path.join("."));
    return "failed";
  }
  const legacy = existsSync(contextFile(home, slug)) ? null : legacyChanges(home, slug);
  if (!ch.facts.length && !ch.workstreams.length && !ch.brief && !ch.people.length && !legacy) return "skipped";
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: Database | null = null;
    try {
      db = open(home, slug, opts.waitMs ?? 2000);
      const d = db;
      d.transaction(() => {
        // An earlier build's context.json comes in first, once, as the oldest changes.
        if (legacy && !d.query("SELECT 1 FROM meta WHERE key = 'legacy'").get()) {
          apply(d, legacy);
          d.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES ('legacy', '1', 0, ?)").run(legacy.session);
        }
        apply(d, ch);
        // The export is written under the same lock, so it is never older than a write that finished before it.
        exportJson(contextExport(home, slug), readAll(d));
      }).immediate();
      return "written";
    } catch (e) {
      db?.close();
      db = null;
      if (attempt === 0 && /SQLITE_(NOTADB|CORRUPT)/.test(String((e as { code?: string }).code ?? ""))) {
        const file = contextFile(home, slug);
        const at = Date.now();
        for (const ext of ["", "-wal", "-shm"]) if (existsSync(file + ext)) renameSync(file + ext, `${file}.unreadable-${at}${ext}`);
        continue;
      }
      console.error("project context:", e instanceof Error ? e.message : e);
      return "failed";
    } finally {
      db?.close();
    }
  }
  return "failed";
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

function apply(db: Database, ch: ContextChanges) {
  const cur = db.query("SELECT changed_at FROM items WHERE id = ?");
  const put = db.query("INSERT OR REPLACE INTO items (id, type, status, data, changed_at, session) VALUES (?, ?, ?, ?, ?, ?)");
  const newer = (id: string, at: number) => {
    const row = cur.get(id) as { changed_at: number } | null;
    return { known: !!row, newer: !row || row.changed_at <= at };
  };
  const activeFacts = () => (db.query("SELECT id, data, changed_at FROM items WHERE type = 'fact' AND status = 'active'").all() as { id: string; data: string; changed_at: number }[]).map((r) => ({ ...r, f: JSON.parse(r.data) }));
  for (const f of ch.facts) {
    const n = newer(f.id, f.changedAt);
    if (!n.newer) continue;
    const data = JSON.stringify({ kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: f.ts });
    put.run(f.id, "fact", f.status, data, f.changedAt, ch.session);
    // Retiring a fact the file knows by another id (the same words saved twice, or carried in before items had ids) retires those too.
    if (!n.known && f.status !== "active") {
      for (const r of activeFacts()) if (r.f.kind === f.kind && norm(r.f.text) === norm(f.text) && norm(r.f.workstream) === norm(f.workstream) && r.changed_at <= f.changedAt) db.query("UPDATE items SET status = ?, changed_at = ?, session = ? WHERE id = ?").run(f.status, f.changedAt, ch.session, r.id);
    }
  }
  for (const w of ch.workstreams) {
    if (!newer(w.id, w.changedAt).newer) continue;
    put.run(w.id, "workstream", w.status, JSON.stringify({ title: w.title, brief: w.brief }), w.changedAt, ch.session);
  }
  const meta = db.query("INSERT OR REPLACE INTO meta (key, value, changed_at, session) VALUES (?, ?, ?, ?)");
  if (ch.brief) {
    const row = db.query("SELECT changed_at FROM meta WHERE key = 'brief'").get() as { changed_at: number } | null;
    if (!row || row.changed_at <= ch.brief.changedAt) meta.run("brief", JSON.stringify({ brief: ch.brief.brief, goal: ch.brief.goal, glossary: ch.brief.glossary }), ch.brief.changedAt, ch.session);
  }
  const now = Date.now();
  for (const p of ch.people) meta.run(`person:${p.name}`, p.role, now, ch.session);
}

/** The plain-JSON copy, replaced whole (written beside it, then renamed over it). */
function exportJson(file: string, ctx: ProjectContext) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, JSON.stringify(ctx, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * A new session starts from the project's context: facts and workstreams come in marked `carriedFrom` with their
 * project id, the brief is kept for the briefing until the brain writes a new one, and people without a title get the
 * one they had. Done once per session; a session that is resumed, or that already has facts or workstreams of its own,
 * is left alone. Returns how many items came in.
 */
export function seedFromProject(home: string, slug: string, sessionId: string, s: Session): number {
  if (s.store.setting("carried", null)) return 0;
  if (s.store.all("facts").some((f) => !f.carriedFrom) || s.store.all("workstreams").some((w) => !w.carriedFrom)) return 0;
  const ctx = readProjectContext(home, slug);
  if (!ctx) return 0;
  const now = Date.now();
  let n = 0;
  const haveFact = new Set(s.store.all("facts").map((f) => norm(f.text)));
  for (const f of ctx.facts) {
    if (f.session === sessionId || haveFact.has(norm(f.text))) continue;
    haveFact.add(norm(f.text));
    s.store.put("facts", { id: newId("fact"), ts: f.ts || now, updatedAt: now, kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, status: "active", note: f.note, sourceEventIds: [], carriedFrom: { sessionId: f.session, at: now, id: f.id } }, false);
    n++;
  }
  const haveWs = new Set(s.store.all("workstreams").map((w) => w.title.toLowerCase()));
  for (const w of ctx.workstreams) {
    if (w.session === sessionId || haveWs.has(w.title.toLowerCase())) continue;
    haveWs.add(w.title.toLowerCase());
    s.store.put("workstreams", { id: newId("w"), title: w.title, ownerAgentId: null, status: w.status === "paused" ? "paused" : "active", brief: w.brief, updatedAt: now, carriedFrom: { sessionId: w.session, at: now, id: w.id } }, false);
    n++;
  }
  for (const p of ctx.people) {
    const person = s.personByName(p.name);
    if (person && !person.role && p.role) s.store.put("people", { ...person, role: p.role }, false);
  }
  s.store.setSetting("carried", { fromSession: ctx.fromSession, at: now, brief: ctx.brief, goal: ctx.goal, glossary: ctx.glossary, items: n });
  return n;
}
