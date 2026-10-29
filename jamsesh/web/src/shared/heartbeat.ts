// Tells the Mac app this page is still running. The app reloads a window whose page goes quiet
// (a page stuck in a loop can't run this timer, which is the point). Only does anything inside
// the app, where Tauri's bridge exists.

export const HEARTBEAT_EVENT = "jamsesh-heartbeat";
export const HEARTBEAT_MS = 3000;

interface Bridge {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  metadata?: { currentWindow?: { label?: string } };
}

/** Starts the heartbeat; returns a function that stops it. A no-op outside the Mac app. */
export function startHeartbeat(bridge: Bridge | undefined = (globalThis as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__, every = HEARTBEAT_MS): () => void {
  const label = bridge?.metadata?.currentWindow?.label;
  if (!bridge || !label) return () => {};
  const beat = () => {
    try {
      // Tauri's own event channel; the app grants remote pages only this one call (capabilities/remote.json).
      bridge.invoke("plugin:event|emit", { event: HEARTBEAT_EVENT, payload: { label } }).catch(() => {});
    } catch {}
  };
  beat();
  const timer = setInterval(beat, every);
  return () => clearInterval(timer);
}
