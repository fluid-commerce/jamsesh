// Your voiceprint travels with you. This device keeps a copy of the numbers that describe your voice
// (never a recording), and with your say-so offers them to each room you join, so a new host knows
// you from the first line. The copy belongs to the browser or the Mac app's profile, not to a host.
import { useEffect, useState } from "react";
import { api } from "./hub";
import type { Person } from "./hub";

const KEY = "jamsesh.voiceprint.v1";
const CONSENT = "jamsesh.voiceCarry";

export interface Carried {
  model: string;
  dim: number;
  samples: { kind: string; embedding: number[] }[];
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
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or full storage: the copy simply isn't kept */
  }
}

/** What this person said about bringing their voice to other rooms: yes, no, or nothing yet. */
export const carryChoice = () => read<boolean>(CONSENT);
/** Off until they say so. */
export const carryAllowed = () => carryChoice() === true;
export function setCarryAllowed(on: boolean) {
  write(CONSENT, on);
  if (!on) forgetCopy();
}

export const localCopy = () => read<Carried>(KEY);
export function forgetCopy() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to remove */
  }
}

/** Takes this device's copy from the host that has just learned more of the person's voice. */
export async function pullCopy(personId: string): Promise<boolean> {
  try {
    const c = await api<Carried>(`/people/${personId}/voiceprint`);
    if (!c?.samples?.length) return false;
    write(KEY, c);
    return true;
  } catch {
    return false;
  }
}

/** Offers this device's copy to the host the person has just joined. */
export async function pushCopy(personId: string): Promise<boolean> {
  const c = localCopy();
  if (!c) return false;
  try {
    const r = await api<{ ok?: boolean }>(`/people/${personId}/voiceprint`, c, "PUT");
    return !!r?.ok;
  } catch {
    return false;
  }
}

/**
 * On joining: a host that doesn't know this voice gets the device's copy; a host that has learned
 * more than the copy holds gives its newer one back. Returns once the question is settled.
 */
export async function syncVoiceprint(me: Pick<Person, "id" | "voiceSamples">) {
  if (!carryAllowed()) return;
  const copy = localCopy();
  if (!copy) {
    if (me.voiceSamples > 0) await pullCopy(me.id);
    return;
  }
  if (me.voiceSamples === 0) await pushCopy(me.id);
  else if (me.voiceSamples !== copy.samples.length) await pullCopy(me.id);
}

/** Runs the sync once per person on this host; `ready` is false until it has settled (so the join read isn't asked first). */
export function useVoiceprintSync(me: Pick<Person, "id" | "voiceSamples"> | undefined) {
  const [done, setDone] = useState<string | null>(null);
  const id = me?.id;
  useEffect(() => {
    if (!me || done === me.id) return;
    let live = true;
    syncVoiceprint(me).finally(() => live && setDone(me.id));
    return () => void (live = false);
    // Only a new person starts a sync; the sample count changing underneath it is the sync's own doing.
  }, [id]);
  return !!me && done === me.id;
}
