// Reachability self-check. From inside the network, hairpin NAT often breaks the loopback path to
// our own public address, so a local failure is reported as "can't tell", not as a hard no.
import type { FetchFn } from "./duckdns";

export type SelfCheck = { ok: boolean; hairpinSuspect?: boolean; ms?: number; detail: string };

export function classifyFetchError(e: unknown): { detail: string; hairpinSuspect: boolean } {
  const m = String((e as any)?.code ?? (e as Error)?.message ?? e);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return { detail: "The name doesn't resolve yet. DNS may still be updating.", hairpinSuspect: false };
  if (/CERT|SSL|TLS|certificate/i.test(m)) return { detail: "The address answered but its certificate isn't trusted yet.", hairpinSuspect: false };
  if (/timeout|timed out|abort/i.test(m)) return { detail: "No answer from inside this network. Many routers can't loop back to their own public address, so confirm from a phone on cellular.", hairpinSuspect: true };
  if (/ECONNREFUSED/i.test(m)) return { detail: "Connection refused: the port isn't open or the secure listener isn't running.", hairpinSuspect: false };
  return { detail: `Couldn't connect (${m.slice(0, 120)}).`, hairpinSuspect: true };
}

export async function localCheck(domain: string, f: FetchFn = fetch, timeoutMs = 5000): Promise<SelfCheck> {
  const t = Date.now();
  try {
    const res = await f(`https://${domain}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.text()).trim();
    if (res.ok && body === "ok") return { ok: true, ms: Date.now() - t, detail: "This machine reached the host at its public address." };
    return { ok: false, ms: Date.now() - t, detail: `Something answered with HTTP ${res.status}, but it wasn't the JamSesh host.` };
  } catch (e) {
    const c = classifyFetchError(e);
    return { ok: false, hairpinSuspect: c.hairpinSuspect, detail: c.detail };
  }
}

/** Outside view from check-host.net (free, no key). Returns null if the service can't be used. */
export function parseCheckHostResult(json: any): { ok: number; total: number } | null {
  if (!json || typeof json !== "object") return null;
  let ok = 0;
  let total = 0;
  for (const v of Object.values(json) as any[]) {
    if (v == null) return null; // still running
    const row = v?.[0]; // [ok, seconds, message, httpCode, ip]
    if (!Array.isArray(row)) continue;
    total++;
    if (row[0] === 1 && /^[23]\d\d$/.test(String(row[3]))) ok++;
  }
  return total ? { ok, total } : null;
}

export async function externalCheck(domain: string, f: FetchFn = fetch, opts: { polls?: number; everyMs?: number } = {}): Promise<SelfCheck | null> {
  try {
    const start = await f(`https://check-host.net/check-http?host=${encodeURIComponent(`https://${domain}/healthz`)}&max_nodes=3`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const id = ((await start.json()) as any)?.request_id;
    if (!id) return null;
    for (let i = 0; i < (opts.polls ?? 8); i++) {
      await new Promise((r) => setTimeout(r, opts.everyMs ?? 2000));
      const res = await f(`https://check-host.net/check-result/${id}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      const r = parseCheckHostResult(await res.json());
      if (r) return r.ok > 0 ? { ok: true, detail: `${r.ok} of ${r.total} outside servers reached your host.` } : { ok: false, detail: "Outside servers couldn't reach your host. Check the router step." };
    }
  } catch {}
  return null;
}
