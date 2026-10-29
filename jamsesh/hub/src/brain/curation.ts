// Curation (4.3): turns what the room said into durable knowledge, not a changelog. It is split in two so a
// caller can sit between them: `decideCuration` asks the model what should change (no side effects), and
// `applyCuration` hands them to a hold (the Tasks board): only a cited restatement joins a saved fact at once.
import { generateText, Output } from "ai";
import { z } from "zod";
import type { Session } from "../session";
import { newId } from "../store";
import type { Fact, JamEvent } from "../types";
import { restates, sameScope, similar } from "../similarity";
import { model } from "./llm";

const kinds = ["decision", "requirement", "constraint", "preference", "question", "fact"] as const;
const why = z.object({ id: z.string(), reason: z.string(), eventIds: z.array(z.number()).optional() });

export const curateSchema = z.object({
  add: z.array(
    z.object({
      kind: z.enum(kinds),
      text: z.string().describe("One self-contained sentence an engineer can act on, with specifics (names, values, screens)"),
      workstream: z.string().optional().describe("The existing workstream title this is about, or empty for session-wide"),
      by: z.string().optional().describe("Who said or decided it"),
      eventIds: z.array(z.number()).min(1).describe("The ids of the new events that say it"),
    }),
  ),
  update: z
    .array(z.object({ id: z.string(), text: z.string(), reason: z.string(), eventIds: z.array(z.number()).optional() }))
    .describe("An existing item that still holds but has new detail or scope: rewrite it whole. Use this instead of adding a restatement."),
  resolve: z.array(why).describe("Questions answered or requirements met"),
  supersede: z.array(why).describe("Items a newer decision or requirement replaced (for example the room switched from masonry to an even grid)"),
});

export type Curation = z.infer<typeof curateSchema>;

/** What `applyCuration` did, for a caller that reports or reviews it. */
export interface CurationResult {
  added: Fact[];
  merged: { fact: Fact; into: string }[];
  dropped: { text: string; why: string }[];
}

/**
 * Where curation's changes go when a person has to approve them first (the Tasks board, 4.1). Only a restatement
 * applies directly: the same fact said again, cited from these events, joins the saved one. Anything that changes
 * what a saved fact says becomes a card.
 */
export interface CurationHold {
  /** A new fact; `replaces` names the saved fact it supersedes (a rewrite, or a new decision that retires one). */
  add(fact: Fact, replaces?: string): void;
  /** A saved fact the curator would retire with nothing in its place. */
  retire(fact: Fact, status: "superseded" | "resolved", reason: string, sources: number[]): void;
}

export const CURATE_SYSTEM = `You curate the shared knowledge of a live design-and-build session. Every agent reads this list at the start of each leg of work, so it must read as current knowledge, never as a log of what was said.

Record only what will still matter later, as one of:
- decision: a direction the team chose ("Settings header uses option A"), with who decided.
- requirement: something the result must do or include.
- constraint: a limit (deadline, platform rule, "don't touch the API").
- preference: how someone likes things.
- question: an open question nobody answered yet.
- fact: useful project knowledge (token values, URLs of dev servers, where code lives).

Rules, in order:
1. One topic is one item. Before adding anything, look for the same topic in "Current knowledge". If it is there, UPDATE it (rewrite it whole with the new detail) or leave it alone. A restatement, a repeated instruction, a re-ask, or a later refinement of the same spec is never a new item, however often it is said or however it is worded.
2. When a decision or requirement replaces an earlier one, SUPERSEDE the earlier one in the same answer (give its id). Resolve questions that a later line or a decision answered. Never leave two active items that contradict each other.
3. These are not knowledge and are never recorded: what an agent shipped, committed, merged or pushed (commit ids, branch names, "implemented X"); instructions typed to an agent to do a piece of work; progress reports; banter. A ship note can confirm a decision: then update the decision and don't record the note.
4. Problems with JamSesh itself are not project knowledge and are never recorded: the microphone, transcription, wrong speaker names, the TV flickering, the app failing to connect, prompts leaking into the transcript.
5. Every item you add or change cites eventIds from the new events that say it.
6. Set workstream from what the item is about, using an existing workstream title, not from who said it. Leave it empty only for session-wide items.
Be sparse: most batches add zero to two items, and often only update.`;

/** A shipped change or commit note: history, not knowledge. */
const SHIP_NOTE = /\bcommit\s+[0-9a-f]{7,}\b|\bbranch\s+[\w.-]+\/[\w./-]+|\b(?:merged|pushed|shipped)\b.*\b[0-9a-f]{9,}\b/i;
/** JamSesh's own trouble, a backstop for the rule above. */
const TOOL_TROUBLE = /\b(?:tv|screen)\b.{0,20}\bflicker|\bflicker(?:ing)?\b.{0,20}\b(?:tv|screen)\b|\bcollab\.join\b|\bmicrophone\b|\bmic (?:cut|keeps|is picking|dropped)|\btranscript(?:ion)? (?:is |was |keeps |has )?(?:garbage|wrong|bad|rough)|\bprompts? (?:keep|keeps|are|is) leaking|\blabeled "?someone"?/i;

