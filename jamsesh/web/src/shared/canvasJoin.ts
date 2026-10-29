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
  if (status === "failed") return { state: "failed", reason: peers?.reason || "The canvas lost the session." };
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

/** The wait before rejoining by itself after the `n`th failure in a row (0-based): 3 s, 6 s, 12 s, then 30 s. */
export function rejoinDelay(n: number) {
  return Math.min(30_000, 3000 * 2 ** Math.max(0, n));
}

/** What the page bar says about a join that isn't live (null: nothing to say). */
export function joinLabel(j: JoinState): string | null {
  switch (j.state) {
    case "live":
      return null;
    case "loading":
      return "Starting the canvas…";
    case "connecting":
      return "Connecting to the canvas…";
    case "reconnecting":
      return "Reconnecting to the canvas…";
    case "stale":
      return "The canvas moved; rejoining…";
    case "failed":
      return `Canvas disconnected: ${j.reason}`;
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

/**
 * Loads into the canvas the fonts this Mac has for the families it lacks, each family asked for
 * once (`tried`, per canvas): the Mac app reads them from its font folders and they go only into
 * this canvas, for this session (`text.loadFont`; its text refits). Returns the families still
 * missing, which the canvas draws in a substitute.
 */
export async function loadLocalFonts(fc: Fc, invoke: Invoke | null, tried: Set<string>): Promise<string[]> {
  const missing = await missingFamilies(fc);
  const ask = missing.filter((f) => !tried.has(f.toLowerCase()));
  if (!invoke || !ask.length) return missing;
  for (const f of ask) tried.add(f.toLowerCase());
  const fonts: { family: string; data: string }[] = await invoke("local_fonts", { families: ask }).catch(() => []);
  if (!Array.isArray(fonts) || !fonts.length) return missing;
  for (const f of fonts) await fc.execute("text.loadFont", { data: f.data }).catch(() => {});
  return missingFamilies(fc);
}
