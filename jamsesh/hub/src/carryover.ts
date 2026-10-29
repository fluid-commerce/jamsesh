// Context that carries over (SPEC 12.7). A project keeps one plain JSON file, projects/<slug>/context.json,
// with what its latest session settled: facts, workstreams, the brief and people's roles. It is
// written while a session runs and when it ends (ProjectKeeper), and a new session of the project
// is seeded from it, each carried item marked with the session it came from. Phase 7's wiki ingests
// this same file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "./projects";
import type { Session } from "./session";
import { newId } from "./store";
import type { Fact, Workstream } from "./types";

export interface ProjectContext {
  version: 1;
  updatedAt: number;
  /** The session that wrote the file. */
  fromSession: string;
  /** The session brief as the brain last wrote it (goal, owners, repositories, terms). */
  brief: string;
  facts: { kind: Fact["kind"]; text: string; workstream: string; by: string; note: string; ts: number; /** The session that first settled it. */ session: string }[];
  workstreams: { title: string; brief: string; status: Workstream["status"]; session: string }[];
  people: { name: string; role: string }[];
}

const MAX_FACTS = 300;
const MAX_WORKSTREAMS = 40;

export const contextFile = (home: string, slug: string) => join(projectsDir(home), slug, "context.json");

export function readProjectContext(home: string, slug: string): ProjectContext | null {
  try {
    const c = JSON.parse(readFileSync(contextFile(home, slug), "utf8")) as Partial<ProjectContext>;
    if (c?.version !== 1 || typeof c.fromSession !== "string") return null;
    return {
      version: 1,
      updatedAt: Number(c.updatedAt) || 0,
      fromSession: c.fromSession,
      brief: typeof c.brief === "string" ? c.brief : "",
      facts: Array.isArray(c.facts) ? c.facts.filter((f) => f && typeof f.text === "string") : [],
      workstreams: Array.isArray(c.workstreams) ? c.workstreams.filter((w) => w && typeof w.title === "string") : [],
      people: Array.isArray(c.people) ? c.people.filter((p) => p && typeof p.name === "string") : [],
    };
  } catch {
    return null;
  }
}

/** What this session has settled right now: its active facts, live workstreams, brief and people's titles. */
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
    version: 1,
    updatedAt: now,
    fromSession: sessionId,
    brief: s.store.digest("session")?.text.trim() || carried?.brief || "",
    facts,
    workstreams,
    people: s.people().filter((p) => p.role).map((p) => ({ name: p.name, role: p.role })),
  };
}

/** Writes the project's context file. A session that has settled nothing never empties a file that has something. */
export function writeProjectContext(home: string, slug: string, sessionId: string, s: Session) {
  const ctx = snapshotContext(s, sessionId);
  const empty = !ctx.facts.length && !ctx.workstreams.length && !ctx.brief;
  const file = contextFile(home, slug);
  if (empty && existsSync(file)) return;
  mkdirSync(join(projectsDir(home), slug), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ctx, null, 2));
  renameSync(tmp, file);
}

/**
 * A new session starts from the project's context file: facts and workstreams come in marked
 * `carriedFrom`, the brief is kept for the briefing until the brain writes a new one, and people
 * without a title get the one they had. Done once per session; a session that is resumed, or that
 * already has its own context, is left alone. Returns how many items came in.
 */
export function seedFromProject(home: string, slug: string, sessionId: string, s: Session): number {
  if (s.store.setting("carried", null)) return 0;
  const ctx = readProjectContext(home, slug);
  if (!ctx || ctx.fromSession === sessionId) return 0;
  const now = Date.now();
  let n = 0;
  const haveFact = new Set(s.store.all("facts").map((f) => f.text.trim().toLowerCase()));
  for (const f of ctx.facts) {
    if (haveFact.has(f.text.trim().toLowerCase())) continue;
    s.store.put("facts", { id: newId("fact"), ts: f.ts || now, updatedAt: now, kind: f.kind, text: f.text, workstream: f.workstream ?? "", by: f.by ?? "", status: "active", note: f.note ?? "", sourceEventIds: [], carriedFrom: { sessionId: f.session || ctx.fromSession, at: now } }, false);
    n++;
  }
  const haveWs = new Set(s.store.all("workstreams").map((w) => w.title.toLowerCase()));
  for (const w of ctx.workstreams) {
    if (haveWs.has(w.title.toLowerCase())) continue;
    s.store.put("workstreams", { id: newId("w"), title: w.title, ownerAgentId: null, status: w.status === "paused" ? "paused" : "active", brief: w.brief ?? "", updatedAt: now, carriedFrom: { sessionId: w.session || ctx.fromSession, at: now } }, false);
    n++;
  }
  for (const p of ctx.people) {
    const person = s.personByName(p.name);
    if (person && !person.role && p.role) s.store.put("people", { ...person, role: p.role }, false);
  }
  s.store.setSetting("carried", { fromSession: ctx.fromSession, at: now, brief: ctx.brief, items: n });
  return n;
}
