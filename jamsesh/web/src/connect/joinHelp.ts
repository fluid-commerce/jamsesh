// Where the join code is, and what a scanned QR code means. Pure, so it can be tested.

export interface Scanned {
  /** The room's address: scheme, host and port. */
  origin: string;
  /** The 4-character join code, or the 8-character invite code, when the QR code carried one. */
  code: string | null;
}

/** What a scanned QR code says about joining: the big screen's `<address>/connect?c=<code>`. Anything else is null. */
export function parseJoin(text: string): Scanned | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname.replace(/\/+$/, "") !== "/connect") return null;
  const raw = (url.searchParams.get("c") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return { origin: url.origin, code: raw.length === 4 || raw.length === 8 ? raw : null };
}

/**
 * Where a scanned code leads: this room ("here"), a host this device already knows ("known", followed
 * at once), or an address it doesn't ("ask": shown first, since anyone can print a QR code).
 */
export function scanGoes(s: Scanned, here: string, known: string[] = []): "here" | "known" | "ask" {
  if (s.origin === here) return "here";
  const origins = known.map((k) => {
    try {
      return new URL(k).origin;
    } catch {
      return "";
    }
  });
  return origins.includes(s.origin) ? "known" : "ask";
}

/** Why the camera didn't start, in words for the person holding the phone. */
export function cameraProblem(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is off. Allow it for JamSesh in your settings, or type the code instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Type the code instead.";
  if (name === "NotReadableError") return "Another app is using the camera. Close it and try again, or type the code instead.";
  return "The camera didn't start. Type the code instead.";
}

/** Whether this page may ask for the camera (browsers allow it only on https and localhost). */
export const canScan = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (typeof isSecureContext === "undefined" || isSecureContext);
