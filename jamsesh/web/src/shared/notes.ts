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
  return `${t.label}, ${spot(n.pin.x, n.pin.y)}${t.page ? ` · ${t.page}` : ""}${n.screenId ? " · big screen" : ""}`;
}

/** Made by the page before it asks the hub to start a recording, so the page closing mid-request can still cancel it. */
export const newRecordToken = () => `rt_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * Sends a Stop until the hub confirms it. The hub answers a repeated Stop with the first answer, so trying again is safe. A refusal
 * (a 4xx) is final. When every try fails the recording is cancelled by its token instead, so it can't run on holding the screen.
 */
export async function stopWithRetry<T>(call: () => Promise<T>, cancel: () => Promise<unknown>, tries = 4, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await call();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (typeof status === "number" && status < 500) throw e;
      last = e;
      if (i < tries - 1) await wait(1000 * 2 ** i);
    }
  }
  await cancel().catch(() => {});
  throw last;
}

/** A recording that began after its page went away has nobody to stop it: closes it, sending the words alone. */
export function closeUnattended(post: (path: string, body: object) => Promise<unknown>, deviceId: string, personId: string | null, recordingId: string) {
  return post("/prompt-window", { deviceId, personId, recordingId, pointer: [] }).catch(() => {});
}
