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
  get active() {
    return this.at.size > 0;
  }
  on(f: () => void) {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }
}

export const pulses = new PulseStore();
