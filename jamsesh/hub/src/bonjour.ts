// Advertises the host on the local network (Bonjour) so the Mac app lists it under Join without
// anyone typing an address. Uses macOS's own dns-sd; elsewhere it does nothing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";

export const SERVICE = "_jamsesh._tcp";

let child: ChildProcess | null = null;

function computerName() {
  const r = spawnSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" });
  return (r.status === 0 && r.stdout.trim()) || hostname().replace(/\.local$/, "");
}

/** Start (or restart with new details) the advertisement. */
export function advertise(port: number, txt: Record<string, string | undefined>) {
  stopAdvertising();
  if (process.platform !== "darwin") return;
  const record = Object.entries(txt)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  // dns-sd outlives a hub that's killed outright, advertising a host that's gone. The wrapper
  // ends it as soon as this process is no longer alive.
  const args = ["-R", computerName(), SERVICE, "local", String(port), ...record].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  child = spawn("/bin/sh", ["-c", `/usr/bin/dns-sd ${args} >/dev/null & d=$!; while kill -0 ${process.pid} 2>/dev/null && kill -0 $d 2>/dev/null; do sleep 2; done; kill $d 2>/dev/null`], { stdio: "ignore" });
  child.on("error", () => (child = null));
}

export function stopAdvertising() {
  child?.kill();
  child = null;
}
