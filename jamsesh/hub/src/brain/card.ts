// The project card (4.2): what the room is making, in a few hundred words, so the triage judges a line by
// whether it's about the project, not by how casual it sounds. Read off state the hub already keeps.
import { glossaryOf, goalOf } from "../brief";
import type { Session } from "../session";
import type { JamEvent } from "../types";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstSentence = (s: string) => (s.trim().split(/(?<=[.!?])\s/)[0] ?? "").trim();

/** Every screen's stage, with the items on it: [{ id, title, by, since }] newest first. */
export function onScreens(s: Session) {
  const ids = ["main", ...Object.keys(s.store.setting<Record<string, unknown>>("screenStages", {}))];
  const out: { screen: string; mode: string; title: string; by: string; since: number; items: { id: string; title: string }[] }[] = [];
  for (const screen of ids) {
    const st = s.stage(screen);
    const items = st.items.map((id) => s.store.get("artifacts", id)).filter((a) => !!a).map((a) => ({ id: a!.id, title: a!.title }));
    out.push({ screen, mode: st.mode, title: st.title, by: st.by, since: st.since, items });
  }
  return out;
}

export function projectCard(s: Session): string {
  const goal = goalOf(s) || `Session "${s.settings().sessionName}"`;
  const streams = s.store.all("workstreams").filter((w) => w.status === "active");
  const decisions = s.facts().filter((f) => f.status === "active" && f.kind === "decision").slice(0, 6);
  const terms = glossaryOf(s);
  const screens = onScreens(s).filter((x) => x.items.length || !["board", "welcome", "join"].includes(x.mode));
  const now = Date.now();
  return [
    `Goal: ${clip(goal, 240)}`,
    streams.length ? `Workstreams:\n${streams.slice(0, 10).map((w) => `- ${w.title}${s.agent(w.ownerAgentId)?.ownerName ? ` (${s.agent(w.ownerAgentId)!.ownerName})` : ""}${w.brief ? `: ${clip(firstSentence(w.brief), 100)}` : ""}`).join("\n")}` : "",
    decisions.length ? `Decisions so far:\n${decisions.map((f) => `- ${clip(f.text, 140)}`).join("\n")}` : "",
    terms.length ? `Key terms: ${terms.slice(0, 12).map((g) => `${g.term} (${clip(g.meaning, 50)})`).join("; ")}` : "",
    screens.length
      ? `On the screens right now (id, title, who put it up, how long ago):\n${screens
          .map((x) => `- ${x.screen}: ${x.items.length ? x.items.map((i) => `[${i.id}] ${i.title}`).join(", ") : `${x.mode}${x.title ? ` "${x.title}"` : ""}`}, put up by ${x.by || "JamSesh"}, ${Math.max(0, Math.round((now - x.since) / 60_000))} min ago`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Words that mean something in this project: its terms, workstream and screen names. A line using one isn't off-topic. */
export function vocabulary(s: Session): Set<string> {
  const text = [...glossaryOf(s).map((g) => g.term), ...s.store.all("workstreams").map((w) => w.title), ...s.artifacts().slice(0, 40).flatMap((a) => [a.group, a.title]), s.settings().sessionName].join(" ");
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) out.add(w);
  return out;
}

/** Banter the triage was sure about is left out of the brief and the agents' context; a doubtful one stays, labeled. */
export function confidentBanter(e: JamEvent) {
  return e.relevance === "banter" && Number(e.data?.confidence ?? 1) >= 0.8;
}
