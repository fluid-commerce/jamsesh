// One gate for a test build beside the real app (SPEC "Run a test build beside the real app"). The Mac app sets
// JAMSESH_ISOLATED=1 and JAMSESH_APP_DATA for the hub it starts; this module then builds the hub's whole
// environment from JAMSESH_APP_DATA alone, and refuses to run if anything points at the real app.

import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The real app's ports: refused whether derived, saved or given. */
export const REAL_PORTS = [4790, 4747, 4848, 4949, 4443, 5100, 5101, 5102, 5103, 5104, 7979, 8178, 47900];

/** Variables that say where data, tools or helpers live, or which address to use. An isolated hub ignores all of them. */
export const LOCATION_VARS = [
  "JAMSESH_DATA",
  "JAMSESH_TEAM",
  "JAMSESH_HOME",
  "JAMSESH_FIGCRAFT_BIN_DIR",
  "JAMSESH_FIGCRAFT_PORT",
  "JAMSESH_DEV_PORT_START",
  "JAMSESH_WHISPER_PORT",
  "JAMSESH_WHISPER_MODEL",
  "JAMSESH_WHISPER_SERVER",
  "JAMSESH_PARAKEET_DIR",
  "JAMSESH_PUBLIC_URL",
  "JAMSESH_PUBLIC_HOST",
];

/**
 * The path with links and `..` resolved for the part that exists, then the rest. A `..` anywhere that can't be
 * resolved (a folder that doesn't exist) is refused: once made, it could lead anywhere.
 */
export function realish(p: string): string {
  if (p.split(/[\\/]/).includes("..")) {
    try {
      return realpathSync(p);
    } catch {
      throw new Error(`${p} can't be resolved (a ".." inside a folder that doesn't exist).`);
    }
  }
  const abs = resolve(p);
  const rest: string[] = [];
  for (let cur = abs; ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      rest.push(basename(cur));
      if (dirname(cur) === cur) return abs;
    }
  }
}

/** The real app's storage: ~/.jamsesh and its system app data folder, under the OS account's home (never `HOME`, which a launcher can set to anything). */
export function realRoots(home = userInfo().homedir): string[] {
  return [join(home, ".jamsesh"), join(home, "Library", "Application Support", "com.fluidcommerce.jamsesh")].map(realish);
}

/** The one rule for a port: an isolated hub never binds, restores, mirrors or targets the real app's. */
export function refusesPort(port: number, isolated: boolean): boolean {
  return isolated && REAL_PORTS.includes(port);
}

export function underReal(p: string, roots = realRoots()): string | null {
  const r = realish(p);
  return roots.find((root) => r === root || r.startsWith(root + "/")) ?? null;
}

export function isolatedPort(name: string, v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${name} must be a port from 1024 to 65535 for an isolated hub.`);
  if (REAL_PORTS.includes(n)) throw new Error(`${name}=${v} is the real app's port; an isolated hub must use its own.`);
  return n;
}

/**
 * Rewrites `env` in place for an isolated hub: every location variable is dropped (so no child process inherits it),
 * and the hub's home is JAMSESH_APP_DATA/home. Throws when JAMSESH_APP_DATA is missing or relative, or when it or
 * the home resolves, by real path, into the real app's storage.
 */
export function isolateEnv(env: Record<string, string | undefined>, roots = realRoots()): { appData: string; home: string } {
  const appData = env.JAMSESH_APP_DATA;
  if (!appData || !isAbsolute(appData)) throw new Error("An isolated hub needs an absolute JAMSESH_APP_DATA.");
  const home = join(appData, "home");
  for (const p of [appData, home]) {
    const hit = underReal(p, roots);
    if (hit) throw new Error(`${p} is inside the real JamSesh's storage (${hit}); an isolated hub must use its own folder.`);
  }
  for (const k of LOCATION_VARS) delete env[k];
  env.JAMSESH_HOME = home;
  return { appData, home };
}

/** A port the OS just handed out (port 0). */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

/** The one process listening on `port`, or null (none, or more than one: uncertain is no). */
export async function listenerPid(port: number): Promise<number | null> {
  try {
    const p = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
    const pids = (await new Response(p.stdout).text()).split(/\s+/).filter(Boolean).map(Number);
    return pids.length === 1 && Number.isInteger(pids[0]) ? pids[0] : null;
  } catch {
    return null;
  }
}

/** Whether `pid`, or a process it started, is what listens on `port`. A helper runs under a shell wrapper, so its parent counts. */
export async function ownsListener(port: number, pid: number): Promise<boolean> {
  const l = await listenerPid(port);
  if (l === null) return false;
  if (l === pid) return true;
  try {
    const p = Bun.spawn(["ps", "-o", "ppid=", "-p", String(l)], { stdout: "pipe", stderr: "ignore" });
    return Number((await new Response(p.stdout).text()).trim()) === pid;
  } catch {
    return false;
  }
}
