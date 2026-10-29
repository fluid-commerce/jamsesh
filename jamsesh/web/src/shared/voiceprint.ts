import { api } from "./hub";

// A person's voice lives only on the host that learned it: nothing is kept on the device or taken to other hosts.

/** Earlier builds kept a copy of a voice, and whether to take it to other hosts, in the browser: those go. */
const OLD_COPIES = /^jamsesh\.(voiceprint|voiceCarry)(\.|:|$)/;

/**
 * Deletes what earlier builds kept of a voice in this browser, then reads the storage again. Returns the keys
 * deleted and the keys still there (a removeItem that threw or did nothing). Throws when the storage can't be read.
 */
export function forgetDeviceCopies(storage: Pick<Storage, "key" | "length" | "removeItem">): { removed: string[]; left: string[] } {
  const find = () => {
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && OLD_COPIES.test(k)) old.push(k);
    }
    return old;
  };
  const old = find();
  for (const k of old) {
    try {
      storage.removeItem(k);
    } catch {
      // Read back below.
    }
  }
  const left = find();
  return { removed: old.filter((k) => !left.includes(k)), left };
}

const BLOCKED = "This browser's storage is blocked, so a voice copy an earlier version may have kept here couldn't be checked. JamSesh will try again.";

/**
 * Whether this browser may still hold an earlier build's copy of a voice, as a sentence to show, or null when it
 * holds none. Tries the deletion again each time it's asked, so a copy is gone as soon as storage lets it go.
 * Blocked storage isn't taken as empty: it could hold a copy that can't be seen now.
 */
export function deviceCopiesProblem(get: () => Pick<Storage, "key" | "length" | "removeItem"> | undefined = () => (typeof localStorage === "undefined" ? undefined : localStorage)): string | null {
  try {
    const storage = get();
    if (!storage) return null;
    const { left } = forgetDeviceCopies(storage);
    return left.length ? `An earlier version kept a copy of a voice in this browser and it couldn't be deleted (${left.join(", ")}). Clear this site's data in the browser to remove it.` : null;
  } catch {
    return BLOCKED;
  }
}

// At load: deleted now; anything left is shown on the profile (deviceCopiesProblem), which tries again.
deviceCopiesProblem();

/**
 * Tells the host this person starts the join read, so the room's copies of it stay out of the transcript.
 * Never queued for later: it throws when the host didn't take it, and then the read mustn't start.
 * Returns the host's reset epoch, which the recording is sent with (a Reset during the read makes it stale), and the
 * read's id, which its end and its recording carry (the host closes or takes only that read).
 */
export const beginRead = (personId: string) => api<{ epoch: number; read: string }>(`/people/${personId}/voice/start`, {}, "POST", { queue: false }).then((r) => ({ epoch: r.epoch, read: r.read }));

/**
 * The read stopped without the host getting it (no microphone, a failed upload): the host stops keeping
 * the room's script-like lines out. `read`: something was said aloud, so copies on their way still are, briefly.
 */
export const endRead = (personId: string, id: string, read: boolean) => api(`/people/${personId}/voice/end`, { read, id }, "POST", { queue: false }).catch(() => {});
