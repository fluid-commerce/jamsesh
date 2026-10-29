// The pure side of the tidy list (6.2): joining notes, reading a pin in words, telling what a send did.
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
