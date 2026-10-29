// Advertises the host on the local network (Bonjour) so the Mac app lists it under Join without
// anyone typing an address. Uses macOS's own dns-sd; elsewhere it does nothing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { withParentWatch } from "./children";

// Tests advertise under another name so they never show up in a real room's session list.
export const SERVICE = process.env.JAMSESH_BONJOUR_SERVICE || "_jamsesh._tcp";

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
  // dns-sd outlives a hub that's killed outright, advertising a host that's gone: it runs under
  // a watcher that ends it when this process is gone.
  const [bin, ...argv] = withParentWatch(["/usr/bin/dns-sd", "-R", computerName(), SERVICE, "local", String(port), ...record]);
  child = spawn(bin, argv, { stdio: "ignore" });
  child.on("error", () => (child = null));
}

export function stopAdvertising() {
  child?.kill();
  child = null;
}
