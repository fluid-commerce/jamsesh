// The Tasks board's triage (4.1): what JamSesh overhears, and the context agents report themselves, waits here
// as cards for a person to send, add, edit, merge or dismiss. Things said to JamSesh on purpose skip this.
// Cards never expire; the ones that have waited a while get a label and a spoken mention (brain.ts).
import { restates, samePolarity, sameScope, sameSpecifics, similar } from "./similarity";
import type { Session } from "./session";
import { newId } from "./store";
import type { Directive, DirectiveMode, Fact, JamEvent, TriageCard, TriageSource } from "./types";

const MODES: DirectiveMode[] = ["explore", "implement", "coordinate", "answer", "note"];
const KINDS: Fact["kind"][] = ["decision", "requirement", "constraint", "preference", "question", "fact"];
/** A card waiting this long reads "waiting 40 min" and gets mentioned out loud. */
export const WAITING_MS = 30 * 60_000;
/** A dismissed card's repeats stay quiet this long, so the same chatter doesn't come straight back. */
const DISMISS_QUIET_MS = 30 * 60_000;
const TEXT_MAX = 2000;
const SOURCES_MAX = 12;
/** Resolved cards the state carries (the log of what people did with proposals); older ones stay in the store. */
const RESOLVED_SHOWN = 20;

export { restates, sameCounts, sameSpecifics, similar } from "./similarity";

/** Agents' routine notices (shipped, done, progress) are the changelog, not knowledge: curation skips them. */
export function forCuration(e: JamEvent) {
  if (e.kind !== "update" || e.authorType !== "agent") return true;
  const kind = String(e.data?.updateKind ?? "");
  return kind === "question" || kind === "blocked";
}

export type BoardResult<T = {}> = ({ ok: true; card: TriageCard } & T) | { ok: false; error: string; status: number };

const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });
const clean = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
const sameSet = (a: string[], b: string[]) => a.slice().sort().join() === b.slice().sort().join();
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface TaskProposal {
  text: string;
  mode: DirectiveMode;
  targets: string[];
  workstream?: string;
  by: string;
  origin?: TriageCard["origin"];
  sourceEventIds?: number[];
  /** What it came from when there's no transcript line (a document someone attached). */
  note?: string;
}

export interface ContextProposal {
  text: string;
  kind?: Fact["kind"];
  attachments?: TriageCard["attachments"];
  workstream?: string;
  by: string;
  origin?: TriageCard["origin"];
  sourceEventIds?: number[];
  /** A saved fact this one replaces, when the brain knows which; otherwise a close fact that differs is found. */
  replaces?: string;
  note?: string;
  /** The wording is only a placeholder (a file with no text to read): a person writes the fact before adding it. */
  needsWording?: boolean;
}

export interface CardEdit {
  text?: unknown;
  mode?: unknown;
  targets?: unknown;
  workstream?: unknown;
  kind?: unknown;
}

export class Board {
  constructor(private s: Session) {}

  private lastStamp = 0;
  /** Strictly increasing, so two cards made in the same millisecond still have an order ("the second one"). */
  private stamp() {
    return (this.lastStamp = Math.max(Date.now(), this.lastStamp + 1));
  }

  all(): TriageCard[] {
    return this.s.store.all("triage");
  }

  /** Open cards, oldest first: the one that has waited longest leads. */
  open(): TriageCard[] {
    return this.all().filter((c) => c.status === "open").sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }

