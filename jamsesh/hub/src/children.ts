/**
 * Runs a helper (dns-sd, figcraft-server) so it can't outlive the hub. A shell stays between the
 * hub and the helper and stops the helper as soon as it is no longer the hub's child. That covers
 * the cases the hub can't clean up after itself: kill -9, a crash, the machine killing it for
 * memory. (Checking the hub's pid with `kill -0` isn't enough: a killed hub the parent hasn't
 * reaped yet is a zombie, and `kill -0` still succeeds on it. Re-parenting to launchd is immediate.)
 *
 * Returns the argv to spawn. Stopping the returned process (SIGTERM) stops the helper too, and the
 * wrapper exits only once the helper has (so its port is free); `stopHelper` covers a helper that ignores SIGTERM.
 */
export function withParentWatch(cmd: string[], parentPid = process.pid, graceMs = 3_000): string[] {
  const ticks = Math.max(1, Math.round(graceMs / 100));
  const script = [
    'parent=$1; shift',
    '"$@" <&0 &', // a backgrounded command would otherwise lose stdin (the MCP child reads it)
    "child=$!",
    // TERM first; a helper that ignores it gets KILL after the grace, so nothing the wrapper stops outlives it.
    `stop() { kill $child 2>/dev/null; i=0; while kill -0 $child 2>/dev/null && [ $i -lt ${ticks} ]; do sleep 0.1; i=$((i+1)); done; kill -0 $child 2>/dev/null && kill -9 $child 2>/dev/null; wait $child 2>/dev/null; }`,
    "trap 'stop; exit 0' TERM INT HUP",
    'while kill -0 $child 2>/dev/null && [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d \' \')" = "$parent" ]; do',
    "  sleep 1 & wait $!",
    "done",
    "if kill -0 $child 2>/dev/null; then stop; exit 0; fi",
    "wait $child; exit $?",
  ].join("\n");
  return ["/bin/sh", "-c", script, "jamsesh-child", String(parentPid), ...cmd];
}

/** Stops a wrapped helper and waits for it. A helper still alive after the grace gets SIGKILL, so a hung one can't hold its port. True only when its exit was observed; false if it is still running after the KILL. */
export async function stopHelper(proc: { pid: number; exited: Promise<number>; kill(sig?: number | NodeJS.Signals): void }, graceMs = 2_000): Promise<boolean> {
  const exited = (ms: number) => Promise.race([proc.exited.then(() => true, () => false), Bun.sleep(ms).then(() => false)]);
  proc.kill();
  if (await exited(graceMs)) return true;
  // The wrapper is waiting on its helper: kill the helper and the wrapper's wait ends.
  Bun.spawnSync(["pkill", "-KILL", "-P", String(proc.pid)]);
  proc.kill("SIGKILL");
  return exited(graceMs); // true only when the exit itself was seen
}

type Helper = { pid: number; exited: Promise<number>; kill(sig?: number | NodeJS.Signals): void };

/**
 * Every helper process a hub starts (canvas server, MCP participants, the key helper, whisper) is
 * tracked here, and stopping the hub walks this one list: a helper started without being tracked
 * is the only one that could be missed, so each spawn site goes through `track`.
 */
export class HelperRegistry {
  private procs = new Set<Helper>();

  /** Registers a spawned helper (started with withParentWatch) until it exits. */
  track<P extends Helper>(proc: P): P {
    this.procs.add(proc);
    proc.exited.then(
      () => this.procs.delete(proc),
      () => this.procs.delete(proc),
    );
    return proc;
  }

  get size() {
    return this.procs.size;
  }

  /** Stops every tracked helper (TERM, then KILL). True only when each one's exit was observed. */
  async stopAll(graceMs?: number): Promise<boolean> {
    const all = await Promise.all([...this.procs].map((p) => stopHelper(p, graceMs).catch(() => false)));
    return all.every(Boolean);
  }
}
