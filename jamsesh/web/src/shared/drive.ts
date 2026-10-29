// The seam between Record (6.2) and driving the big screen (6.1). Driving puts a person's dart on a
// screen; Record needs to know when someone is driving, which screen, and where their dart is.
// The driving code registers a bridge here; with none registered nobody is driving and Record
// stays on the person's own screen.
import { useSyncExternalStore } from "react";
import type { DartPoint } from "./pointer";

/** One position of a driver's dart: where on the screen, and what is under it. */
export interface DartSample extends DartPoint {
  driverId: string;
  /** 0..1 across the whole screen: where to draw the trail. */
  sx: number;
  sy: number;
}

export interface DriveBridge {
  /** The screen this person is driving right now, or null. */
  screen(): string | null;
  /** Called when the answer to `screen()` changes. */
  onChange(fn: () => void): () => void;
  /** Every driver's dart on a screen, theirs and (when driving together) the others'. */
  onDart(fn: (s: DartSample, screen: string) => void): () => void;
}

let bridge: DriveBridge | null = null;
const subs = new Set<() => void>();
let off: (() => void) | null = null;

export const drive = {
  set(b: DriveBridge | null) {
    off?.();
    bridge = b;
    off = b?.onChange(() => subs.forEach((f) => f())) ?? null;
    subs.forEach((f) => f());
  },
  get: () => bridge,
};

const sub = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** The big screen this window is driving, or null. */
export function useDriving(): string | null {
  return useSyncExternalStore(sub, () => bridge?.screen() ?? null);
}
