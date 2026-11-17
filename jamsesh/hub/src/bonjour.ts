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

/** A name fit for one TXT record entry: one line, no control characters, at most 40 characters; nothing when empty. */
export function txtName(name: string | null | undefined) {
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? [...clean].slice(0, 40).join("").trim() : undefined;
}

/**
 * The advertisers a gone hub left behind for this service and port: dns-sd processes macOS handed to launchd
 * (parent 1) when their hub exited. Builds before the parent watch never stopped them, and the network can hand out
 * their old details (no project) instead of the running hub's. One that still has a parent belongs to a live hub.
 * `ps` is `ps -axo pid=,ppid=,command=` output.
 */
export function leftoverAdverts(ps: string, service: string, port: number): number[] {
  const esc = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ours = new RegExp(`^/usr/bin/dns-sd -R .+ ${esc} local ${port}(\\s|$)`);
  const out: number[] = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && m[2] === "1" && ours.test(m[3])) out.push(Number(m[1]));
  }
  return out;
}

function stopLeftoverAdverts(port: number) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) return;
  for (const pid of leftoverAdverts(ps.stdout, SERVICE, port)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already, or not ours to stop: either way it isn't advertising for this hub.
    }
  }
}

/** Start (or restart with new details) the advertisement. */
export function advertise(port: number, txt: Record<string, string | undefined>) {
  stopAdvertising();
  if (process.platform !== "darwin") return;
  stopLeftoverAdverts(port);
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