/** Asks the model what should change. Nothing is written. Null when there is no model or nothing came back. */
export async function decideCuration(s: Session, events: JamEvent[]): Promise<Curation | null> {
  const m = model(s, "digest");
  if (!m || !events.length) return null;
  const active = s.facts().filter((f) => f.status === "active");
  const workstreams = s.store.all("workstreams").map((w) => w.title);
  const { output } = await generateText({
    abortSignal: AbortSignal.timeout(45_000),
    model: m,
    output: Output.object({ schema: curateSchema }),
    system: CURATE_SYSTEM,
    prompt: [
      `People: ${s.people().map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ") || "(none)"}`,
      `Workstreams: ${workstreams.join(", ") || "(none)"}`,
      `Current knowledge (id: kind, workstream, text):\n${active.map((f) => `${f.id}: ${f.kind}, ${f.workstream || "session-wide"}, ${f.text}`).join("\n") || "(empty)"}`,
      `New events (id, kind, author, text):\n${events.map((e) => `[${e.id}] ${e.kind}${e.relevance ? `/${e.relevance}` : ""} ${e.authorName}: ${e.text.slice(0, 500)}`).join("\n")}`,
    ].join("\n\n"),
  });
  return output ?? null;
}

/** Passes the changes on. Every fact keeps the events it came from; an item with none is not saved. */
export function applyCuration(s: Session, c: Curation, events: JamEvent[], hold: CurationHold): CurationResult {
  const result: CurationResult = { added: [], merged: [], dropped: [] };
  const now = Date.now();
  const inBatch = new Set(events.map((e) => e.id));
  const cite = (ids?: number[]) => (ids ?? []).filter((id) => inBatch.has(id));
  const union = (a: number[], b: number[]) => [...new Set([...a, ...b])].slice(-12);
  const streamTitles = s.store.all("workstreams").map((w) => w.title);
  const streamOf = (w?: string) => streamTitles.find((t) => t.toLowerCase() === (w ?? "").trim().toLowerCase()) ?? "";

  for (const u of c.update) {
    const f = s.store.get("facts", u.id);
    if (!f || f.status !== "active") continue;
    const sources = cite(u.eventIds);
    // A rewrite of something a person accepted is theirs to approve, and has to say which new events it comes from.
    if (!sources.length) {
      result.dropped.push({ text: u.text, why: "no source event" });
      continue;
    }
    // Only the same words again merge; a rewrite that adds detail or scope is a change to approve.
    if (restates(f.text, u.text, 0.8) && similar(f.text, u.text, true) > 0.8) {
      const merged = { ...f, sourceEventIds: union(f.sourceEventIds, sources), updatedAt: now };
      s.store.put("facts", merged);
      result.merged.push({ fact: merged, into: f.id });
      continue;
    }
    hold.add({ ...f, id: newId("fact"), ts: now, updatedAt: now, text: u.text, by: "", note: u.reason, sourceEventIds: sources }, f.id);
  }
  const retiring: { f: Fact; status: "superseded" | "resolved"; reason: string; sources: number[] }[] = [];
  for (const r of c.resolve) {
    const f = s.store.get("facts", r.id);
    // Retiring something a person accepted has to show what in the room supports it.
    if (f && f.status === "active" && !cite(r.eventIds).length) result.dropped.push({ text: r.reason, why: "no source event" });
    else if (f && f.status === "active") retiring.push({ f, status: "resolved", reason: r.reason, sources: cite(r.eventIds) });
  }
  for (const r of c.supersede) {
    const f = s.store.get("facts", r.id);
    // Retiring something a person accepted has to show what in the room supports it.
    if (f && f.status === "active" && !cite(r.eventIds).length) result.dropped.push({ text: r.reason, why: "no source event" });
    else if (f && f.status === "active") retiring.push({ f, status: "superseded", reason: r.reason, sources: cite(r.eventIds) });
  }
  for (const a of c.add) {
    if (SHIP_NOTE.test(a.text)) {
      result.dropped.push({ text: a.text, why: "a shipped or commit note" });
      continue;
    }
    if (TOOL_TROUBLE.test(a.text)) {
      result.dropped.push({ text: a.text, why: "a problem with JamSesh itself" });
      continue;
    }
    const sources = cite(a.eventIds);
    if (!sources.length) {
      result.dropped.push({ text: a.text, why: "no source event" });
      continue;
    }
    // Paraphrases of what's already known are duplicates, not new knowledge. Items that differ in their
    // specifics (option A versus B, 16 versus 24 px) never are. The event is added to the fact's sources.
    // Scope counts: the same words for another workstream or platform are another fact.
    const same = s.facts().find((f) => f.status === "active" && f.kind === a.kind && f.workstream.toLowerCase() === streamOf(a.workstream).toLowerCase() && restates(f.text, a.text, 0.55));
    if (same) {
      const merged = { ...same, sourceEventIds: union(same.sourceEventIds, sources), updatedAt: now };
      s.store.put("facts", merged);
      result.merged.push({ fact: merged, into: same.id });
      continue;
    }
    const fact: Fact = { id: newId("fact"), ts: now, updatedAt: now, kind: a.kind, text: a.text, workstream: streamOf(a.workstream), by: a.by ?? "", status: "active", note: "", sourceEventIds: sources };
    // The addition that most resembles a fact this answer retires (of its own kind, workstream and platform) is what replaces it.
    const old = retiring.filter((r) => r.status === "superseded" && r.f.kind === a.kind && r.f.workstream.toLowerCase() === fact.workstream.toLowerCase() && sameScope(r.f.text, a.text)).map((r) => ({ r, score: similar(r.f.text, a.text) })).sort((x, y) => y.score - x.score)[0];
    const pair = old && old.score >= 0.3 ? old.r : undefined;
    if (pair) retiring.splice(retiring.indexOf(pair), 1);
    hold.add(fact, pair?.f.id);
  }
  for (const r of retiring) hold.retire(r.f, r.status, r.reason, r.sources);
  return result;
}
