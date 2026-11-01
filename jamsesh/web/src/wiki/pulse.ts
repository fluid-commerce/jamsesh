// Which pages an ingest has just touched, for the graph to pulse. Entries fade by themselves.
export const PULSE_MS = 2400;

export class PulseStore {
  private at = new Map<string, number>();
  private listeners = new Set<() => void>();
  add(slugs: string[], now = Date.now()) {
    if (!slugs.length) return;
    for (const s of slugs.slice(0, 60)) this.at.set(s, now);
    this.listeners.forEach((f) => f());
  }
  /** 0 when quiet, 1 at the moment of the touch, falling to 0 over PULSE_MS. */
  level(slug: string, now = Date.now()) {
    const t = this.at.get(slug);
    if (t === undefined) return 0;
    const k = 1 - (now - t) / PULSE_MS;
    if (k <= 0) return (this.at.delete(slug), 0);
    return k;
  }
  /** Whether any pulse is still running. Expired ones are dropped here, so a pulse for a page that is no longer drawn (deleted) can't keep the canvas waking. */
  active(now = Date.now()) {
    for (const [s, t] of this.at) if (now - t >= PULSE_MS) this.at.delete(s);
    return this.at.size > 0;
  }
  on(f: () => void) {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }
}

export const pulses = new PulseStore();
