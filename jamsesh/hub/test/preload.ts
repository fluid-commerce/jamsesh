// Runs before every test file (bunfig.toml). Two walls between the suite and the person's live JamSesh:
//  1. JAMSESH_HOME points at a throwaway folder unless the test set its own, and src/config.ts throws if any
//     data, home or team folder still resolves inside the real ~/.jamsesh.
//  2. Nothing in a test may connect to the live hub's or the Mac app's ports on this machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.JAMSESH_HOME ??= mkdtempSync(join(tmpdir(), "jam-test-home-"));

/**
 * Ports the live JamSesh uses or falls back to: the hub (4747 and the few above it, 4790, the Mac app's 4848 and 4949), the relay (7979) and the
 * canvas (47900 and the ones above it). A test hub listens on port 0 and has no reason to dial these. (Not the dev-preview range from 5100: tests
 * start their own dev proxies there and dial those.)
 */
export const isLivePort = (p: number) => (p >= 4700 && p <= 4999) || p === 7979 || (p >= 47900 && p <= 47999);

/** Whether a host name is this computer by any spelling: localhost, 127.0.0.0/8, ::1, ::, 0.0.0.0, and the IPv4-mapped forms of those. */
export function isLocalHost(host: unknown): boolean {
  if (host === undefined || host === null || host === "") return true;
  let h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  h = h.replace(/^::ffff:/, "");
  if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) {
    // ::ffff:7f00:1 style: the two groups are the four bytes
    const [hi, lo] = h.split(":").map((x) => parseInt(x, 16));
    h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function assertNotLive(host: unknown, port: unknown): void {
  const p = Number(port);
  if (isLivePort(p) && isLocalHost(host)) {
    throw new Error(`Test isolation: a test tried to reach ${String(host ?? "localhost")}:${p}, a port the live JamSesh uses. Use a hub started on port 0.`);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: any, init?: any) => {
    try {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assertNotLive(u.hostname, u.port);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Test isolation")) return Promise.reject(e);
    }
    return realFetch(input, init);
  },
  realFetch,
) as typeof fetch;
