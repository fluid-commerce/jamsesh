// The notes a recording produced, for the person to tidy before anything is sent (6.2):
// edit what was heard, merge two into one, delete what they didn't mean.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mergeInto, pinWords, type RecordNote } from "./notes";

export type { RecordNote };

function Note({ n, i, brain, locked, onText, onMerge, onDelete }: { n: RecordNote; i: number; brain: string; locked: boolean; onText: (t: string) => void; onMerge: (() => void) | null; onDelete: () => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [n.text]);
  const where = pinWords(n);
  return (
    <li className={`rt-note ${n.pin ? "" : "loose"}`}>
      <span className="rt-pin" aria-hidden="true">
        {n.pin ? i + 1 : ""}
      </span>
      <div className="rt-body">
        <textarea ref={ta} value={n.text} rows={1} aria-label={`Note ${i + 1}`} readOnly={locked} onChange={(e) => onText(e.target.value)} />
        <div className="rt-meta">
          <span className="rt-where">{where ?? "Not pinned to anything"}</span>
          <span className={`rt-to ${n.ownerName ? "agent" : ""}`}>{n.ownerName ? `Goes to ${n.ownerName}` : `${brain} decides who gets it`}</span>
        </div>
      </div>
      <div className="rt-acts">
        {onMerge && (
          <button type="button" disabled={locked} onClick={onMerge} title="Join with the note above" aria-label={`Join note ${i + 1} with the one above`}>
            Join up
          </button>
        )}
        <button type="button" className="del" disabled={locked} onClick={onDelete} title="Delete this note" aria-label={`Delete note ${i + 1}`}>
          Delete
        </button>
      </div>
    </li>
  );
}

export function RecordTidy({ notes, brain, busy, locked = busy, error, onChange, onSend, onDiscard }: { notes: RecordNote[]; brain: string; busy: boolean; locked?: boolean; error?: string | null; onChange: (n: RecordNote[]) => void; onSend: () => void; onDiscard: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const live = notes.filter((n) => n.text.trim());
  const agents = new Set(live.map((n) => n.ownerName).filter(Boolean));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && live.length && !busy) {
        e.preventDefault();
        onSend();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return createPortal(
    <div className="rt-scrim" role="dialog" aria-modal="true" aria-label="Your notes">
      <div className="rt-sheet">
        <header>
          <h3>Your notes</h3>
          <p>
            {live.length === 1 ? "1 thing" : `${live.length} things`} you said while pointing. Fix anything it misheard, then send.
          </p>
        </header>
        <ol className="rt-list">
          {notes.map((n, i) => (
            <Note
              key={n.id}
              n={n}
              i={i}
              brain={brain}
              locked={locked}
              onText={(text) => onChange(notes.map((x, k) => (k === i ? { ...x, text } : x)))}
              onMerge={i > 0 ? () => onChange(mergeInto(notes, i)) : null}
              onDelete={() => onChange(notes.filter((_, k) => k !== i))}
            />
          ))}
          {!notes.length && <li className="rt-empty">No notes left.</li>}
        </ol>
        {error && <p className="rt-error">{error}</p>}
        <footer>
          {confirm ? (
            <>
              <span className="rt-sure">Throw these notes away?</span>
              <button type="button" className="btn small" onClick={() => setConfirm(false)}>
                Keep them
              </button>
              <button type="button" className="btn small danger" onClick={onDiscard}>
                Discard
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn small ghost" onClick={() => setConfirm(true)} disabled={busy}>
                Discard
              </button>
              <button type="button" className="btn primary" onClick={onSend} disabled={busy || !live.length}>
                {busy ? "Sending…" : live.length ? `Send ${live.length === 1 ? "1 note" : `${live.length} notes`}${agents.size ? ` to ${agents.size === 1 ? [...agents][0] : `${agents.size} agents`}` : ""}` : "Nothing to send"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
