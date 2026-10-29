// The page's calls for room fonts (roomFonts.ts has the logic). Fonts never go through the offline
// outbox (hub.ts NEVER_QUEUE): a font file is not saved on this laptop to be sent later.
import { api } from "./hub";
import { bytesToBase64 } from "./roomFonts";

/** One face of a font the room holds, base64, never cached to disk. */
export async function fetchRoomFace(key: string, n: number): Promise<string | null> {
  const r = await fetch(`/api/fonts/${encodeURIComponent(key)}/${n}`, { cache: "no-store", credentials: "same-origin" });
  return r.ok ? bytesToBase64(new Uint8Array(await r.arrayBuffer())) : null;
}

export const askRoomForFonts = (families: string[]) => api("/fonts/want", { families }, "POST", { queue: false });

export const lendFont = (family: string, files: string[]) => api("/fonts/lend", { family, files }, "POST", { queue: false, timeoutMs: 60_000 });
export const declineFont = (family: string) => api("/fonts/decline", { family }, "POST", { queue: false });
export const withdrawFont = (family: string) => api("/fonts/withdraw", { family }, "POST", { queue: false });
