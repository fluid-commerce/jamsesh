// The Tasks view (4.1): what JamSesh overheard waits in Triage for a person; what was sent moves across Waiting,
// Working and Done as the agents report. Used by people's apps and by the host. Clicking a card opens what it produced.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cast } from "../client/CastPicker";
import { api, pref, setPref, type Agent, type Artifact, type Directive, type Fact, type HubState, type JamEvent, type TriageCard } from "./hub";
import { agoWords } from "./StageControls";
import { colorFor, useNow } from "./ui";
import "./tasks.css";

type ColId = "triage" | "waiting" | "working" | "done";
const COLS: { id: ColId; label: string; hint: string }[] = [
  { id: "triage", label: "Triage", hint: "Proposed, waiting for a person" },
  { id: "waiting", label: "Waiting", hint: "Sent, not picked up yet" },
  { id: "working", label: "Working", hint: "An agent is on it" },
  { id: "done", label: "Done", hint: "Finished" },
];
const KINDS = ["decision", "requirement", "constraint", "preference", "question", "fact"] as const;
const MODES = ["explore", "implement", "coordinate", "answer", "note"] as const;
const MODE_WORDS: Record<string, string> = { explore: "Explore", implement: "Build", coordinate: "Coordinate", answer: "Answer", note: "Write down", present: "Present" };
/** Cards waiting this long get the "Waiting 40 min" label (the hub mentions them out loud too). */
const WAITING_LABEL_MS = 30 * 60_000;
const DONE_SHOWN = 30;

/** "4 min", "1 h 5 min": how long, without "ago". */
export function span(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const overlap = (a: string, b: string) => {
  const x = words(a);
  const y = words(b);
  return [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size));
};

