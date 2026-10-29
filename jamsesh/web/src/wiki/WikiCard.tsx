// A wiki update waiting on the Tasks board: one card per ingest, with each page's change to look at and a
// toggle for it. Accepting writes the checked pages; the rest are dropped.
import { useState } from "react";
import { api, type HubState, type TriageCard, type WikiChange } from "../shared/hub";
import { asCategory, CATEGORY_COLOR, CATEGORY_LABEL } from "./types";
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
              <button className="btn ghost small" aria-expanded={open === c.slug} onClick={() => setOpen(open === c.slug ? null : c.slug)}>
                {open === c.slug ? "Hide" : "Changes"}
              </button>
              {open === c.slug && <Diff c={c} />}
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

function Diff({ c }: { c: WikiChange }) {
  const lines = c.diff.split("\n").slice(0, 400);
  return (
    <pre className="wk-diff scrollbars-thin" tabIndex={0} aria-label={`Changes to ${c.title}`}>
      {lines.map((l, i) => (
        <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
