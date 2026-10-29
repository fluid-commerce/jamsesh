// The hub's in-process event bus. WebSocket clients subscribe to it; collection
// changes are coalesced so a burst of writes sends one patch per collection.
import type { BusMessage } from "./types";

type Listener = (msg: BusMessage) => void;

class Bus {
  private listeners = new Set<Listener>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by the hub: builds the current value for a changed key. */
  resolver: ((key: string) => { key: any; value: any } | null) | null = null;

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: BusMessage) {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch (e) {
        console.error("bus listener failed", e);
      }
    }
  }

  /** For tests: forget what is waiting to be sent, so one fixture's leftovers don't reach the next one. */
  reset() {
    this.dirty.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  changed(key: string) {
    this.dirty.add(key);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  private flush() {
    this.flushTimer = null;
    const keys = [...this.dirty];
    this.dirty.clear();
    // The counts of what the state leaves out travel with the lists they count.
    if (keys.some((k) => k === "directives" || k === "artifacts" || k === "utterances") && !keys.includes("totals")) keys.push("totals");
    // A screen's tiles follow the artifacts (the board shows the newest).
    if (keys.includes("artifacts") && !keys.includes("stageTiles")) keys.push("stageTiles");
    for (const k of keys) {
      // One collection that can't be read (a store error) doesn't stop the others' patches.
      let patch: ReturnType<NonNullable<Bus["resolver"]>> = null;
      try {
        patch = this.resolver?.(k) ?? null;
      } catch (e) {
        console.error(`bus: couldn't read ${k}`, e);
      }
      if (patch) this.send({ type: "patch", key: patch.key, value: patch.value });
    }
  }
}

export const bus = new Bus();
