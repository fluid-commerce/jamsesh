// The notes a recording produced, for the person to tidy before anything is sent (6.2):
// edit what was heard, merge two into one, delete what they didn't mean.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RecordNote } from "../../../hub/src/types";

export type { RecordNote };

/** What /record/send answers. */
export type SendReply = { ok: boolean; reason?: string; sent?: { agentName: string; notes: number }[]; brain?: number };

const count = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** What a send did, in words: who got how many. */
export function sendSummary(r: SendReply, brain: string) {
  const parts = [...(r.sent ?? []).map((x) => `${count(x.notes)} to ${x.agentName}`), ...(r.brain ? [`${count(r.brain)} to ${brain}`] : [])];
  return { text: parts.join(", "), pills: parts };
}

/** Merges a note into the one before it: words joined in order, the earlier pin kept (or the later one if the earlier had none). */
export function mergeInto(notes: RecordNote[], i: number): RecordNote[] {
  if (i < 1 || i >= notes.length) return notes;
  const a = notes[i - 1];
  const b = notes[i];
  const merged: RecordNote = { ...a, text: `${a.text.trim()} ${b.text.trim()}`.trim(), t1: Math.max(a.t1, b.t1), pin: a.pin ?? b.pin, ownerId: a.pin ? a.ownerId : b.ownerId, ownerName: a.pin ? a.ownerName : b.ownerName };
  return [...notes.slice(0, i - 1), merged, ...notes.slice(i + 1)];
}

const spot = (x: number, y: number) => {
  const v = y < 0.33 ? "top" : y > 0.66 ? "bottom" : "middle";
  const h = x < 0.33 ? "left" : x > 0.66 ? "right" : "center";
  return v === "middle" && h === "center" ? "center" : `${v} ${h}`;
};

/** Where a note is pinned, in words: "Login, top left". */
export function pinWords(n: RecordNote) {
  if (!n.pin) return null;
  const t = n.pin.target;
  return `${t.label}, ${spot(n.pin.x, n.pin.y)}${t.page ? ` · ${t.page}` : ""}`;
}

function Note({ n, i, brain, onText, onMerge, onDelete }: { n: RecordNote; i: number; brain: string; onText: (t: string) => void; onMerge: (() => void) | null; onDelete: () => void }) {
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
        <textarea ref={ta} value={n.text} rows={1} aria-label={`Note ${i + 1}`} onChange={(e) => onText(e.target.value)} />
        <div className="rt-meta">
          <span className="rt-where">{where ?? "Not pinned to anything"}</span>
          <span className={`rt-to ${n.ownerName ? "agent" : ""}`}>{n.ownerName ? `Goes to ${n.ownerName}` : `${brain} decides who gets it`}</span>
        </div>
      </div>
      <div className="rt-acts">
        {onMerge && (
          <button type="button" onClick={onMerge} title="Join with the note above" aria-label={`Join note ${i + 1} with the one above`}>
            Join up
          </button>
        )}
        <button type="button" className="del" onClick={onDelete} title="Delete this note" aria-label={`Delete note ${i + 1}`}>
          Delete
        </button>
      </div>
    </li>
  );
}

export function RecordTidy({ notes, brain, busy, error, onChange, onSend, onDiscard }: { notes: RecordNote[]; brain: string; busy: boolean; error?: string | null; onChange: (n: RecordNote[]) => void; onSend: () => void; onDiscard: () => void }) {
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
