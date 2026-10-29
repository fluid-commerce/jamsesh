import { api } from "./hub";

// A person's voice lives only on the host that learned it: nothing is kept on the device or taken to other hosts.

/**
 * Tells the host this person starts the join read, so the room's copies of it stay out of the transcript.
 * Never queued for later: it throws when the host didn't take it, and then the read mustn't start.
 * Returns the host's reset epoch, which the recording is sent with (a Reset during the read makes it stale).
 */
export const beginRead = (personId: string) => api<{ epoch: number }>(`/people/${personId}/voice/start`, {}, "POST", { queue: false }).then((r) => r.epoch);

/**
 * The read stopped without the host getting it (no microphone, a failed upload): the host stops keeping
 * the room's script-like lines out. `read`: something was said aloud, so copies on their way still are, briefly.
 */
export const endRead = (personId: string, read: boolean) => api(`/people/${personId}/voice/end`, { read }, "POST", { queue: false }).catch(() => {});
