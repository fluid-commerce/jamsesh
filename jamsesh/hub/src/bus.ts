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

  changed(key: string) {
    this.dirty.add(key);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  private flush() {
    this.flushTimer = null;
    const keys = [...this.dirty];
    this.dirty.clear();
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
