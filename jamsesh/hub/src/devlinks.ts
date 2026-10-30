// One-time dev-server sign-in. A person's device asks the hub for a link to a dev server; the link carries a code that works once,
// within about a minute, for that device only. Opening it makes the dev origin a cookie of its own (HttpOnly, SameSite=Strict, no
// Domain), then redirects to the same address without the code. The dev server itself never sees the code or any cookie of ours:
// `scrub` takes them out of every request (HTTP and WebSocket) before it is forwarded.
import { randomBytes } from "node:crypto";

const CODE_MS = 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const COOKIE = "jam_dev";
export const DEV_CODE_PARAM = "jam_code";

export class DevLinks {
  private codes = new Map<string, { device: string; until: number }>();
  private sessions = new Map<string, { device: string; until: number }>();
  /** Whether a device may still use the hub (set by the hub: paired and not revoked). */
  constructor(private active: (device: string) => boolean) {}

  /** A code for this device: single use, valid for about a minute. */
  mint(device: string, now = Date.now()): string {
    for (const [c, v] of this.codes) if (v.until < now) this.codes.delete(c);
    const code = randomBytes(24).toString("hex");
    this.codes.set(code, { device, until: now + CODE_MS });
    return code;
  }

  /** The device a code was made for, once: a second use, an expired code and an unknown one all give null. */
  redeem(code: string | null | undefined, now = Date.now()): string | null {
    const c = code ? this.codes.get(code) : undefined;
    if (!c) return null;
    this.codes.delete(code!);
    return c.until >= now && this.active(c.device) ? c.device : null;
  }

  /** A cookie value for a device that redeemed a code. */
  open(device: string, now = Date.now()): string {
    for (const [s, v] of this.sessions) if (v.until < now) this.sessions.delete(s);
    const id = randomBytes(24).toString("hex");
    this.sessions.set(id, { device, until: now + SESSION_MS });
    return id;
  }

  /** The device behind a dev cookie, while it is still active; null otherwise. */
  deviceOf(cookieValue: string | null | undefined, now = Date.now()): string | null {
    const s = cookieValue ? this.sessions.get(cookieValue) : undefined;
    if (!s || s.until < now) return null;
    return this.active(s.device) ? s.device : null;
  }

  /** The Set-Cookie for the dev origin: this origin only (no Domain), never readable by a page, never sent cross-site. */
  setCookie(session: string, secure: boolean): string {
    return `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
  }

  static readonly cookieName = COOKIE;
}

/** The address with the sign-in code (and any token) taken out. */
export function withoutCredentials(url: URL): string {
  const u = new URL(url);
  u.searchParams.delete(DEV_CODE_PARAM);
  u.searchParams.delete("token");
  return `${u.pathname}${u.search}`;
}

/** The headers a dev server may see: none of ours (paired-device token, window key, dev-sign-in cookie, bearer). */
export function scrubHeaders(headers: Headers) {
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+jst_/i.test(auth)) headers.delete("authorization");
  const cookie = headers.get("cookie");
  if (cookie) {
    const kept = cookie.split(/;\s*/).filter((c) => !/^(jam_token|jam_window|jam_dev)=/.test(c));
    if (kept.length) headers.set("cookie", kept.join("; "));
    else headers.delete("cookie");
  }
}

/**
 * A request that still carries a device token in its address (an old link): the browser is sent on to the clean address before anything
 * of the preview is served, so the token isn't left in `location` for the preview's scripts. Null when the address is clean.
 */
export function cleanRedirect(url: URL): Response | null {
  if (!url.searchParams.has("token")) return null;
  return new Response(null, { status: 302, headers: { location: withoutCredentials(url) || "/", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
