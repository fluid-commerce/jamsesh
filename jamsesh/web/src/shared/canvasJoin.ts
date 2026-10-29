// A person's canvas (FigCraft's web build in an iframe) and how its join is going: the page reads
// the canvas's own session state through `window.figcraft`, shows it, and rejoins when it fails.
// Also: fonts from this Mac for families the canvas lacks (the Mac app reads them; fonts.rs).

export type JoinState =
  /** The canvas page hasn't started yet. */
  | { state: "loading" }
  | { state: "connecting" }
  | { state: "live" }
  | { state: "reconnecting"; reason: string | null }
  | { state: "failed"; reason: string }
  /** The host published the canvas again: this one's link is old. */
  | { state: "stale" };

/** The join state from the canvas's `collab.peers` (the open file's session, plus every session the canvas has). */
export function joinStateOf(peers: any): JoinState {
  const status = peers?.status;
  if (status === "live") return { state: "live" };
  if (status === "connecting") return { state: "connecting" };
  if (status === "reconnecting") return { state: "reconnecting", reason: peers?.reason ?? null };
  if (status === "failed") return { state: "failed", reason: peers?.reason || "The canvas session failed." };
  // Off: the open file isn't in a session. A join on its way, or one that failed, is in `sessions`.
  const sessions: any[] = Array.isArray(peers?.sessions) ? peers.sessions : [];
  if (sessions.some((s) => s?.status === "live")) return { state: "live" };
  if (sessions.some((s) => s?.status === "connecting" || s?.status === "reconnecting")) return { state: "connecting" };
  const failed = sessions.find((s) => s?.status === "failed");
  if (failed) return { state: "failed", reason: failed.reason || "The canvas couldn't join the session." };
  return { state: "failed", reason: "The canvas isn't in the session." };
}

/** How long a canvas may take to start, and to get through connecting, before it counts as failed. */
export const START_TIMEOUT_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 25_000;

/** How long one `collab.peers` read may take, and how many failed reads in a row make a failed join. */
export const POLL_TIMEOUT_MS = 4000;
export const POLL_FAILURES = 2;

/**
 * Reads the canvas's join one read at a time. A read that rejects or doesn't answer in time is a
 * failed poll; a few in a row are a failed join, which the caller rejoins (with a new canvas and a new
 * watch). A read that timed out is abandoned: its late answer doesn't count, and no new read goes to
 * this canvas on top of it, so a hung canvas never piles up calls.
 */
export class JoinWatch {
  private reading = false;
  private abandoned: Promise<void> | null = null;
  private misses = 0;
  constructor(private timeoutMs = POLL_TIMEOUT_MS) {}

  /** The join state now, or null when there's nothing new (a read still running, or a single miss). */
  async poll(fc: Fc): Promise<JoinState | null> {
    if (this.reading) return null;
    if (this.abandoned) return this.miss();
    this.reading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A bridge that throws instead of rejecting is a failed read too.
      let call: Promise<any>;
      try {
        call = Promise.resolve(fc.execute("collab.peers", {}));
      } catch {
        return this.miss();
      }
      const late = new Promise<typeof MISSED>((r) => (timer = setTimeout(() => r(MISSED), this.timeoutMs)));
      const peers = await Promise.race([call, late]).catch(() => FAILED);
      if (peers === MISSED) {
        const gone: Promise<void> = call.then(
          () => {},
          () => {},
        ).then(() => {
          if (this.abandoned === gone) this.abandoned = null;
        });
        this.abandoned = gone;
      }
      if (peers === MISSED || peers === FAILED) return this.miss();
      this.misses = 0;
      return joinStateOf(peers);
    } finally {
      clearTimeout(timer);
      this.reading = false;
    }
  }

  private miss(): JoinState | null {
    return ++this.misses >= POLL_FAILURES ? { state: "failed", reason: "The canvas stopped answering." } : null;
  }
}
const FAILED = Symbol("failed");
const MISSED = Symbol("missed");

/** The wait before rejoining by itself after the `n`th failure in a row (0-based): 3 s, 6 s, 12 s, then 30 s. */
export function rejoinDelay(n: number) {
  return Math.min(30_000, 3000 * 2 ** Math.max(0, n));
}

/**
 * The automatic rejoin: a failed join schedules one (backing off with each failure in a row); a join
 * that is live again cancels it, so a canvas that recovered by itself isn't reloaded.
 */
