// Your voiceprint travels with you. The device keeps a copy of the numbers that describe your voice
// (never a recording), and with your say-so offers them to each room you join, so a new host knows
// you from the first line. In the Mac app the app keeps the copy for you on this Mac, so it goes to
// every host you join. A browser's storage belongs to the host's address, so there it is for this host only.
import { useEffect, useState } from "react";
import { api } from "./hub";
import { currentHostKey } from "./identity";
import type { Person } from "./hub";

export interface Carried {
  model: string;
  dim: number;
  samples: { kind: string; embedding: number[] }[];
  /** The host's digest of the voiceprint when this copy was taken, and when it last learned something. */
  version?: string;
  updatedAt?: number;
  /** The host this copy was taken from (its host key). */
  host?: string;
  /** That host's seal: after a reset there, it takes back only a copy it sealed since. */
  stamp?: unknown;
}

/** Where one person's copy and their yes or no live. */
interface CopyStore {
  consent(): Promise<boolean | null>;
  setConsent(on: boolean): Promise<void>;
  get(): Promise<Carried | null>;
  put(copy: Carried): Promise<void>;
  /** The whole copy, to send to this host (the Mac app asks the person first, once per host), or null. */
  share(): Promise<Carried | null>;
  /** Deletes the copy, keeping the choice (their voice was reset on a host). */
  forget(): Promise<void>;
}