  /** What the live state carries: every open card, then the last few that were acted on. */
  shown(): TriageCard[] {
    const done = this.all().filter((c) => c.status !== "open").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, RESOLVED_SHOWN);
    return [...this.open(), ...done];
  }

  get(id: string) {
    return this.s.store.get("triage", id);
  }

  /** A card by id, the end of an id, or its place on the board ("2" is the second open card, "last" the newest). */
  find(ref: string): TriageCard | undefined {
    const r = ref.trim();
    const open = this.open();
    if (/^(last|newest|latest)$/i.test(r)) return [...open].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (/^\d{1,3}$/.test(r)) return open[Number(r) - 1];
    return this.all().find((c) => c.id === r) ?? this.all().find((c) => c.id.endsWith(r) && r.length >= 4);
  }

  private source(id: number | null | undefined, fallback: { authorName: string; text: string }): TriageSource {
    const ev = id != null ? this.s.store.event(id) : undefined;
    return { eventId: ev?.id ?? null, authorName: ev?.authorName ?? fallback.authorName, text: (ev?.text ?? fallback.text).slice(0, 400), ts: ev?.ts ?? Date.now() };
  }

  private sourcesOf(ids: number[] | undefined, by: string, text: string, note?: string): TriageSource[] {
    const list = (ids ?? []).slice(0, SOURCES_MAX).map((id) => this.source(id, { authorName: by, text }));
    const real = list.filter((x) => x.eventId != null);
    return real.length ? real : [{ eventId: null, authorName: by, text: (note ?? text).slice(0, 400), ts: Date.now() }];
  }

  /** The same thing said again joins its card (and a dismissed one stays dismissed for a while). */
  private repeat(match: TriageCard, sources: TriageSource[]): TriageCard {
    const fresh = sources.filter((x) => x.eventId == null || !match.sources.some((m) => m.eventId === x.eventId));
    // A line seen twice (the same event) isn't a repeat.
    if (!fresh.length && sources.some((x) => x.eventId != null)) return match;
    const next = { ...match, count: match.count + 1, sources: [...match.sources, ...fresh].slice(-SOURCES_MAX), updatedAt: this.stamp() };
    return this.s.store.put("triage", next);
  }

  /** An open card (or one dismissed a moment ago) that says the same thing for the same purpose: `extra` checks the purpose. */
  private match(type: TriageCard["type"], text: string, extra: (c: TriageCard) => boolean): TriageCard | undefined {
    const now = Date.now();
    return this.all().find((c) => c.type === type && (c.status === "open" || (c.status === "dismissed" && now - (c.resolvedAt ?? 0) < DISMISS_QUIET_MS)) && extra(c) && (restates(c.text, text, 0.7) || restates(c.original, text, 0.7)));
  }

  private validTargets(targets: unknown, mode: DirectiveMode): string[] {
    const list = Array.isArray(targets) ? targets.map(String) : [];
    return [...new Set(list)].filter((id) => {
      const a = this.s.agent(id);
      return !!a && (mode === "answer" || mode === "note" || a.role !== "observer");
    });
  }

  // ---- proposing ----

  proposeTask(p: TaskProposal): TriageCard | null {
    const text = clean(p.text);
    if (!text) return null;
    const mode = MODES.includes(p.mode) ? p.mode : "explore";
    const targets = this.validTargets(p.targets, mode);
    const sources = this.sourcesOf(p.sourceEventIds, p.by, text, p.note);
    const workstream = clean(p.workstream);
    // The same words for other agents, or another workstream, are another task.
    const same = this.match("task", text, (c) => !c.cancels && c.mode === mode && sameSet(c.targets, targets) && sameName(c.workstream, workstream));
    if (same) return this.repeat(same, sources);
    const now = this.stamp();
    const card: TriageCard = {
      id: newId("tri"), ts: now, updatedAt: now, type: "task", status: "open", origin: p.origin ?? "overheard", text, original: text, by: p.by,
      mode, targets, kind: "fact", workstream, conflictsWith: null, sources, count: 1, edits: [], resolvedBy: "", resolvedAt: null, directiveId: null, factId: null, mentionedAt: null,
    };
    return this.announce(this.s.store.put("triage", card));
  }

  proposeContext(p: ContextProposal): TriageCard | null {
    const text = clean(p.text);
    if (!text) return null;
    const kind = p.kind && KINDS.includes(p.kind) ? p.kind : "fact";
    const workstream = clean(p.workstream);
    const active = this.s.store.all("facts").filter((f) => f.status === "active");
    // A named replacement changes that fact however close the wording is, so it is never "already known".
    const named = p.replaces ? active.find((f) => f.id === p.replaces) : undefined;
    // Already known, in other words: nothing for a person to decide. "Not option A" is not "option A" again.
    if (!named && active.some((f) => f.kind === kind && sameName(f.workstream, workstream) && restates(f.text, text, 0.55))) return null;
    const sources = this.sourcesOf(p.sourceEventIds, p.by, text, p.note);
    const same = this.match("context", text, (c) => !c.retire && c.kind === kind && sameName(c.workstream, workstream) && (!named || c.conflictsWith === named.id));
    if (same) return this.repeat(same, sources);
    // A close fact that differs in its specifics (option A versus B, 16 versus 24 px) or says the opposite is the one this would replace.
    // Only a fact of the same kind and workstream: "48px in Mobile" doesn't replace "64px in Desktop".
    const conflict = named ?? active.find((f) => f.kind === kind && sameName(f.workstream, workstream) && sameScope(f.text, text) && similar(f.text, text) > 0.45 && (!sameSpecifics(f.text, text) || !samePolarity(f.text, text)));
    const now = this.stamp();
    const card: TriageCard = {
      id: newId("tri"), ts: now, updatedAt: now, type: "context", status: "open", origin: p.origin ?? "overheard", text, original: text, by: p.by,
      mode: "note", targets: [], kind, workstream, conflictsWith: conflict?.id ?? null, ...(p.attachments?.length ? { attachments: p.attachments } : {}), ...(p.needsWording ? { needsWording: true } : {}), sources, count: 1, edits: [], resolvedBy: "", resolvedAt: null, directiveId: null, factId: null, mentionedAt: null,
    };
    return this.announce(this.s.store.put("triage", card));
  }

  /** The curator would retire a saved fact with nothing worded to take its place: a person decides. */
  proposeRetire(p: { fact: Fact; status: "superseded" | "resolved"; reason: string; by: string; sourceEventIds?: number[] }): TriageCard | null {
    const open = this.all().find((c) => c.status === "open" && c.retire && c.conflictsWith === p.fact.id);
    const sources = this.sourcesOf(p.sourceEventIds, p.by, p.reason);
    // Only with a line from the room behind it: a person sees what supports retiring the fact.
    if (sources.every((x) => x.eventId == null)) return null;
    if (open) return this.repeat(open, sources);
    const text = clean(p.reason) || (p.status === "resolved" ? "Answered or done" : "Replaced by a newer decision");
    const now = this.stamp();
    const card: TriageCard = {
      id: newId("tri"), ts: now, updatedAt: now, type: "context", status: "open", origin: "overheard", text, original: text, by: p.by,
      mode: "note", targets: [], kind: p.fact.kind, workstream: p.fact.workstream, conflictsWith: p.fact.id, retire: p.status, sources, count: 1, edits: [], resolvedBy: "", resolvedAt: null, directiveId: null, factId: null, mentionedAt: null,
    };
    return this.announce(this.s.store.put("triage", card));
  }

  /** A quiet notice that something is waiting: the count is on the Tasks tab, so no sound and no detail. */
  private announce(card: TriageCard) {
    this.s.onTriage?.(card);
    return card;
  }

  /** Something a person asked JamSesh to remember is saved at once: no card. Null when it's already known. */
  rememberNow(p: ContextProposal): Fact | null {
    const text = clean(p.text);
    const kind = p.kind && KINDS.includes(p.kind) ? p.kind : "fact";
    if (!text || this.s.store.all("facts").some((f) => f.status === "active" && f.kind === kind && sameName(f.workstream, clean(p.workstream)) && restates(f.text, text, 0.55))) return null;
    const now = Date.now();
    return this.s.store.put("facts", { id: newId("fact"), ts: now, updatedAt: now, kind, text, workstream: clean(p.workstream), by: p.by, status: "active", note: "", sourceEventIds: p.sourceEventIds ?? [] });
  }

  // ---- acting on a card ----

  /**
   * The card, while it's open. A card the same person already resolved the same way answers with what it made,
   * so a retried click (a lost reply, a double tap) does nothing twice; anyone else is told who got there first.
   */
  private openCard(id: string, again?: { status: TriageCard["status"]; by: string }): TriageCard | { ok: false; error: string; status: number } | { done: TriageCard } {
    const c = this.get(id);
    if (!c) return fail("No such card.", 404);
    if (c.status !== "open" && again && c.status === again.status && c.resolvedBy === again.by) return { done: c };
    if (c.status !== "open") return fail(`That card was already ${c.status === "added" || c.status === "sent" ? c.status : c.status === "merged" ? "merged into a fact" : c.status === "replaced" ? "used to replace a fact" : "dismissed"}${c.resolvedBy ? ` by ${c.resolvedBy}` : ""}.`, 409);
    return c;
  }

  /** Applies a person's changes; returns the changed field names, or an error naming what was wrong. */
  private applyEdit(c: TriageCard, e: CardEdit): { card: TriageCard; fields: string[] } | { error: string } {
    const next = { ...c };
    const fields: string[] = [];
    if (e.text !== undefined) {
      const t = clean(e.text);
      if (!t) return { error: "The wording can't be empty." };
      if (t !== c.text) (next.text = t), fields.push("text");
    }
    // A cancel card goes to the agents of the task it cancels: only its wording (the reason they read) changes.
    if (e.mode !== undefined && c.type === "task" && !c.cancels) {
      if (!MODES.includes(e.mode as DirectiveMode)) return { error: `Mode is one of ${MODES.join(", ")}.` };
      if (e.mode !== c.mode) (next.mode = e.mode as DirectiveMode), fields.push("mode");
    }
    if (e.targets !== undefined && c.type === "task" && !c.cancels) {
      if (!Array.isArray(e.targets)) return { error: "targets is a list of agent ids." };
      const targets = this.validTargets(e.targets, next.mode);
      if (targets.length !== e.targets.length) return { error: "One of those agents isn't in the session, or only watches." };
      if (targets.slice().sort().join() !== c.targets.slice().sort().join()) (next.targets = targets), fields.push("targets");
    }
    if (e.workstream !== undefined) {
      const w = clean(e.workstream);
      if (w !== c.workstream) (next.workstream = w), fields.push("workstream");
    }
    if (e.kind !== undefined && c.type === "context") {
      if (!KINDS.includes(e.kind as Fact["kind"])) return { error: `Kind is one of ${KINDS.join(", ")}.` };
      if (e.kind !== c.kind) (next.kind = e.kind as Fact["kind"]), fields.push("kind");
    }
    return { card: next, fields };
  }

  private edited(c: TriageCard, e: CardEdit, by: string): BoardResult<{ fields: string[] }> {
    const r = this.applyEdit(c, e);
    if ("error" in r) return fail(r.error);
    const card = r.fields.length ? { ...r.card, edits: [...c.edits, { by, at: Date.now(), fields: r.fields }].slice(-20), updatedAt: Date.now() } : r.card;
    return { ok: true, card, fields: r.fields };
  }

  edit(id: string, e: CardEdit, by: string): BoardResult {
    const c = this.openCard(id);
    if ("done" in c) return { ok: true, card: c.done };
    if ("ok" in c) return c;
    const r = this.edited(c, e, by);
    if (!r.ok) return r;
    return { ok: true, card: this.s.store.put("triage", r.card) };
  }

  private done(card: TriageCard, status: TriageCard["status"], by: string, extra: Partial<TriageCard> = {}) {
    const now = Date.now();
    return this.s.store.put("triage", { ...card, ...extra, status, resolvedBy: by, resolvedAt: now, updatedAt: now });
  }

  /** What accepting a card makes and the card's own resolution land together, or not at all (Store.atomic). */
  private commit<T>(fn: () => T): T | { ok: false; error: string; status: number } {
    try {
      return this.s.store.atomic(fn);
    } catch (e) {
      console.error("board:", e instanceof Error ? e.message : e);
      return fail("That didn't save. Nothing changed; try again.", 500);
    }
  }

  /** Send a task card to its agents (or, for a cancel card, cancel what it names); `e` carries last-moment changes from the card's own form. */
  send(id: string, by: string, e: CardEdit = {}): BoardResult<{ directiveId: string }> {
    const c = this.openCard(id, { status: "sent", by });
    if ("done" in c) return { ok: true, card: c.done, directiveId: c.done.directiveId ?? "" };
    if ("ok" in c) return c;
    if (c.type !== "task") return fail("That's a context card: add it instead.");
    const r = this.edited(c, e, by);
    if (!r.ok) return r;
    const card = r.card;
    if (card.cancels) {
      const d = this.s.store.get("directives", card.cancels);
      if (!d || d.status === "done" || d.status === "cancelled") return fail(`That task is already ${d?.status ?? "gone"}: dismiss this card.`, 409);
      return this.commit(() => {
        this.s.cancelDirective(d, `${card.text} (${by} confirmed it from the Tasks board.)`);
        return { ok: true as const, card: this.done(card, "sent", by, { directiveId: d.id }), directiveId: d.id };
      });
    }
    if (!card.targets.length) return fail("Pick an agent to send it to first.");
    // The card may have waited while an agent left or became an observer: only agents that can still take it get it.
    const targets = this.validTargets(card.targets, card.mode);
    if (!targets.length) return fail("The agent it was for isn't in the session any more, or only watches. Pick another with Edit.", 409);
    const ws = card.workstream ? this.s.store.all("workstreams").find((w) => w.title.toLowerCase() === card.workstream.toLowerCase()) : undefined;
    return this.commit(() => {
      const d = this.s.createDirective({
        text: card.text,
        mode: card.mode,
        targets,
        requestedBy: card.by,
        sourceEventIds: card.sources.map((x) => x.eventId).filter((x): x is number => x != null),
        workstreamId: ws?.id ?? null,
        rationale: `${card.origin === "agent" ? `${card.by} reported this` : card.origin === "document" ? "From a document" : `Heard from ${card.by}`}; ${by} sent it from the Tasks board${card.edits.length ? " after editing it" : ""}.`,
      });
      return { ok: true as const, card: this.done({ ...card, targets }, "sent", by, { directiveId: d.id }), directiveId: d.id };
    });
  }

  private newFact(card: TriageCard): Fact {
    const now = Date.now();
    return { id: newId("fact"), ts: now, updatedAt: now, kind: card.kind, text: card.text, workstream: card.workstream, by: card.by, status: "active", note: "", sourceEventIds: card.sources.map((x) => x.eventId).filter((x): x is number => x != null) };
  }

  /** A file with no text to read proposed only its name: a person words the fact before it's saved. */
  private worded(c: TriageCard, next: TriageCard) {
    return !c.needsWording || (next.text !== c.original && !next.text.includes(c.original));
  }

  /** Save a context card as a fact; a decision also reaches the agents of its workstream as a room decision. */
  add(id: string, by: string, e: CardEdit = {}): BoardResult<{ factId: string }> {
    const c = this.openCard(id, { status: "added", by });
    if ("done" in c) return { ok: true, card: c.done, factId: c.done.factId ?? "" };
    if ("ok" in c) return c;
    if (c.type !== "context") return fail("That's a task card: send it instead.");
    if (c.retire) return fail("That card retires a saved fact: use Retire, or dismiss it.");
    const r = this.edited(c, e, by);
    if (!r.ok) return r;
    if (!this.worded(c, r.card)) return fail("Write what the file says to keep first: Edit, then Add.");
    return this.commit(() => {
      const fact = this.s.store.put("facts", this.newFact(r.card));
      this.announceDecision(r.card, by);
      return { ok: true as const, card: this.done(r.card, "added", by, { factId: fact.id }), factId: fact.id };
    });
  }

  private announceDecision(card: TriageCard, by: string) {
    if (card.kind !== "decision") return;
    const ws = card.workstream ? this.s.store.all("workstreams").find((w) => w.title.toLowerCase() === card.workstream.toLowerCase()) : undefined;
    this.s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: card.text, workstreamId: ws?.id ?? null, relevance: "work", data: { requestedBy: card.by, acceptedBy: by, fromCard: card.id } });
  }

  /** Fold a context card into a saved fact. `text` is the combined wording (the form offers both joined). */
  merge(id: string, factId: string, by: string, text?: string): BoardResult<{ factId: string }> {
    const c = this.openCard(id, { status: "merged", by });
    if ("done" in c) return { ok: true, card: c.done, factId: c.done.factId ?? "" };
    if ("ok" in c) return c;
    if (c.type !== "context" || c.retire) return fail("Only context cards that add something merge into a fact.");
    const f = this.s.store.get("facts", factId);
    if (!f || f.status !== "active") return fail("That fact isn't saved any more.", 404);
    const joined = text !== undefined ? clean(text) : clean(`${f.text.replace(/[.\s]+$/, "")}. ${c.text}`);
    if (!joined) return fail("The wording can't be empty.");
    // The card only has the file's name: the merged wording has to say something of its own, not the name or the fact alone.
    if (c.needsWording && (text === undefined || joined.includes(c.original) || joined.replace(/[.\s]+$/, "") === clean(f.text).replace(/[.\s]+$/, ""))) return fail("Write what to keep from the file into the merged wording first.");
    const ids = [...new Set([...f.sourceEventIds, ...c.sources.map((x) => x.eventId).filter((x): x is number => x != null)])];
    return this.commit(() => {
      this.s.store.put("facts", { ...f, text: joined, sourceEventIds: ids, note: `Merged with a proposal from ${c.by}`, updatedAt: Date.now() });
      return { ok: true as const, card: this.done(c, "merged", by, { factId: f.id }), factId: f.id };
    });
  }

  /** Put a context card in place of the fact it contradicts (the one it was flagged with, or `factId`). */
  replace(id: string, by: string, factId?: string, e: CardEdit = {}): BoardResult<{ factId: string }> {
    const c = this.openCard(id, { status: "replaced", by });
    if ("done" in c) return { ok: true, card: c.done, factId: c.done.factId ?? "" };
    if ("ok" in c) return c;
    if (c.type !== "context") return fail("Only context cards replace a fact.");
    // A Retire card retires the fact its room line was about, never another; a Replace card replaces the fact it was
    // matched with, or (with none) one a person picks of the same kind and workstream.
    if (c.retire && factId !== undefined && factId !== c.conflictsWith) return fail("A Retire card only retires the fact it was proposed for.");
    if (!c.retire && c.conflictsWith && factId !== undefined && factId !== c.conflictsWith) return fail("This card replaces the fact it was matched with. Dismiss it and propose the change for the other fact.");
    const old = this.s.store.get("facts", c.conflictsWith ?? factId ?? "");
    if (old && !c.conflictsWith && (old.kind !== c.kind || !sameName(old.workstream, c.workstream))) return fail("That fact is another kind or workstream: pick one that matches the card, or edit the card.");
    if (!old || old.status !== "active") return fail(c.retire ? "That fact is already gone." : "There's no saved fact left to replace. Add it instead.", 409);
    if (c.retire) {
      return this.commit(() => {
        this.s.store.put("facts", { ...old, status: c.retire!, note: `${c.text} (${by}, from the Tasks board)`, updatedAt: Date.now() });
        return { ok: true as const, card: this.done(c, "replaced", by, { factId: old.id }), factId: old.id };
      });
    }
    const r = this.edited(c, e, by);
    if (!r.ok) return r;
    if (!this.worded(c, r.card)) return fail("Write what the file says to keep first: Edit, then Replace.");
    // The old fact is retired only together with its replacement being saved.
    return this.commit(() => {
      this.s.store.put("facts", { ...old, status: "superseded", note: `Replaced by ${by} from the Tasks board`, updatedAt: Date.now() });
      const fact = this.s.store.put("facts", this.newFact(r.card));
      this.announceDecision(r.card, by);
      return { ok: true as const, card: this.done(r.card, "replaced", by, { factId: fact.id }), factId: fact.id };
    });
  }

  dismiss(id: string, by: string): BoardResult {
    const c = this.openCard(id, { status: "dismissed", by });
    if ("done" in c) return { ok: true, card: c.done };
    if ("ok" in c) return c;
    return { ok: true, card: this.done(c, "dismissed", by) };
  }

  /**
   * Overheard: the room wants a task stopped. The cancellation waits as a card (sending it cancels the task and
   * tells its agents); nothing an agent is doing changes until a person sends it.
   */
  proposeCancel(p: { directive: Directive; reason: string; by: string; sourceEventIds?: number[] }): TriageCard | null {
    const d = p.directive;
    if (d.status === "done" || d.status === "cancelled") return null;
    const sources = this.sourcesOf(p.sourceEventIds, p.by, p.reason);
    const open = this.open().find((c) => c.cancels === d.id);
    if (open) return this.repeat(open, sources);
    const text = clean(p.reason) || "The room changed its mind";
    const now = this.stamp();
    const card: TriageCard = {
      id: newId("tri"), ts: now, updatedAt: now, type: "task", status: "open", origin: "overheard", text, original: text, by: p.by,
      mode: d.mode, targets: d.targets, kind: "fact", workstream: "", conflictsWith: null, cancels: d.id, sources, count: 1, edits: [], resolvedBy: "", resolvedAt: null, directiveId: null, factId: null, mentionedAt: null,
    };
    return this.announce(this.s.store.put("triage", card));
  }

  /** Overheard: a later line overrules a proposal still waiting. It stays for a person to dismiss, marked with why. */
  overrule(id: string, reason: string): TriageCard | null {
    const c = this.get(id);
    if (!c || c.status !== "open") return null;
    return this.s.store.put("triage", { ...c, overruled: clean(reason).slice(0, 200) || "Overruled in the room", updatedAt: this.stamp() });
  }

  /** Minutes a card has waited, once it has waited long enough to label. */
  static waitingMin(c: TriageCard, now = Date.now()): number | null {
    return c.status === "open" && now - c.ts >= WAITING_MS ? Math.floor((now - c.ts) / 60_000) : null;
  }

  /** Open cards that have waited past the label threshold. */
  waiting(now = Date.now()): TriageCard[] {
    return this.open().filter((c) => now - c.ts >= WAITING_MS);
  }

  /** How people treat each kind of proposal: whether the router and curation hear real requests. */
  stats() {
    const count = (type: TriageCard["type"]) => {
      const mine = this.all().filter((c) => c.type === type);
      const acted = mine.filter((c) => c.status !== "open");
      return {
        proposed: mine.length,
        open: mine.length - acted.length,
        accepted: acted.filter((c) => ["sent", "added", "merged", "replaced"].includes(c.status)).length,
        edited: acted.filter((c) => c.status !== "dismissed" && c.edits.length > 0).length,
        dismissed: acted.filter((c) => c.status === "dismissed").length,
      };
    };
    return { task: count("task"), context: count("context") };
  }

  /** The cards as the brain reads them, numbered the way people say them ("the second one"). */
  describe(now = Date.now()): string {
    return this.open()
      .map((c, i) => {
        const w = Board.waitingMin(c, now);
        const who = c.targets.map((t) => this.s.agent(t)?.name ?? t).join(", ");
        const where = c.cancels ? `cancel ${c.cancels} for ${who}` : c.type === "task" ? `${c.mode} → ${who || "no agent chosen"}` : c.retire ? `retire a saved fact (${c.retire})` : `${c.kind}${c.conflictsWith ? ", contradicts a saved fact" : ""}`;
        return `${i + 1}. ${c.id} [${c.type}: ${where}] ${c.text}${c.count > 1 ? ` (said ${c.count} times)` : ""} (${c.by}${w != null ? `, waiting ${w} min` : ""})${c.overruled ? ` [overruled: ${c.overruled}]` : ""}`;
      })
      .join("\n");
  }
}
