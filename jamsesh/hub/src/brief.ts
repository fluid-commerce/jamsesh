// The session brief (4.4): fixed sections filled from state the hub already has (who owns what, repositories
// and branches, live builds, what's in progress), the decisions and open questions people accepted (facts), and
// the parts the digest model writes (goal, glossary). Built on demand, so a new dev server shows up without a
// model pass. Nothing here comes from talk nobody accepted: agents read this as settled.
import type { Session } from "./session";

export interface BriefParts {
  goal: string;
  glossary: { term: string; meaning: string }[];
}

/** The excerpt `jam_join` carries. */
export const BRIEF_EXCERPT = 600;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstSentence = (s: string) => (s.trim().split(/(?<=[.!?])\s/)[0] ?? "").trim();
const shortRepo = (r: string) => r.replace(/^.*[:/]([^/:]+\/[^/:]+?)(\.git)?$/, "$1") || r;

/** What the digest model last wrote, or null before the first pass (or when the stored text is the older plain brief). */
export function briefParts(s: Session): BriefParts | null {
  const raw = s.store.digest("brief-parts")?.text;
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return {
      goal: typeof p.goal === "string" ? p.goal : "",
      glossary: Array.isArray(p.glossary) ? p.glossary.filter((g: any) => g && typeof g.term === "string" && typeof g.meaning === "string") : [],
    };
  } catch {
    return null;
  }
}

/** A line of an older plain-text brief ("GOAL: …") for sessions saved before the sections existed. */
function oldLine(s: Session, label: string) {
  const m = s.store.digest("session")?.text.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
  return m?.[1]?.trim() ?? "";
}

/** What an earlier session of the project handed on (SPEC 12.7), until this session's brief has its own. */
const carriedParts = (s: Session) => s.store.setting<{ goal?: string; glossary?: { term: string; meaning: string }[] } | null>("carried", null);

export function goalOf(s: Session): string {
  return briefParts(s)?.goal?.trim() || oldLine(s, "GOAL") || carriedParts(s)?.goal?.trim() || "";
}

export function glossaryOf(s: Session): { term: string; meaning: string }[] {
  return briefParts(s)?.glossary ?? carriedParts(s)?.glossary ?? [];
}

/** Whether the brief has anything beyond what the hub can read off its own state. */
export function hasBrief(s: Session) {
  return !!(briefParts(s) || s.store.digest("session"));
}

export function buildBrief(s: Session): { full: string; short: string } {
  const parts = briefParts(s);
  const goal = goalOf(s) || `Session "${s.settings().sessionName}"`;
  const name = (id: string | null) => (id ? s.agent(id)?.name ?? "" : "");
  const streams = s.store.all("workstreams").filter((w) => w.status === "active");
  const workers = s.workers().filter((a) => a.status !== "offline");
  const arts = s.artifacts();
  const open = s.directives().filter((d) => d.status !== "done" && d.status !== "cancelled");

  const owners = streams.map((w) => `${w.title}: ${name(w.ownerAgentId) || "nobody"}${s.agent(w.ownerAgentId)?.ownerName ? ` (${s.agent(w.ownerAgentId)!.ownerName})` : ""}`);
  const repos = [...new Map(workers.filter((a) => a.repo).map((a) => [`${shortRepo(a.repo)}@${a.branch || "?"}`, a.name])).entries()].map(([k, who]) => `${k} (${who})`);
  const live = s.devservers().filter((d) => d.up).map((d) => `${d.name}: ${d.url}${name(d.agentId) ? ` (${name(d.agentId)})` : ""}`);
  const progress = streams.map((w) => {
    const mine = arts.filter((a) => a.workstreamId === w.id && a.kind !== "devserver");
    const built = mine.filter((a) => a.stage === "built").length;
    const mocked = mine.length - built;
    const tasks = open.filter((d) => d.workstreamId === w.id || (w.ownerAgentId && d.targets.includes(w.ownerAgentId)));
    const bits = [mocked ? `${mocked} mocked` : "", built ? `${built} built` : "", tasks.length ? `${tasks.length} open task${tasks.length === 1 ? "" : "s"}: ${clip(tasks[0].text, 70)}` : ""].filter(Boolean);
    return `${w.title}: ${bits.join(", ") || firstSentence(w.brief) || "just started"}`;
  });
  // Decisions and questions are the accepted facts only, never the model's reading of the room.
  const accepted = s.facts().filter((f) => f.status === "active").sort((a, b) => a.ts - b.ts);
  const decisions = accepted.filter((f) => f.kind === "decision").slice(-8).map((f) => `${f.text}${f.by ? ` (${f.by})` : ""}`);
  const questions = accepted.filter((f) => f.kind === "question").slice(-6).map((f) => f.text);
  const glossary = parts?.glossary ?? [];

  const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  const full = [
    `GOAL: ${goal}`,
    list("OWNERS", owners),
    list("REPOS", repos),
    list("LIVE", live),
    list("IN PROGRESS", progress),
    list("DECISIONS", decisions),
    list("OPEN QUESTIONS", questions),
    list("GLOSSARY", glossary.map((g) => `${g.term}: ${g.meaning}`)),
  ]
    .filter(Boolean)
    .join("\n\n");

  // The excerpt: most useful first, whole lines only, never more than the join briefing's budget.
  const inline = (label: string, items: string[], each: number, max: number) => (items.length ? `${label}: ${items.slice(0, max).map((i) => clip(i, each)).join("; ")}` : "");
  const tiers = [
    [`GOAL: ${clip(goal, 160)}`],
    [inline("OWNERS", owners, 40, 4)],
    [inline("LIVE", live, 60, 2)],
    [inline("REPOS", repos, 40, 3)],
    [inline("NOW", progress, 50, 3)],
    [inline("TERMS", glossary.map((g) => g.term), 20, 6)],
  ]
    .flat()
    .filter(Boolean);
  const kept: string[] = [];
  for (const line of tiers) if ([...kept, line].join("\n").length <= BRIEF_EXCERPT) kept.push(line);
  return { full, short: kept.join("\n") || clip(goal, BRIEF_EXCERPT) };
}
