// DuckDNS client: dynamic IP updates, ACME TXT records, public IP lookup.
// Tokens only ever travel in the request URL DuckDNS requires; every error message is scrubbed.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type Domain = { sub: string; fqdn: string };

/** Accepts "name", "name.duckdns.org", or "https://name.duckdns.org/anything". */
export function parseDomain(input: string): Domain | null {
  let s = String(input ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  s = s.replace(/\.duckdns\.org$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(s) || s.endsWith("-")) return null;
  return { sub: s, fqdn: `${s}.duckdns.org` };
}

export type UpdateResult = { ok: boolean; ip?: string; ipv6?: string; changed?: boolean; error?: string };

/** verbose=true replies "OK\n<ipv4>\n<ipv6>\nUPDATED|NOCHANGE" or just "KO". */
export function parseUpdateResponse(text: string): UpdateResult {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== "OK") return { ok: false, error: "DuckDNS rejected the name or token." };
  const ip = lines[1] && /^\d+\.\d+\.\d+\.\d+$/.test(lines[1]) ? lines[1] : undefined;
  const ipv6 = lines[2] && lines[2].includes(":") ? lines[2] : undefined;
  const last = lines[lines.length - 1];
  return { ok: true, ip, ipv6, changed: last === "UPDATED" };
}

function scrub(msg: string, token: string) {
  return token ? msg.split(token).join("***") : msg;
}

async function call(d: Domain, token: string, extra: Record<string, string>, f: FetchFn): Promise<UpdateResult> {
  const q = new URLSearchParams({ domains: d.sub, token, ...extra, verbose: "true" });
  try {
    const res = await f(`https://www.duckdns.org/update?${q}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `DuckDNS answered HTTP ${res.status}.` };
    return parseUpdateResponse(await res.text());
  } catch (e) {
    return { ok: false, error: scrub(`Couldn't reach DuckDNS: ${(e as Error).message}`, token) };
  }
}

/** Points the name at the caller's current public IP (ip= empty means "the IP you're calling from"). */
export const updateIp = (d: Domain, token: string, f: FetchFn = fetch) => call(d, token, { ip: "" }, f);
export const setTxt = (d: Domain, token: string, txt: string, f: FetchFn = fetch) => call(d, token, { txt }, f);
export const clearTxt = (d: Domain, token: string, f: FetchFn = fetch) => call(d, token, { txt: "x", clear: "true" }, f);

/** Prefer what DuckDNS saw (it is the address that will be served); fall back to ipify. */
export async function publicIp(f: FetchFn = fetch, known?: string): Promise<string | undefined> {
  if (known) return known;
  try {
    const res = await f("https://api.ipify.org", { signal: AbortSignal.timeout(6000) });
    const t = (await res.text()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the name pointed at this network. Returns a stop function. */
export function startUpdater(d: Domain, token: string, onResult: (r: UpdateResult) => void, intervalMs = 5 * 60_000, f: FetchFn = fetch) {
  let stopped = false;
  const tick = async () => {
    const r = await updateIp(d, token, f);
    if (!stopped) onResult(r);
  };
  const t = setInterval(tick, intervalMs);
  (t as any).unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
