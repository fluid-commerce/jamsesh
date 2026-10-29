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

/** What the hub says a recording is. The page treats one as ended only when this (or a close's answer) says so, never from an error or a missing entry. */
export type RecStatus = { state: "live" | "ending" | "ended"; outcome?: { kind: string; result?: unknown } };

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tries a call a few times with backoff. A 4xx is the hub's answer and is not retried. */
async function attempt<T>(call: () => Promise<T>, tries: number, wait: (ms: number) => Promise<void>): Promise<T> {
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
  throw last;
}
const fromOutcome = <R,>(o: RecStatus["outcome"]): { ended: true; result?: R } => (o?.kind === "stop" && o.result ? { ended: true, result: o.result as R } : { ended: true });

/**
 * Closes a recording and returns only once the hub says it ended. Stop is sent (and resent: the hub answers a repeat with the first
 * answer). If it can't be confirmed, the hub is asked where the recording stands; whatever it finished with, notes included, is returned.
 * A recording the hub still has live is cancelled by its token, retried the same way. If nothing is acknowledged the recording may still
 * be running and `ended` is false, so the page keeps its id.
 */
export async function closeRecording<R>(io: { stop: () => Promise<R>; status: () => Promise<RecStatus>; cancel: () => Promise<RecStatus> }, wait = pause): Promise<{ ended: true; result?: R } | { ended: false; error: unknown }> {
  let error: unknown;
  try {
    return { ended: true, result: await attempt(io.stop, 4, wait) };
  } catch (e) {
    error = e;
  }
  for (let polls = 0; polls < 5; polls++) {
    let st: RecStatus | null = null;
    try {
      st = await attempt(io.status, 3, wait);
    } catch (e) {
      error = e;
    }
    if (st?.state === "ended") return fromOutcome<R>(st.outcome);
    // Another close is under way: give it a moment, then ask again.
    if (st?.state === "ending") {
      await wait(1000);
      continue;
    }
    try {
      const done = await attempt(io.cancel, 3, wait);
      if (done.state === "ended") return fromOutcome<R>(done.outcome);
    } catch (e) {
      error = e;
    }
    break;
  }
  return { ended: false, error };
}

/**
 * Recordings a page let go of (it unmounted or closed mid-recording). Each is asked after until the hub says it ended, and cancelled
 * by its token if it is still live: so a close that never arrived is made good the next time any Record button is mounted.
 */
export async function reapOrphans(orphans: Map<string, { token: string }>, io: { status: (id: string) => Promise<RecStatus>; cancel: (token: string) => Promise<RecStatus> }) {
  for (const [id, o] of [...orphans]) {
    try {
      let st = await io.status(id);
      if (st.state !== "ended") st = await io.cancel(o.token);
      if (st.state === "ended") orphans.delete(id);
    } catch {}
  }
}

/**
 * What a Record button must do when it goes away: hand a recording it owns (live, or still waiting on its Stop) or a Start still in flight
 * to the hub by token, remember an owned one to be asked after, and give back a mic it switched on for the recording.
 */
export function leaveActions(own: { id: string; token: string } | null, pendingToken: string | null, micWasOff: boolean): { cancel?: { token: string; orphanId?: string }; restoreMic: boolean } {
  const token = own?.token ?? pendingToken;
  return { ...(token ? { cancel: { token, ...(own ? { orphanId: own.id } : {}) } } : {}), restoreMic: micWasOff && !!token };
}

/**
 * The notes a Send carries: the exact set first submitted, if there was one, so a send tried again after an uncertain failure says the
 * same thing (the hub refuses a changed one); otherwise what is on screen now, without the empty ones.
 */
export function notesToSend(review: { notes: RecordNote[]; submitted?: RecordNote[] }): RecordNote[] {
  return review.submitted ?? review.notes.filter((n) => n.text.trim());
}

/** What the pointer recorder made of the gesture, or nothing if it can't be read: the recording still ends, with the words alone. */
export async function pointerOrNone<P>(read: () => Promise<P[]>): Promise<P[]> {
  try {
    const marks = await read();
    return Array.isArray(marks) ? marks : [];
  } catch {
    return [];
  }
}