interface Bridge {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
}
const bridge = () => (globalThis as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;

/**
 * The Mac app keeps one copy, for the app's own person, under the Mac user's app data. It asks the host
 * which person this window is and refuses a page that says it's someone else. The page sees the copy's
 * samples only once the person said Share to this host in the app's dialog.
 */
function appStore(b: Bridge, personId: string): CopyStore {
  const get = () => b.invoke("voiceprint_get", { personId }) as Promise<{ consent: boolean | null; copy: Carried | null }>;
  return {
    consent: async () => (await get()).consent,
    setConsent: async (on) => void (await b.invoke("voiceprint_consent", { personId, on })),
    get: async () => (await get()).copy,
    put: async (copy) => void (await b.invoke("voiceprint_put", { personId, copy })),
    share: () => b.invoke("voiceprint_share", { personId }) as Promise<Carried | null>,
    forget: async () => void (await b.invoke("voiceprint_forget", { personId })),
  };
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
/** Saving isn't allowed to fail quietly either: a "no" that wasn't kept would let a later sync make a copy. */
function write(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error("this browser didn't keep it");
}
/** Clears an old key nobody reads any more; a failure there only means it stays unused. */
function drop(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
/** Deleting is not allowed to fail quietly: a copy that stays can bring a forgotten voice back. */
function erase(key: string) {
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error("this browser kept the copy");
}

/** A browser keeps a copy and a choice per person: two people on one browser never share either. */
function browserStore(personId: string): CopyStore {
  const copyKey = `jamsesh.voiceprint.v2::${personId}`;
  const consentKey = `jamsesh.voiceCarry.v2::${personId}`;
  // Copies from before they were kept per person could be anyone's: never use them.
  drop("jamsesh.voiceprint.v1");
  drop("jamsesh.voiceCarry");
  return {
    consent: async () => read<boolean>(consentKey),
    setConsent: async (on) => {
      // The copy goes first: a "no" whose copy stayed would be no at all.
      if (!on) erase(copyKey);
      write(consentKey, on);
    },
    get: async () => read<Carried>(copyKey),
    put: async (copy) => write(copyKey, copy),
    // Already this host's: a browser's copy never leaves the host's own address.
    share: async () => read<Carried>(copyKey),
    forget: async () => erase(copyKey),
  };
}

/** Whether the copy goes with the person to other hosts (the Mac app) or stays for this host (a browser). */
export const carriesToOtherHosts = () => !!bridge();

const storeFor = (personId: string): CopyStore => {
  const b = bridge();
  return b ? appStore(b, personId) : browserStore(personId);
};

const quiet = async <T,>(p: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p();
  } catch {
    return fallback;
  }
};

/** What this person said about keeping their voice: yes, no, or nothing yet. */
export const carryChoice = (personId: string) => quiet(() => storeFor(personId).consent(), null);
/** Off until they say so. */
export const carryAllowed = async (personId: string) => (await carryChoice(personId)) === true;
/** Saying no forgets the copy. Throws when the choice couldn't be saved, so the checkbox can say so. */
export const setCarryAllowed = (personId: string, on: boolean) => storeFor(personId).setConsent(on);
/** Their voice was reset: this device's copy goes too, so it can't bring the old voice back. Throws when it couldn't be deleted. */
export const forgetCopy = (personId: string) => storeFor(personId).forget();
export const localCopy = (personId: string) => quiet(() => storeFor(personId).get(), null);

const tagged = (c: Carried, here: string): Carried => ({ ...c, host: here || c.host });

/** Takes the host's copy onto this device; throws when it couldn't be fetched or kept. False: the host has none. */
async function takeHostCopy(personId: string, here: string): Promise<boolean> {
  const c = await api<Carried>(`/people/${personId}/voiceprint`);
  if (!c?.samples?.length) return false;
  await storeFor(personId).put(tagged(c, here));
  return true;
}

/** Takes the host's copy of the person's voiceprint onto this device, when it can (a best effort for the profile). */
export async function pullCopy(personId: string, here = currentHostKey()): Promise<boolean> {
  try {
    return await takeHostCopy(personId, here);
  } catch {
    return false;
  }
}

/**
 * Offers this device's copy to the host, if the person agrees, then keeps what the host holds now (its copy and
 * its version). The host refuses a copy after the person's voice was reset there: one it sealed before the reset
 * is stale and is deleted here (and a failure to delete is thrown, never hidden); one from another host just
 * isn't taken. Throws on a failure worth trying again (offline, the host not answering).
 */
export async function pushCopy(personId: string, here = currentHostKey()): Promise<boolean> {
  const c = await storeFor(personId).share();
  if (!c?.samples?.length) return false;
  let r: { ok?: boolean };
  try {
    r = await api<{ ok?: boolean }>(`/people/${personId}/voiceprint`, { model: c.model, dim: c.dim, samples: c.samples, updatedAt: c.updatedAt, stamp: c.stamp }, "PUT", { queue: false });
  } catch (e) {
    const err = e as { status?: number; body?: { reset?: boolean; stale?: boolean } };
    if (err.status !== 409 || !err.body?.reset) throw e;
    if (err.body.stale) await forgetCopy(personId);
    return false;
  }
  if (!r?.ok) return false;
  // The host took it: the device keeps what the host holds now. If that fails the sync isn't done (it throws).
  await takeHostCopy(personId, here);
  return true;
}

/**
 * On joining, settles which copy is newer. A copy taken from this same host is replaced when the host's
 * version has changed (the device learns nothing by itself). A copy from another host and this host's own
 * voiceprint: whichever learned something last wins, so a newer copy is never replaced by an older one. A
 * host that knows nothing gets the device's copy; a device with nothing takes the host's.
 */
export async function syncVoiceprint(me: Pick<Person, "id">, here = currentHostKey()) {
  if (!(await carryAllowed(me.id))) return;
  const copy = await localCopy(me.id);
  // A failure here is thrown: the sync isn't settled, and is tried again.
  const host = await api<Carried>(`/people/${me.id}/voiceprint`);
  const hostHas = !!host?.samples?.length;
  if (!copy) return void (hostHas && (await storeFor(me.id).put(tagged(host, here))));
  if (!hostHas) return void (await pushCopy(me.id, here));
  if (here && copy.host === here) {
    if (copy.version !== host.version) await storeFor(me.id).put(tagged(host, here));
  } else if ((copy.updatedAt ?? 0) > (host.updatedAt ?? 0)) await pushCopy(me.id, here);
  else await storeFor(me.id).put(tagged(host, here));
}

/**
 * Tells the host this person starts the join read, so the room's copies of it stay out of the transcript.
 * Never queued for later: it throws when the host didn't take it, and then the read mustn't start.
 */
export const beginRead = (personId: string) => api(`/people/${personId}/voice/start`, {}, "POST", { queue: false });

/**
 * The read stopped without the host getting it (no microphone, a failed upload): the host stops keeping
 * the room's script-like lines out. `read`: something was said aloud, so copies on their way still are, briefly.
 */
export const endRead = (personId: string, read: boolean) => api(`/people/${personId}/voice/end`, { read }, "POST", { queue: false }).catch(() => {});

/**
 * Runs the sync once this window is acknowledged as the person (`registered`, the person id the host bound it
 * to), so the host never answers "not yours" to a window it hasn't bound yet. `ready` turns true once a try
 * finished either way (the join read isn't held up); a failed try is made again on reconnect (`connected`), and
 * `problem` says what went wrong when it's the person's to know (a stale copy that couldn't be deleted).
 */
export function useVoiceprintSync(me: Pick<Person, "id"> | undefined, registered: string | null, connected = true) {
  const [tried, setTried] = useState<string | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const id = me?.id;
  useEffect(() => {
    if (!me || registered !== me.id || synced === me.id || !connected) return;
    let live = true;
    syncVoiceprint(me)
      .then(
        () => live && (setSynced(me.id), setProblem("")),
        (e) => live && setProblem(`Your voice isn't synced with this host yet: ${(e as Error)?.message ?? e}`),
      )
      .finally(() => live && setTried(me.id));
    return () => void (live = false);
  }, [id, registered, connected, synced]);
  return { ready: !!me && tried === me.id, problem };
}