/** Everything a sent task made: the frames and builds its agents put up since, and the links in what they reported. */
export function producedBy(d: Directive, state: HubState): { artifacts: Artifact[]; links: string[] } {
  const end = d.status === "done" ? d.updatedAt + 3 * 60_000 : Infinity;
  const artifacts = state.artifacts.filter((a) => a.agentId && d.targets.includes(a.agentId) && a.updatedAt >= d.ts && a.ts <= end).slice(0, 8);
  const links = [...new Set(d.result.match(/https?:\/\/[^\s)>\]"']+/g) ?? [])].filter((u) => !artifacts.some((a) => a.url === u));
  return { artifacts, links };
}

/** Which column a directive sits in; cancelled ones aren't on the board. */
export function columnOf(d: Directive): Exclude<ColId, "triage"> | null {
  if (d.status === "pending" || d.status === "delivered") return "waiting";
  if (d.status === "acked") return "working";
  if (d.status === "done") return "done";
  return null;
}

type Open = { kind: "card"; id: string } | { kind: "directive"; id: string } | null;

export function TasksView({ state, personId, big }: { state: HubState; personId?: string; big?: boolean }) {
  const now = useNow(30_000);
  const [col, setCol] = useState<ColId>(() => (COLS.some((c) => c.id === pref("tasksCol")) ? (pref("tasksCol") as ColId) : "triage"));
  const [open, setOpen] = useState<Open>(null);
  const opener = useRef<HTMLElement | null>(null);
  const cards = useMemo(() => state.triage.filter((c) => c.status === "open").sort((a, b) => a.ts - b.ts), [state.triage]);
  const dirs = useMemo(() => {
    const by: Record<Exclude<ColId, "triage">, Directive[]> = { waiting: [], working: [], done: [] };
    for (const d of state.directives) {
      const c = columnOf(d);
      if (c) by[c].push(d);
    }
    by.done = by.done.slice(0, DONE_SHOWN);
    return by;
  }, [state.directives]);
  const counts: Record<ColId, number> = { triage: cards.length, waiting: dirs.waiting.length, working: dirs.working.length, done: dirs.done.length };
  const pick = (c: ColId) => (setCol(c), setPref("tasksCol", c));
  const show = (o: Open) => {
    opener.current = document.activeElement as HTMLElement | null;
    setOpen(o);
  };
  const close = () => {
    setOpen(null);
    opener.current?.focus?.();
  };
  const act = { state, personId, now, show };

  return (
    <div className={`tasks ${big ? "big" : ""}`} aria-label="Tasks">
      <div className="tk-tabs" role="tablist" aria-label="Task columns">
        {COLS.map((c) => (
          <button key={c.id} role="tab" aria-selected={col === c.id} className={`tk-tab ${col === c.id ? "on" : ""}`} onClick={() => pick(c.id)}>
            {c.label}
            <span className={`tk-count ${c.id === "triage" && counts.triage ? "hot" : ""}`}>{counts[c.id]}</span>
          </button>
        ))}
      </div>
      <div className="tk-cols">
        {COLS.map((c) => (
          <section key={c.id} className="tk-col" data-active={col === c.id} aria-label={c.label}>
            <header className="tk-head" title={c.id === "triage" ? "Keys on a card: ↑ ↓ move, Enter open, E edit, S send or add, D dismiss. Say “send the second one” out loud." : c.hint}>
              <span className={`tk-dot ${c.id}`} />
              <span className="tk-title">{c.label}</span>
              <span className={`tk-count ${c.id === "triage" && counts.triage ? "hot" : ""}`}>{counts[c.id]}</span>
            </header>
            <div className="tk-body scrollbars-thin" onKeyDown={moveFocus}>
              {c.id === "triage" ? (
                cards.length ? (
                  cards.map((card, i) => <TriageCardView key={card.id} card={card} index={i + 1} {...act} />)
                ) : (
                  <p className="tk-empty">Nothing waiting. What JamSesh overhears, and what agents report, shows up here for you to send or add.</p>
                )
              ) : dirs[c.id].length ? (
                dirs[c.id].map((d) => <DirectiveCardView key={d.id} d={d} col={c.id as Exclude<ColId, "triage">} {...act} />)
              ) : (
                <p className="tk-empty">{c.id === "waiting" ? "Nothing waiting for an agent." : c.id === "working" ? "No agent is working on a task." : "Finished tasks land here."}</p>
              )}
            </div>
          </section>
        ))}
      </div>
      {open && <Sheet state={state} open={open} personId={personId} now={now} onClose={close} />}
    </div>
  );
}

/** Arrow keys walk the cards in a column. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const t = e.target as HTMLElement;
  if (!t.matches?.(".tk-card")) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(".tk-card")];
  const next = all[all.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1)];
  if (next) (e.preventDefault(), next.focus());
}

function useAct() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message || "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

const workers = (state: HubState) => state.agents.filter((a) => a.role !== "observer" && a.status !== "offline");
const agentNames = (state: HubState, ids: string[]) => ids.map((id) => state.agents.find((a) => a.id === id)?.name ?? "an agent");

function AgentTag({ state, ids }: { state: HubState; ids: string[] }) {
  if (!ids.length) return <span className="tk-tag warn">No agent chosen</span>;
  return (
    <span className="tk-tag agent" title={agentNames(state, ids).join(", ")}>
      <span className="tk-agent-dot" style={{ background: colorFor(state, { agentId: ids[0] }) }} />
      <span className="ellipsis">{agentNames(state, ids).join(", ")}</span>
    </span>
  );
}

function Waited({ ts, now }: { ts: number; now: number }) {
  const late = now - ts >= WAITING_LABEL_MS;
  return late ? <span className="tk-late">Waiting {span(now - ts)}</span> : <span className="tk-age">{span(now - ts)}</span>;
}

function cardKeys(e: KeyboardEvent<HTMLElement>, h: { open: () => void; edit?: () => void; primary?: () => void; dismiss?: () => void }) {
  if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const go = (fn?: () => void) => fn && (e.preventDefault(), fn());
  if (k === "enter" || k === " ") go(h.open);
  else if (k === "e") go(h.edit);
  else if (k === "s" || k === "a") go(h.primary);
  else if (k === "d" || k === "backspace" || k === "delete") go(h.dismiss);
}

// ---------- Triage cards ----------

type Draft = { text: string; mode: string; agent: string; workstream: string; kind: string };

function TriageCardView({ card, index, state, personId, now, show }: { card: TriageCard; index: number; state: HubState; personId?: string; now: number; show: (o: Open) => void }) {
  const { busy, err, run } = useAct();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const task = card.type === "task";
  const conflict = card.conflictsWith ? state.facts.find((f) => f.id === card.conflictsWith && f.status === "active") : undefined;
  const [draft, setDraft] = useState<Draft>({ text: card.text, mode: card.mode, agent: card.targets.length === 1 ? card.targets[0] : "", workstream: card.workstream, kind: card.kind });
  const area = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  // A change that arrives while nobody is editing (a repeat joined, someone else edited) shows up in the card.
  useEffect(() => {
    if (!editing) setDraft({ text: card.text, mode: card.mode, agent: card.targets.length === 1 ? card.targets[0] : "", workstream: card.workstream, kind: card.kind });
  }, [card, editing]);

  const edits = () => {
    const e: Record<string, unknown> = { personId };
    if (draft.text.trim() !== card.text) e.text = draft.text;
    if (task) {
      if (draft.mode !== card.mode) e.mode = draft.mode;
      if (draft.agent && draft.agent !== card.targets.join()) e.targets = [draft.agent];
    } else if (draft.kind !== card.kind) e.kind = draft.kind;
    if (draft.workstream.trim() !== card.workstream) e.workstream = draft.workstream;
    return e;
  };
  const verb = (v: "send" | "add" | "replace" | "dismiss") =>
    run(async () => {
      await api(`/triage/${card.id}/${v}`, v === "dismiss" ? { personId } : edits());
      setEditing(false);
    });
  const save = () => run(async () => (await api(`/triage/${card.id}`, edits(), "PATCH"), setEditing(false)));
  const primary = () => (task ? verb("send") : conflict ? verb("replace") : verb("add"));
  const label = task ? "Send" : card.retire ? "Retire" : conflict ? "Replace" : "Add";
  const sendReady = !task || (draft.agent || card.targets.length) ? true : false;

  const fieldKeys = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.stopPropagation(), setEditing(false), ref.current?.focus());
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), primary());
  };

  return (
    <article
      ref={ref}
      className={`tk-card triage ${task ? "task" : "context"} ${editing ? "editing" : ""}`}
      tabIndex={0}
      aria-label={`${index}. ${task ? "Task" : card.kind}: ${card.text}`}
      onKeyDown={(e) => cardKeys(e, { open: () => show({ kind: "card", id: card.id }), edit: () => setEditing(true), primary, dismiss: () => verb("dismiss") })}
    >
      <div className="tk-top">
        <span className="tk-num mono" title={`Say “the ${["first", "second", "third", "fourth", "fifth"][index - 1] ?? `number ${index}`} one”`}>{index}</span>
        <span className={`tk-tag kind ${task ? card.mode : card.kind}`}>{task ? MODE_WORDS[card.mode] : card.retire ? `Retire ${card.kind}` : card.kind}</span>
        <span className="grow" />
        <Waited ts={card.ts} now={now} />
      </div>

      {editing ? (
        <div className="tk-edit" onKeyDown={fieldKeys}>
          <textarea ref={area} value={draft.text} rows={3} aria-label="Wording" onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <div className="tk-fields">
            {task ? (
              <>
                <label>
                  <span>Agent</span>
                  <select value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })}>
                    {!draft.agent && <option value="">{card.targets.length > 1 ? agentNames(state, card.targets).join(", ") : "Choose an agent"}</option>}
                    {workers(state).map((a: Agent) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Mode</span>
                  <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                    {MODES.map((m) => (
                      <option key={m} value={m}>
                        {MODE_WORDS[m]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label>
                <span>Kind</span>
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>Workstream</span>
              <input list={`ws-${card.id}`} value={draft.workstream} placeholder="Whole session" onChange={(e) => setDraft({ ...draft, workstream: e.target.value })} />
              <datalist id={`ws-${card.id}`}>
                {state.workstreams.map((w) => (
                  <option key={w.id} value={w.title} />
                ))}
              </datalist>
            </label>
          </div>
        </div>
      ) : (
        <button className="tk-text" onClick={() => show({ kind: "card", id: card.id })} tabIndex={-1} title="Open the card">
          {card.text}
        </button>
      )}

      {conflict && !editing && (
        <div className="tk-versus" aria-label="This disagrees with a saved fact">
          <div>
            <span className="label">Saved now</span>
            <p>{conflict.text}</p>
          </div>
          <div>
            <span className="label">{card.retire ? "Why" : "Heard"}</span>
            <p>{card.text}</p>
          </div>
        </div>
      )}

      {(task || (card.workstream && !editing) || card.count > 1 || card.edits.length > 0) && (
        <div className="tk-chips">
          {task && <AgentTag state={state} ids={card.targets} />}
          {card.workstream && !editing && <span className="tk-tag ws">{card.workstream}</span>}
          {card.count > 1 && <span className="tk-times" title="Said more than once; the repeats are on this card">Heard {card.count} times</span>}
          {card.edits.length > 0 && <span className="tk-times">Edited</span>}
        </div>
      )}
      <div className="tk-meta">
        <span className="ellipsis">
          {card.origin === "agent" ? `Reported by ${card.by}` : card.origin === "document" ? `From a document, ${card.by}` : `Heard from ${card.by}`}
          {card.sources[0]?.ts ? `, ${clock(card.sources[0].ts)}` : ""}
        </span>
      </div>

      {merging && <MergePanel card={card} facts={state.facts.filter((f) => f.status === "active")} personId={personId} onDone={() => setMerging(false)} />}
      {err && <p className="tk-err" role="alert">{err}</p>}

      {!merging && (
        <div className="tk-actions">
          <button className="btn small primary" disabled={busy || !sendReady} onClick={primary} title={!sendReady ? "Choose an agent with Edit first" : task ? "Send to the agent (S)" : conflict ? "Put this in place of the saved fact (S)" : "Save as a fact (S)"}>
            {label}
          </button>
          {editing ? (
            <>
              <button className="btn small" disabled={busy} onClick={save}>
                Save
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn small" disabled={busy} onClick={() => setEditing(true)} title="Edit the wording, agent, mode or workstream (E)">
                Edit
              </button>
              {!task && !card.retire && (
                <button className="btn small" disabled={busy} onClick={() => setMerging(true)} title="Fold this into a saved fact">
                  Merge into…
                </button>
              )}
              {!task && conflict && !card.retire && (
                <button className="btn small" disabled={busy} onClick={() => verb("add")} title="Keep both">
                  Add anyway
                </button>
              )}
              <button className="btn small ghost tk-dismiss" disabled={busy} onClick={() => verb("dismiss")} title="Dismiss (D)">
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function MergePanel({ card, facts, personId, onDone }: { card: TriageCard; facts: Fact[]; personId?: string; onDone: () => void }) {
  const { busy, err, run } = useAct();
  const [q, setQ] = useState("");
  const [fact, setFact] = useState<Fact | null>(null);
  const [text, setText] = useState("");
  const ranked = useMemo(() => {
    const ql = q.toLowerCase();
    return facts
      .filter((f) => !ql || f.text.toLowerCase().includes(ql))
      .map((f) => ({ f, s: overlap(f.text, card.text) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((x) => x.f);
  }, [facts, q, card.text]);
  const choose = (f: Fact) => (setFact(f), setText(`${f.text.replace(/[.\s]+$/, "")}. ${card.text}`));
  return (
    <div className="tk-merge" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onDone())}>
      {!fact ? (
        <>
          <input autoFocus placeholder="Find a saved fact…" aria-label="Find a saved fact" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {ranked.map((f) => (
              <li key={f.id}>
                <button onClick={() => choose(f)}>
                  <span className="tk-tag kind">{f.kind}</span>
                  <span>{f.text}</span>
                </button>
              </li>
            ))}
            {!ranked.length && <li className="tk-empty small">No saved fact matches.</li>}
          </ul>
        </>
      ) : (
        <>
          <span className="label">Merged wording</span>
          <textarea autoFocus rows={3} value={text} aria-label="Merged wording" onChange={(e) => setText(e.target.value)} />
        </>
      )}
      {err && <p className="tk-err">{err}</p>}
      <div className="tk-actions">
        {fact && (
          <button className="btn small primary" disabled={busy || !text.trim()} onClick={() => run(async () => (await api(`/triage/${card.id}/merge`, { personId, factId: fact.id, text }), onDone()))}>
            Merge
          </button>
        )}
        <button className="btn small ghost" onClick={() => (fact ? setFact(null) : onDone())}>
          {fact ? "Back" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// ---------- Cards for sent tasks ----------

function DirectiveCardView({ d, col, state, now, show }: { d: Directive; col: Exclude<ColId, "triage">; state: HubState; now: number; show: (o: Open) => void }) {
  const made = col === "done" ? producedBy(d, state) : null;
  const stuck = col === "waiting" && now - d.ts >= WAITING_LABEL_MS;
  const open = () => show({ kind: "directive", id: d.id });
  return (
    <article className={`tk-card sent ${col}`} tabIndex={0} aria-label={`${MODE_WORDS[d.mode] ?? d.mode}: ${d.text}`} onKeyDown={(e) => cardKeys(e, { open })}>
      <div className="tk-top">
        <span className={`tk-tag kind ${d.mode}`}>{MODE_WORDS[d.mode] ?? d.mode}</span>
        <span className="grow" />
        {col === "done" ? <span className="tk-age">{agoWords(d.updatedAt, now)}</span> : stuck ? <span className="tk-late">Waiting {span(now - d.ts)}</span> : <span className="tk-age">{span(now - (col === "working" ? d.deliveredAt ?? d.ts : d.ts))}</span>}
      </div>
      <button className="tk-text" onClick={open} tabIndex={-1} title="Open the card">
        {d.text}
      </button>
      {col === "done" && d.result && <p className="tk-result">{d.result.split("\n").pop()}</p>}
      <div className="tk-chips">
        <AgentTag state={state} ids={d.targets} />
        {made && (made.artifacts.length > 0 || made.links.length > 0) && <span className="tk-times">{made.artifacts.length + made.links.length} made</span>}
      </div>
      <div className="tk-meta">
        <span className="ellipsis">From {d.requestedBy}</span>
      </div>
    </article>
  );
}

// ---------- The sheet: what a card is, where it came from, and what it produced ----------

function Sheet({ state, open, personId, now, onClose }: { state: HubState; open: NonNullable<Open>; personId?: string; now: number; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, []);
  const card = open.kind === "card" ? state.triage.find((c) => c.id === open.id) : undefined;
  const d = open.kind === "directive" ? state.directives.find((x) => x.id === open.id) : undefined;
  // A sent task keeps the card it came from: what was heard, and what people changed.
  const origin = d ? state.triage.find((c) => c.directiveId === d.id) : undefined;
  const made = d ? producedBy(d, state) : null;
  const heard = card ?? origin;
  const title = card ? (card.type === "task" ? "Task proposal" : `Proposed ${card.kind}`) : d ? `${MODE_WORDS[d.mode] ?? d.mode} task` : "";
  return (
    <>
      <div className="tk-scrim" onClick={onClose} />
      <aside className="tk-sheet" role="dialog" aria-label={title} ref={box} tabIndex={-1}>
        <header>
          <span className="label">{title}</span>
          <button className="icon-btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="tk-sheet-body scrollbars-thin">
          {!card && !d && <p className="tk-empty">That card is gone.</p>}
          <p className="tk-sheet-text">{card?.text ?? d?.text}</p>

          {d && (
            <dl className="tk-facts">
              <dt>Status</dt>
              <dd>{d.status === "pending" ? "Sent, not picked up yet" : d.status === "delivered" ? "Delivered to the agent" : d.status === "acked" ? "Being worked on" : d.status === "done" ? "Done" : d.status}</dd>
              <dt>Agents</dt>
              <dd>
                {d.targets.map((t) => (
                  <span key={t} className="tk-line">
                    {state.agents.find((a) => a.id === t)?.name ?? "An agent"}: {d.progress[t] ?? d.status}
                  </span>
                ))}
              </dd>
              <dt>Asked by</dt>
              <dd>
                {d.requestedBy}, {agoWords(d.ts, now)}
              </dd>
              {d.rationale && (
                <>
                  <dt>Why</dt>
                  <dd>{d.rationale}</dd>
                </>
              )}
            </dl>
          )}

          {d && (
            <section>
              <h3 className="label">What it made</h3>
              {d.result && <p className="tk-sheet-result">{d.result}</p>}
              {made && (made.artifacts.length > 0 || made.links.length > 0) ? (
                <div className="tk-made">
                  {made.artifacts.map((a) => (
                    <MadeItem key={a.id} a={a} />
                  ))}
                  {made.links.map((u) => (
                    <a key={u} className="tk-link" href={u} target="_blank" rel="noreferrer">
                      {u.replace(/^https?:\/\//, "")}
                    </a>
                  ))}
                </div>
              ) : (
                !d.result && <p className="tk-empty small">Nothing yet. Mockups, builds and links show up here as the agent puts them up.</p>
              )}
            </section>
          )}

          {card && card.type === "context" && card.conflictsWith && <ConflictBlock state={state} card={card} />}

          {heard && (
            <section>
              <h3 className="label">
                {heard.origin === "agent" ? "Reported" : "Heard"}
                {heard.count > 1 ? `, ${heard.count} times` : ""}
              </h3>
              <ul className="tk-sources">
                {heard.sources.map((s, i) => (
                  <Source key={`${s.eventId}-${i}`} s={s} />
                ))}
              </ul>
              {heard.original !== heard.text && (
                <p className="tk-was">
                  <span className="label">First wording</span>
                  {heard.original}
                </p>
              )}
              {heard.edits.length > 0 && (
                <ul className="tk-edits">
                  {heard.edits.map((e, i) => (
                    <li key={i}>
                      {e.by} changed the {e.fields.join(", ")}, {agoWords(e.at, now)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

function ConflictBlock({ state, card }: { state: HubState; card: TriageCard }) {
  const f = state.facts.find((x) => x.id === card.conflictsWith);
  if (!f) return null;
  return (
    <section>
      <h3 className="label">Disagrees with a saved fact</h3>
      <p className="tk-sheet-result">{f.text}</p>
    </section>
  );
}

/** A frame or build the task produced: a picture to put on the big screen, or a link to open. */
function MadeItem({ a }: { a: Artifact }) {
  const [busy, setBusy] = useState(false);
  const put = () => {
    setBusy(true);
    cast({ mode: "spotlight", items: [a.id], title: a.title, pinned: false, by: "Tasks" } as any).finally(() => setBusy(false));
  };
  return (
    <div className="tk-item">
      {a.image ? <img src={a.image} alt="" loading="lazy" /> : <div className="tk-item-blank">{a.kind === "devserver" ? "Live build" : a.stage === "built" ? "Build" : "Mockup"}</div>}
      <div className="tk-item-info">
        <strong className="ellipsis">{a.title}</strong>
        <span className="row">
          {a.image && (
            <button className="btn small" disabled={busy} onClick={put}>
              Show on the big screen
            </button>
          )}
          {a.url && (
            <a className="btn small" href={a.url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

const FEED = "speech,prompt,message,decision,update,directive,brain";

/** One line the card came from, with the conversation around it on request. */
function Source({ s }: { s: TriageCard["sources"][number] }) {
  const [around, setAround] = useState<JamEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    if (around) return setAround(null);
    if (s.eventId == null) return;
    try {
      const r = await api<{ items: JamEvent[] }>(`/history/events?before=${s.eventId + 4}&limit=7&kinds=${FEED}`);
      setAround(r.items);
    } catch {
      setFailed(true);
    }
  };
  return (
    <li>
      <div className="tk-src">
        <span className="tk-src-who">{s.authorName}</span>
        <span className="tk-src-time">{clock(s.ts)}</span>
        {s.eventId != null && (
          <button className="tk-src-link" onClick={load} aria-expanded={!!around}>
            {around ? "Hide" : "In the conversation"}
          </button>
        )}
      </div>
      <q>{s.text}</q>
      {failed && <p className="tk-err">Couldn't load the conversation.</p>}
      {around && (
        <ol className="tk-around">
          {around.map((e) => (
            <li key={e.id} className={e.id === s.eventId ? "here" : ""}>
              <b>{e.authorName}</b> {e.text}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** The count that goes on the tab and the host button: what is waiting for a person. */
export function triageCount(state: HubState | null) {
  return state?.triage.filter((c) => c.status === "open").length ?? 0;
}