export class RejoinTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the scheduled rejoin happens, for the card's countdown; null when none is scheduled. */
  at: number | null = null;
  constructor(
    private failures: { current: number },
    private fire: () => void,
  ) {}

  /** After each reading of the join. Returns when the next rejoin happens, or null. */
  update(j: JoinState): number | null {
    if (j.state === "live") {
      this.failures.current = 0;
      this.cancel();
    } else if (j.state === "failed" && !this.timer) {
      const wait = rejoinDelay(this.failures.current);
      this.at = Date.now() + wait;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.at = null;
        this.failures.current += 1;
        this.fire();
      }, wait);
    }
    return this.at;
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.at = null;
  }
}

/** A join error as people should read it: a few plain reasons. The raw error stays for a tooltip. */
export function friendlyReason(raw: string | null | undefined): string {
  const r = String(raw ?? "");
  if (/pair|401|403|unauthori[sz]ed|forbidden|token/i.test(r)) return "This device isn't paired with the host.";
  if (/refused|unreachable|timed? ?out|network|econn|dns|resolve|didn't answer|offline|connection (lost|closed|reset|failed)/i.test(r)) return "Can't reach the host on the network.";
  if (/not found|404|gone|no such|isn't in the session|didn't start|ended|left|moved|restart|publish/i.test(r)) return "The host's canvas is restarting.";
  return "The connection to the host dropped.";
}

/** What the page bar says about a join that isn't live (null: nothing to say). Short: the reason,
 * when there is one, is on the card over the canvas. */
export function joinLabel(j: JoinState): string | null {
  switch (j.state) {
    case "live":
      return null;
    case "loading":
      return "Starting the canvas…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
    case "stale":
    case "failed":
      return "Reconnecting…";
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

/** The Mac app's command bridge, in its own windows only (a browser has none). */
export function macInvoke(): Invoke | null {
  const i = (window as any).__TAURI_INTERNALS__?.invoke;
  return typeof i === "function" ? i : null;
}

type Fc = { execute: (command: string, params?: unknown) => Promise<any> };

/** Families the canvas names that it has no font for. */
export async function missingFamilies(fc: Fc): Promise<string[]> {
  const r = await fc.execute("text.missingFonts", {});
  return (r?.families ?? []).map((f: any) => String(f.family ?? "")).filter(Boolean);
}

/** Which families a canvas is done asking the Mac for (loaded, or this Mac doesn't have them), and when to try again those whose load failed. */
export class FontTries {
  done = new Set<string>();
  private retry = new Map<string, { n: number; at: number }>();
  /** Whether to ask for a family now. */
  due(family: string, now = Date.now()) {
    const k = family.toLowerCase();
    return !this.done.has(k) && (this.retry.get(k)?.at ?? 0) <= now;
  }
  settle(family: string) {
    this.done.add(family.toLowerCase());
    this.retry.delete(family.toLowerCase());
  }
  /** A load that failed for a passing reason: ask again after 5 s, 10 s, 20 s … up to 5 minutes. */
  failed(family: string, now = Date.now()) {
    const k = family.toLowerCase();
    const n = (this.retry.get(k)?.n ?? 0) + 1;
    this.retry.set(k, { n, at: now + Math.min(300_000, 5000 * 2 ** (n - 1)) });
  }
}

/**
 * Loads into the canvas the fonts this Mac has for the families it lacks (the Mac app reads them from
 * its font folders; they go only into this canvas, for this session, and its text refits). A family
 * is asked for once it's loaded or the Mac turns out not to have it; a load that failed is tried again
 * with backoff. Returns the families still missing, which the canvas draws in a substitute.
 */
export async function loadLocalFonts(fc: Fc, invoke: Invoke | null, tries: FontTries): Promise<string[]> {
  const missing = await missingFamilies(fc);
  const ask = missing.filter((f) => tries.due(f));
  if (!invoke || !ask.length) return missing;
  let fonts: { family: string; data: string }[];
  try {
    fonts = await invoke("local_fonts", { families: ask });
    if (!Array.isArray(fonts)) throw new Error("no font list");
  } catch {
    for (const f of ask) tries.failed(f);
    return missing;
  }
  const have = new Map(fonts.map((f) => [String(f.family).toLowerCase(), f]));
  for (const family of ask) {
    const f = have.get(family.toLowerCase());
    if (!f) {
      tries.settle(family); // this Mac doesn't have it
      continue;
    }
    try {
      await fc.execute("text.loadFont", { data: f.data });
      tries.settle(family);
    } catch {
      tries.failed(family);
    }
  }
  return fonts.length ? missingFamilies(fc) : missing;
}
