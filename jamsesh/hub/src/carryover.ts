// Context that carries over (SPEC 12.7). A project keeps one plain JSON file, projects/<slug>/context.json,
// with what its latest session settled: facts, workstreams, the brief and people's roles. It is
// written while a session runs and when it ends (ProjectKeeper), and a new session of the project
// is seeded from it, each carried item marked with the session it came from. Phase 7's wiki ingests
// this same file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** This session retired what it was carried: settled-on-nothing is then what it settled, and the file says so. */
const retiredCarried = (s: Session) => [...s.store.all("facts"), ...s.store.all("workstreams")].some((x) => x.carriedFrom && changedHere(x) && x.status !== "active" && x.status !== "paused");

/** What this session has settled right now: its accepted facts (a proposal on the Tasks board is not one yet), live workstreams, brief and people's titles. */
export function snapshotContext(s: Session, sessionId: string): ProjectContext {
  const now = Date.now();
  const facts = s.store
    .all("facts")
    .filter((f) => f.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FACTS)
    .map((f) => ({ kind: f.kind, text: f.text, workstream: f.workstream, by: f.by, note: f.note, ts: f.ts, session: f.carriedFrom?.sessionId ?? sessionId }));
  const workstreams = s.store
    .all("workstreams")
    .filter((w) => w.status !== "done")
    .slice(0, MAX_WORKSTREAMS)
    .map((w) => ({ title: w.title, brief: w.brief, status: w.status, session: w.carriedFrom?.sessionId ?? sessionId }));
  const carried = s.store.setting<{ brief?: string } | null>("carried", null);
  return {
    goal: goalOf(s),
    glossary: glossaryOf(s),
    version: 1,
    updatedAt: now,
    activeAt: lastActive(s),
    fromSession: sessionId,
    brief: hasBrief(s) ? buildBrief(s).full : carried?.brief || "",
    facts,
    workstreams,
    people: s.people().filter((p) => p.role).map((p) => ({ name: p.name, role: p.role })),
  };
}

/**
 * Writes the project's context file. A session that has settled nothing never empties a file that has something,
 * and a session that was last active before the one that wrote the file never overwrites it (an older session
 * left open doesn't undo a newer one). Returns whether it wrote. A file that can't be read is kept beside it.
 */
export function writeProjectContext(home: string, slug: string, sessionId: string, s: Session): boolean {
  const ctx = snapshotContext(s, sessionId);
  const empty = !ctx.facts.length && !ctx.workstreams.length && !ctx.brief && !ctx.goal;
  const file = contextFile(home, slug);
  if (existsSync(file)) {
    // An empty session never empties the file, unless it retired what it carried in: then nothing settled is the news.
    if (empty && !retiredCarried(s)) return false;
    const cur = readProjectContext(home, slug);
    if (cur && cur.fromSession !== sessionId && cur.activeAt > ctx.activeAt) return false;
    if (!cur) renameSync(file, `${file}.unreadable-${Date.now()}`);
  }
  mkdirSync(join(projectsDir(home), slug), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ctx, null, 2));
  renameSync(tmp, file);
  return true;
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
