// A wiki update waiting on the Tasks board: one card per ingest, with each page's change to look at and a
// toggle for it. Accepting writes the checked pages; the rest are dropped.
import { useState } from "react";
import { api, type HubState, type TriageCard, type WikiChange } from "../shared/hub";
import { asCategory, CATEGORY_COLOR, CATEGORY_LABEL } from "./types";
import { wikiApi } from "./wikiApi";
import "./wiki.css";

const KIND_WORDS = { ingest: "Wiki update", lint: "Wiki check", answer: "Answer to file" } as const;

export function WikiCardView({ card, index, personId, now }: { card: TriageCard; index: number; state?: HubState; personId?: string; now: number; show?: unknown }) {
  const w = card.wiki;
  const changes = w?.changes ?? [];
  const [off, setOff] = useState<Set<string>>(() => new Set(changes.filter((c) => c.stale).map((c) => c.slug)));
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!w) return null;
  const chosen = changes.filter((c) => !off.has(c.slug));
  const age = Math.max(0, Math.floor((now - card.ts) / 60_000));

  const act = async (verb: "add" | "dismiss") => {
    setBusy(true);
    setErr("");
    try {
      await api(`/triage/${card.id}/${verb}`, verb === "add" ? { personId, pages: chosen.map((c) => c.slug) } : { personId });
    } catch (e: any) {
      setErr(e?.message || "That didn't work. Try again.");
    }
    setBusy(false);
  };
  const toggle = (slug: string) => setOff((cur) => (cur.has(slug) ? new Set([...cur].filter((s) => s !== slug)) : new Set([...cur, slug])));

  return (
    <article className="tk-card triage context wk-card" aria-label={`${index}. ${KIND_WORDS[w.kind] ?? "Wiki"}: ${w.summary}`}>
      <div className="tk-top">
        <span className="tk-num mono">{index}</span>
        <span className="tk-tag kind">{KIND_WORDS[w.kind] ?? "Wiki"}</span>
        <span className="grow" />
        <span className="tk-age">{age < 1 ? "just now" : `${age} min`}</span>
      </div>
      <p className="wk-card-sum">{w.summary}</p>
      {changes.length > 0 && (
        <ul className="wk-card-list">
          {changes.map((c) => (
            <li key={c.slug} className={off.has(c.slug) ? "off" : ""}>
              <label>
                <input type="checkbox" checked={!off.has(c.slug)} onChange={() => toggle(c.slug)} aria-label={`Include ${c.title}`} />
                <span className="wk-dot" style={{ background: CATEGORY_COLOR[asCategory(c.category)] }} title={CATEGORY_LABEL[asCategory(c.category)]} />
                <span className="wk-card-t">{c.title}</span>
                <span className="wk-card-op">{c.op === "create" ? "New" : "Changed"}</span>
              </label>
              {c.stale && <span className="wk-card-stale">Someone edited this since. It will be skipped.</span>}
              {c.largeDeletion && !c.stale && <span className="wk-card-stale">Takes out {c.removed} lines of this page. Look at the changes before adding it.</span>}
              <button className="btn ghost small" aria-expanded={open === c.slug} onClick={() => setOpen(open === c.slug ? null : c.slug)}>
                {open === c.slug ? "Hide" : "Changes"}
              </button>
              {c.op === "update" && c.removed !== undefined && (
                <span className="wk-card-op mono" title={`${c.added ?? 0} lines added, ${c.removed} removed`}>
                  +{c.added ?? 0} −{c.removed}
                </span>
              )}
              {open === c.slug && <Diff c={c} cardId={card.id} />}
            </li>
          ))}
        </ul>
      )}
      {w.findings && w.findings.length > 0 && (
        <ul className="wk-card-find">
          {w.findings.slice(0, 12).map((f, i) => (
            <li key={i}>
              <b>{f.kind}</b> {f.text}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="tk-err" role="alert">{err}</p>}
      <div className="tk-actions">
        {changes.length > 0 ? (
          <button className="btn small primary" disabled={busy || !chosen.length} onClick={() => void act("add")}>
            {chosen.length === 1 ? "Add 1 page" : `Add ${chosen.length} pages`}
          </button>
        ) : null}
        <button className={`btn small ${changes.length ? "ghost" : "primary"}`} disabled={busy} onClick={() => void act("dismiss")}>
          {changes.length ? "Dismiss" : "Done"}
        </button>
      </div>
    </article>
  );
}

const SHOWN = 400;

/**
 * What the diff box shows: the first SHOWN lines until the person asks for the rest, never fewer without saying so.
 * The hub's own notes ("(cut here…)") always show, whatever is folded away.
 */
export function diffView(diff: string, all: boolean): { lines: string[]; hidden: number; notes: string[] } {
  const every = diff.split("\n");
  const isNote = (l: string) => /^\((cut here|too long to line up)/.test(l);
  const lines = all ? every : every.slice(0, SHOWN);
  return { lines, hidden: every.length - lines.length, notes: all ? [] : every.slice(SHOWN).filter(isNote) };
}

function Diff({ c, cardId }: { c: WikiChange; cardId: string }) {
  const [all, setAll] = useState(false);
  // A change the hub cut short is fetched whole when asked for: the card never asks anyone to approve text it can't show.
  const [full, setFull] = useState<string | null>(null);
  const [state, setState] = useState<"" | "loading" | "failed">("");
  const v = diffView(full ?? c.diff, all);
  const load = async () => {
    setState("loading");
    try {
      setFull((await wikiApi.fullChange(cardId, c.slug)).diff);
      setState("");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="wk-diff-wrap">
      <pre className="wk-diff scrollbars-thin" tabIndex={0} aria-label={`Changes to ${c.title}`}>
        {v.lines.map((l, i) => (
          <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : /^\(/.test(l) ? "note" : ""}>
            {l || " "}
            {"\n"}
          </span>
        ))}
      </pre>
      {c.cut && full === null && (
        <p className="wk-diff-more">
          This is part of the change.{" "}
          <button className="btn ghost small" disabled={state === "loading"} onClick={() => void load()}>
            {state === "loading" ? "Loading…" : "Show the whole change"}
          </button>
          {state === "failed" && <span role="alert"> Couldn't load it. Try again.</span>}
        </p>
      )}
      {v.hidden > 0 && (
        <p className="wk-diff-more">
          {v.notes.map((n) => (
            <span key={n}>{n} </span>
          ))}
          <button className="btn ghost small" onClick={() => setAll(true)}>
            Show the other {v.hidden} lines
          </button>
        </p>
      )}
    </div>
  );
}
