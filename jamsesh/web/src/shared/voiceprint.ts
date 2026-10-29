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
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or full storage: the copy simply isn't kept */
  }
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
  write("jamsesh.voiceprint.v1", null);
  write("jamsesh.voiceCarry", null);
  return {
    consent: async () => read<boolean>(consentKey),
    setConsent: async (on) => {
      write(consentKey, on);
      if (!on) erase(copyKey);
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

/** Takes the host's copy of the person's voiceprint onto this device. */
export async function pullCopy(personId: string, here = currentHostKey()): Promise<boolean> {
  try {
    const c = await api<Carried>(`/people/${personId}/voiceprint`);
    if (!c?.samples?.length) return false;
    await storeFor(personId).put(tagged(c, here));
    return true;
  } catch {
    return false;
  }
}

/** Offers this device's copy to the host, if the person agrees, then keeps what the host holds now (its copy and its version). */
export async function pushCopy(personId: string, here = currentHostKey()): Promise<boolean> {
  const c = await quiet(() => storeFor(personId).share(), null);
  if (!c?.samples?.length) return false;
  try {
    const r = await api<{ ok?: boolean }>(`/people/${personId}/voiceprint`, { model: c.model, dim: c.dim, samples: c.samples, updatedAt: c.updatedAt }, "PUT");
    if (!r?.ok) return false;
    await pullCopy(personId, here);
    return true;
  } catch (e) {
    // Made before they reset their voice on this host: it must not come back, here or anywhere.
    if ((e as { status?: number }).status === 409) await forgetCopy(personId).catch(() => {});
    return false;
  }
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
  let host: Carried;
  try {
    host = await api<Carried>(`/people/${me.id}/voiceprint`);
  } catch {
    return;
  }
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

/** Runs the sync once per person on this host; `ready` is false until it has settled (so the join read isn't asked first). */
export function useVoiceprintSync(me: Pick<Person, "id"> | undefined) {
  const [done, setDone] = useState<string | null>(null);
  const id = me?.id;
  useEffect(() => {
    if (!me || done === me.id) return;
    let live = true;
    syncVoiceprint(me).finally(() => live && setDone(me.id));
    return () => void (live = false);
    // Only a new person starts a sync.
  }, [id]);
  return !!me && done === me.id;
}
