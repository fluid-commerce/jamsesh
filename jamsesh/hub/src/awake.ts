// Keeps the host awake while people are connected. macOS power assertions stack: holding
// our own (with `caffeinate`) never interferes with one something else already holds, and
// releasing ours never puts the machine to sleep if another app is keeping it awake.
import type { Subprocess } from "bun";

const GRACE_MS = 5 * 60_000;

export class KeepAwake {
  private proc: Subprocess | null = null;
  private lastActive = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private activeCount: () => number) {
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  get holding() {
    return !!this.proc;
  }

  tick() {
    if (process.platform !== "darwin") return;
    const now = Date.now();
    if (this.activeCount() > 0) this.lastActive = now;
    const want = now - this.lastActive < GRACE_MS && this.lastActive > 0;
    if (want && !this.proc) {
      // -d display (the big screen), -i idle sleep, -s system sleep on power; -w ties it to us.
      this.proc = Bun.spawn(["caffeinate", "-d", "-i", "-s", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
    } else if (!want && this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.proc?.kill();
    this.proc = null;
  }
}
