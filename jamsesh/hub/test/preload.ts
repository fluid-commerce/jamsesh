// Runs before every test file (bunfig.toml). Two walls between the suite and the person's live JamSesh:
//  1. JAMSESH_HOME points at a throwaway folder unless the test set its own, and src/config.ts throws if any
//     data, home or team folder still resolves inside the real ~/.jamsesh.
//  2. Nothing in a test may connect to the live hub's or the Mac app's ports on this machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.JAMSESH_HOME ??= mkdtempSync(join(tmpdir(), "jam-test-home-"));

/** The live hub's, relay's and canvas's fixed ports. A test hub listens on port 0 and has no reason to dial these. (Not the dev-preview range from 5100: tests start their own dev proxies there and dial those.) */
export const LIVE_PORTS = new Set([4790, 4747, 7979, 47900]);
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function assertNotLive(host: unknown, port: unknown): void {
  const p = Number(port);
  if (LIVE_PORTS.has(p) && (host === undefined || host === null || LOCAL.has(String(host)))) {
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
