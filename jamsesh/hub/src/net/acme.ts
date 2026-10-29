// Let's Encrypt certificates via ACME DNS-01, using DuckDNS TXT records.
//
// DuckDNS keeps exactly ONE TXT value per name, and `name.duckdns.org` plus `*.name.duckdns.org`
// both validate at _acme-challenge.name.duckdns.org with two different values. One order can't hold
// both, so we run two orders back to back: an apex cert and a wildcard cert, picked by SNI.
import * as acme from "acme-client";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearTxt, setTxt, type Domain, type FetchFn } from "./duckdns";

export const RENEW_BEFORE_DAYS = 30;
export type CertKind = "apex" | "wildcard";
export type CertBundle = { kind: CertKind; names: string[]; cert: string; key: string; notAfter: number };

export function needsRenewal(notAfter: number | undefined, now = Date.now(), days = RENEW_BEFORE_DAYS) {
  return !notAfter || notAfter - now < days * 86_400_000;
}

/** Extracts the TXT values from a DNS-over-HTTPS JSON answer (Cloudflare and Google share the shape). */
export function parseDohTxt(json: any): string[] {
  return (json?.Answer ?? []).filter((a: any) => a.type === 16).map((a: any) => String(a.data).replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
}

export async function dnsHasTxt(fqdn: string, value: string, f: FetchFn = fetch): Promise<boolean> {
  const name = `_acme-challenge.${fqdn}`;
  const urls = [`https://cloudflare-dns.com/dns-query?name=${name}&type=TXT`, `https://dns.google/resolve?name=${name}&type=TXT`];
  for (const url of urls) {
    try {
      const res = await f(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
      if (parseDohTxt(await res.json()).includes(value)) return true;
    } catch {}
  }
  return false;
}

export async function waitForTxt(fqdn: string, value: string, opts: { f?: FetchFn; timeoutMs?: number; everyMs?: number } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    if (await dnsHasTxt(fqdn, value, opts.f)) return true;
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 5000));
  }
  return false;
}

export class CertStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private p(name: string) {
    return join(this.dir, name);
  }
  private write(name: string, data: string | Buffer) {
    writeFileSync(this.p(name), data, { mode: 0o600 });
    chmodSync(this.p(name), 0o600);
  }
  accountKey(): Promise<Buffer> | Buffer {
    if (existsSync(this.p("account.key"))) return readFileSync(this.p("account.key"));
    return acme.crypto.createPrivateKey().then((k) => (this.write("account.key", k), k));
  }
  save(b: CertBundle, staging: boolean) {
    this.write(`${b.kind}.crt`, b.cert);
    this.write(`${b.kind}.key`, b.key);
    this.write(`${b.kind}.json`, JSON.stringify({ names: b.names, notAfter: b.notAfter, staging }));
  }
  load(kind: CertKind): (CertBundle & { staging: boolean }) | null {
    try {
      const meta = JSON.parse(readFileSync(this.p(`${kind}.json`), "utf8"));
      return { kind, names: meta.names, notAfter: meta.notAfter, staging: !!meta.staging, cert: readFileSync(this.p(`${kind}.crt`), "utf8"), key: readFileSync(this.p(`${kind}.key`), "utf8") };
    } catch {
      return null;
    }
  }
}

export type IssueOpts = { domain: Domain; token: string; store: CertStore; staging?: boolean; email?: string; f?: FetchFn; onProgress?: (msg: string) => void; propagationMs?: number; /** Aborted when the room closes: nothing more is started (account key, DNS records) once it is. */ signal?: AbortSignal };

/** Issues one cert (one order) for `names`, serialising on the single DuckDNS TXT slot. */
export async function issueOne(kind: CertKind, o: IssueOpts): Promise<CertBundle> {
  const names = kind === "apex" ? [o.domain.fqdn] : [`*.${o.domain.fqdn}`];
  o.signal?.throwIfAborted();
  const client = new acme.Client({
    directoryUrl: o.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: await o.store.accountKey(),
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: names[0] });
  o.onProgress?.(`Requesting the ${kind === "apex" ? "main" : "wildcard"} certificate`);
  const cert = await client.auto({
    csr,
    email: o.email,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    skipChallengeVerification: true, // we verify through public DoH below; the local resolver may be stale
    challengeCreateFn: async (_authz, _ch, txt) => {
      o.signal?.throwIfAborted();
      const r = await setTxt(o.domain, o.token, txt, o.f);
      if (!r.ok) throw new Error(r.error ?? "DuckDNS refused the TXT record");
      o.onProgress?.("Waiting for DNS to publish the proof");
      if (!(await waitForTxt(o.domain.fqdn, txt, { f: o.f, timeoutMs: o.propagationMs }))) throw new Error("DNS didn't show the challenge record in time. Try again in a minute.");
    },
    challengeRemoveFn: async () => {
      await clearTxt(o.domain, o.token, o.f);
    },
  });
  const notAfter = new X509Certificate(cert).validToDate.getTime();
  return { kind, names, cert, key: key.toString(), notAfter };
}

/** Never leak the token or key material through an error. */
export function safeError(e: unknown, token: string) {
  const m = (e as Error)?.message ?? String(e);
  return (token ? m.split(token).join("***") : m).replace(/-----BEGIN [\s\S]*?-----END [^-]*-----/g, "[redacted]");
}
