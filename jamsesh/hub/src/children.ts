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
export function withParentWatch(cmd: string[], parentPid = process.pid): string[] {
  const script = [
    'parent=$1; shift',
    '"$@" &',
    "child=$!",
    "trap 'kill $child 2>/dev/null; wait $child 2>/dev/null; exit 0' TERM INT HUP",
    'while kill -0 $child 2>/dev/null && [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d \' \')" = "$parent" ]; do',
    "  sleep 1 & wait $!",
    "done",
    "if kill -0 $child 2>/dev/null; then kill $child 2>/dev/null; wait $child 2>/dev/null; exit 0; fi",
    "wait $child; exit $?",
  ].join("\n");
  return ["/bin/sh", "-c", script, "jamsesh-child", String(parentPid), ...cmd];
}

/**
 * Runs a helper the hub doesn't control the code of (whisper-server) so it ends the moment the hub
 * does, the way Parakeet's child watches its stdin: spawn the result with `stdin: "pipe"`. The hub
 * holds that pipe; when it closes (the hub exited, crashed or was killed outright) the wrapper stops
 * the helper. Stopping the wrapper (SIGTERM) stops the helper too, and a helper that ends on its own
 * ends the wrapper with its exit status.
 */
export function withStdinWatch(cmd: string[]): string[] {
  const script = [
    // A background job's stdin is /dev/null, so the watcher reads the hub's pipe through fd 3.
    "exec 3<&0",
    '"$@" </dev/null 3<&- &',
    "child=$!",
    // `read` is the shell's own, so stopping this watcher leaves no process behind.
    "(while read -r _; do :; done <&3; kill $child 2>/dev/null) &",
    "watch=$!",
    "exec 3<&-",
    "trap 'kill $child $watch 2>/dev/null; wait $child 2>/dev/null; exit 0' TERM INT HUP",
    "wait $child; code=$?",
    "kill $watch 2>/dev/null",
    "exit $code",
  ].join("\n");
  return ["/bin/sh", "-c", script, "jamsesh-child", ...cmd];
}

/** Stops a wrapped helper and waits for it. A helper still alive after the grace gets SIGKILL, so a hung one can't hold its port. */
export async function stopHelper(proc: { pid: number; exited: Promise<number>; kill(sig?: number | NodeJS.Signals): void }, graceMs = 2_000) {
  proc.kill();
  const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (done) return;
  // The wrapper is waiting on its helper: kill the helper and the wrapper's wait ends.
  Bun.spawnSync(["pkill", "-KILL", "-P", String(proc.pid)]);
  proc.kill("SIGKILL");
  await Promise.race([proc.exited, Bun.sleep(graceMs)]);
}
