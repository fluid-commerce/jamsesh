// Work affinity: which agent already has the context for a request. Agents do better
// work when similar requests keep going to the one that handled the last ones, so the
// router sees each agent's history and a score, and a request is never split between
// two agents working in the same repository.
import type { Session } from "../session";
import type { Agent, Directive } from "../types";

const STOP = new Set(
  "a an the and or but to of in on for with at by from it its this that these those is are be can could should would let lets let's we us our you your i me my please make try build do just some few couple one two three page screen app also like want need into more less new same as so then than".split(" "),
);

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/(ings|ing|es|s)$/, (m) => (w.length > 5 ? "" : m)))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export interface AgentHistory {
  agent: Agent;
  workstreams: string[];
  recent: string[];
  text: string;
}

/** What each agent has worked on: workstreams, directives, updates, and its frames. */
export function histories(session: Session): AgentHistory[] {
  const events = session.store.recentEvents({ kinds: ["update", "artifact", "decision"], limit: 400 });
  const directives = session.directives();
  return session
    .agents()
    .filter((a) => a.status !== "offline")
    .map((agent) => {
      const workstreams = session.store.all("workstreams").filter((w) => w.ownerAgentId === agent.id).map((w) => w.title);
      const did = directives.filter((d) => d.targets.includes(agent.id) && (d.progress?.[agent.id] ?? d.status) !== "pending");
      const posted = events.filter((e) => e.authorId === agent.id).map((e) => e.text);
      const frames = session.artifacts().filter((x) => x.agentId === agent.id).map((x) => x.title);
      const recent = [...did.slice(0, 6).map((d) => d.text.slice(0, 120)), ...posted.slice(-4).map((t) => t.slice(0, 120))];
      return { agent, workstreams, recent, text: [agent.focus, ...workstreams, ...did.map((d) => d.text), ...posted, ...frames].join(" ") };
    });
}

/**
 * How well a request matches each agent's history, 0 to 1: shared terms, weighted
 * toward workstream titles. Ties go to the agent that worked on it most recently.
 */
export function affinity(session: Session, request: string): { agent: Agent; score: number; why: string }[] {
  const want = new Set(terms(request));
  if (!want.size) return [];
  return histories(session)
    .map((h) => {
      const have = new Set(terms(h.text));
      const ws = new Set(terms(h.workstreams.join(" ")));
      const shared = [...want].filter((t) => have.has(t));
      const inWs = shared.filter((t) => ws.has(t));
      const score = Math.min(1, (shared.length + inWs.length) / Math.max(3, want.size));
      return { agent: h.agent, score, why: shared.slice(0, 6).join(", ") };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.agent.lastSeen - a.agent.lastSeen);
}

/**
 * One request goes to one agent per repository. When the router targets several agents
 * that share a repository, keep the one with the most related history.
 */
export function oneAgentPerRepo(session: Session, targets: string[], request: string): { kept: string[]; dropped: Agent[] } {
  const ranked = new Map(affinity(session, request).map((r) => [r.agent.id, r.score]));
  const byRepo = new Map<string, Agent[]>();
  for (const id of targets) {
    const a = session.agent(id);
    if (!a) continue;
    const key = repoKey(a.repo);
    byRepo.set(key, [...(byRepo.get(key) ?? []), a]);
  }
  const kept: string[] = [];
  const dropped: Agent[] = [];
  for (const group of byRepo.values()) {
    group.sort((x, y) => (ranked.get(y.id) ?? 0) - (ranked.get(x.id) ?? 0) || busyness(session, x.id) - busyness(session, y.id));
    kept.push(group[0].id);
    dropped.push(...group.slice(1));
  }
  return { kept, dropped };
}

function busyness(session: Session, agentId: string) {
  return session.openFor(agentId).length;
}

export function repoKey(repo: string) {
  return repo.toLowerCase().replace(/\.git$/, "").replace(/^.*[/:]([^/:]+\/[^/:]+)$/, "$1");
}

/** The router's view of who has done what, plus the best matches for the lines at hand. */
export function historyBrief(session: Session, request: string): string {
  const hs = histories(session);
  if (!hs.length) return "";
  const lines = hs.map(
    (h) =>
      `- ${h.agent.name} (${h.agent.id}, ${repoKey(h.agent.repo)}): ${h.workstreams.length ? `owns ${h.workstreams.join("; ")}` : "no workstream yet"}${h.recent.length ? `; recently: ${h.recent.slice(0, 4).join(" | ")}` : ""}; ${session.openFor(h.agent.id).length} unfinished directive(s)`,
  );
  const best = request.trim() ? affinity(session, request).slice(0, 3) : [];
  return `## Agent work history\n${lines.join("\n")}${best.length ? `\nBest matches for these lines by history: ${best.map((b) => `${b.agent.name} ${Math.round(b.score * 100)}% (${b.why})`).join("; ")}` : ""}`;
}

export type { Directive };
