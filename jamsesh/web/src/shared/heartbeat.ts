// Tells the Mac app this page is still running. The app reloads a window whose page goes quiet
// (a page stuck in a loop can't run this timer, which is the point). Only does anything inside
// the app, where Tauri's bridge exists.

export const HEARTBEAT_MS = 3000;

interface Bridge {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  metadata?: { currentWindow?: { label?: string } };
}

/** Starts the heartbeat; returns a function that stops it. A no-op outside the Mac app. */
export function startHeartbeat(bridge: Bridge | undefined = (globalThis as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__, every = HEARTBEAT_MS): () => void {
  // The app knows which window is calling; the page doesn't say. Outside a Tauri window there is nothing to call.
  if (!bridge?.metadata?.currentWindow?.label) return () => {};
  const beat = () => {
    try {
      // The app's own command, allowed to the session windows in capabilities/session.json.
      bridge.invoke("heartbeat", {}).catch(() => {});
    } catch {}
  };
  beat();
  const timer = setInterval(beat, every);
  return () => clearInterval(timer);
}
