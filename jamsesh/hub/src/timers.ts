// Every timer a room owns lives here, so closing the room can end them all in one call. A callback never takes the
// hub down: an error is logged, and a write that finds the store sealed (the room is closing) is not an error at all.
type Handle = ReturnType<typeof setTimeout>;

export class Timers {
  private live = new Set<Handle>();
  /** Callbacks that returned a promise and haven't settled: closing the room waits for them (a timer job already running is work in flight). */
  private running = new Set<Promise<unknown>>();
  private closed = false;

  private run(fn: () => unknown) {
    const fail = (e: unknown) => {
      if ((e as NodeJS.ErrnoException)?.code === "ESEALED") return console.warn("timer: the room is closed; nothing was written");
      console.error("timer:", e instanceof Error ? e.message : e);
    };
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        const p = (r as Promise<unknown>).catch(fail);
        this.running.add(p);
        void p.finally(() => this.running.delete(p));
      }
    } catch (e) {
      fail(e);
    }
  }

  /** Runs `fn` once after `ms`. After `stop()` it does nothing and returns null. */
  after(fn: () => unknown, ms: number): Handle | null {
    if (this.closed) return null;
    const t: Handle = setTimeout(() => {
      this.live.delete(t);
      this.run(fn);
    }, ms);
    t.unref?.();
    this.live.add(t);
    return t;
  }

  every(fn: () => unknown, ms: number): Handle | null {
    if (this.closed) return null;
    const t: Handle = setInterval(() => this.run(fn), ms);
    t.unref?.();
    this.live.add(t);
    return t;
  }

  clear(t: Handle | null | undefined) {
    if (!t) return;
    clearTimeout(t);
    this.live.delete(t);
  }

  /** How many timer callbacks are still running (async ones). */
  get busy() {
    return this.running.size;
  }

  get size() {
    return this.live.size;
  }

  /** Ends every timer and refuses new ones: the first step of closing a room. */
  stop() {
    this.closed = true;
    for (const t of this.live) clearTimeout(t);
    this.live.clear();
  }
}
