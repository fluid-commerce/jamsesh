// Network: makes the host reachable at https://<name>.duckdns.org from anywhere.
// DuckDNS name -> Let's Encrypt cert (DNS-01) -> router port forward -> self-check.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { CertStore, issueOne, needsRenewal, safeError, type CertKind } from "./acme";
import { parseDomain, publicIp as lookupIp, startUpdater, updateIp, type Domain, type FetchFn } from "./duckdns";
import { externalCheck, localCheck } from "./reach";
import { PortMapper, type RouterStatus } from "./router";

export type NetConfig = { domain: string; token: string; externalPort: number; internalPort: number; enabled: boolean; staging: boolean };
export type CertState = { state: "none" | "issuing" | "ok" | "error"; notAfter?: number; error?: string; step?: string; staging?: boolean };
export type NetStatus = {
  enabled: boolean;
  configured: boolean;
  domain?: string;
  publicIp?: string;
  lanIp: string;
  dns: "unknown" | "ok" | "error";
  dnsError?: string;
  cert: CertState;
  router: (RouterStatus & { state: "idle" | "working" | "done" }) | { state: "idle"; method: "none"; externalPort: number; message: string };
  reachable: "unknown" | "yes" | "no";
  reachDetail?: string;
  externalPort: number;
  internalPort: number;
  publicUrl?: string;
  checkUrl?: string;
};

export function lanIpv4(): string {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254") && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address;
  return "127.0.0.1";
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Network {
  private cfgPath: string;
  private cfg: NetConfig | null = null;
  private store: CertStore;
  private mapper = new PortMapper();
  private stopUpdater?: () => void;
  private renewTimer?: ReturnType<typeof setInterval>;
  private certRetry?: ReturnType<typeof setTimeout>;
  private issuing?: Promise<void>;
  private certChanged: (() => void)[] = [];
  private st = {
    dns: "unknown" as NetStatus["dns"],
    dnsError: undefined as string | undefined,
    publicIp: undefined as string | undefined,
    cert: { state: "none" } as CertState,
    router: { state: "idle" } as { state: string } & Partial<RouterStatus>,
    reachable: "unknown" as NetStatus["reachable"],
    reachDetail: undefined as string | undefined,
  };

  constructor(private dir: string, private fetchFn: FetchFn = fetch) {
    mkdirSync(dir, { recursive: true });
    this.cfgPath = join(dir, "net.json");
    this.store = new CertStore(join(dir, "tls"));
    this.cfg = this.readConfig();
    this.refreshCertState();
  }

  // ---- config (token lives in a 0600 file; it is never returned by status()) ----
  private readConfig(): NetConfig | null {
    try {
      const c = JSON.parse(readFileSync(this.cfgPath, "utf8"));
      return { domain: c.domain, token: c.token, externalPort: c.externalPort ?? 443, internalPort: c.internalPort ?? 4443, enabled: !!c.enabled, staging: !!c.staging };
    } catch {
      return null;
    }
  }
  private saveConfig(c: NetConfig) {
    // Whole file first, moved into place, and only then the live setting: a failed write changes nothing.
    const tmp = `${this.cfgPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.cfgPath);
    this.cfg = c;
  }
  config(): Omit<NetConfig, "token"> | null {
    if (!this.cfg) return null;
    const { token: _t, ...rest } = this.cfg;
    return rest;
  }
  private domain(): Domain | null {
    return this.cfg ? parseDomain(this.cfg.domain) : null;
  }

  // ---- lifecycle ----
  async start() {
    const d = this.domain();
    if (!this.cfg?.enabled || !d || this.shut) return;
    this.stopUpdater?.();
    this.stopUpdater = startUpdater(d, this.cfg.token, (r) => {
      this.st.dns = r.ok ? "ok" : "error";
      this.st.dnsError = r.ok ? undefined : r.error;
      if (r.ip) this.st.publicIp = r.ip;
    }, 5 * 60_000, this.fetchFn);
    this.renewTimer ??= setInterval(() => void this.ensureCert(), 24 * 3600_000);
    (this.renewTimer as any).unref?.();
    void this.openRouter();
    void this.certWithRetry();
  }

  /** A first certificate often fails while DNS settles: try again after 2, 5, then 15 minutes. */
  private async certWithRetry(attempt = 0) {
    await this.ensureCert();
    const delays = [2, 5, 15];
    if (!this.cfg?.enabled || this.stopping) return; // switched off while the order ran: no retry is scheduled
    if (this.st.cert?.state !== "ok" && attempt < delays.length) {
      const t = (this.certRetry = setTimeout(() => void this.certWithRetry(attempt + 1), delays[attempt] * 60_000));
      (t as any).unref?.();
    }
  }

  /** The hub is shutting down: turns everything off for good (a request still waiting on an order can't start anything after this). */
  close(): Promise<boolean> {
    this.shut = true;
    return this.stop();
  }

  /** Turns everything off. True when the router confirmed the port forward is gone (or there was none). */
  async stop(): Promise<boolean> {
    this.stopUpdater?.();
    this.stopUpdater = undefined;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
    if (this.certRetry) clearTimeout(this.certRetry);
    this.certRetry = undefined;
    this.stopping = true;
    this.mapEpoch++;
    try {
      await this.mapChain; // a mapping in flight finishes (and undoes itself) before the final unmap
      const gone = await this.mapper.unmap();
      this.st.router = gone ? { state: "idle" } : { state: "error", method: "none", message: "Couldn't confirm that the router closed the port. Check the router's forwarding rules." };
      return gone;
    } finally {
      this.stopping = false;
    }
  }

  onCertChange(cb: () => void) {
    this.certChanged.push(cb);
  }

  // ---- certificates ----
  private refreshCertState() {
    const bundles = (["apex", "wildcard"] as CertKind[]).map((k) => this.store.load(k)).filter(Boolean) as NonNullable<ReturnType<CertStore["load"]>>[];
    if (this.st.cert.state === "issuing") return;
    if (!bundles.length) return void (this.st.cert = { state: "none" });
    const soonest = Math.min(...bundles.map((b) => b.notAfter));
    this.st.cert = { state: "ok", notAfter: soonest, staging: bundles.some((b) => b.staging) };
  }

  /** Certs for Bun.serve({ tls }): apex first (the default), wildcard picked by SNI. Null until one exists. */
  tlsOptions(): { cert: string; key: string; serverName: string }[] | null {
    const d = this.domain();
    // Off means off: no listener, whatever certificates are kept on disk.
    if (!d || !this.cfg?.enabled) return null;
    const out: { cert: string; key: string; serverName: string }[] = [];
    // Only a certificate for this name, issued the way the setting says: while a replacement is pending, nothing is served rather than the wrong name.
    const fits = (b: ReturnType<CertStore["load"]>, name: string) => (b && b.names.includes(name) && b.staging === this.cfg!.staging ? b : null);
    const apex = fits(this.store.load("apex"), d.fqdn);
    const wild = fits(this.store.load("wildcard"), `*.${d.fqdn}`);
    if (apex) out.push({ cert: apex.cert, key: apex.key, serverName: d.fqdn });
    if (wild) out.push({ cert: wild.cert, key: wild.key, serverName: `*.${d.fqdn}` });
    return out.length ? out : null;
  }

  /** Issues (or renews) whatever is missing or within 30 days of expiry. Concurrent calls share one run. */
  ensureCert(force = false): Promise<void> {
    if (this.issuing) return this.issuing;
    const d = this.domain();
    if (!d || !this.cfg?.enabled) return Promise.resolve(); // nothing is ordered for a name that is switched off
    const cfg = this.cfg;
    const todo = (["apex", "wildcard"] as CertKind[]).filter((k) => {
      const b = this.store.load(k);
      // A certificate for another name (the name was changed) is no certificate for this one.
      const want = k === "apex" ? d.fqdn : `*.${d.fqdn}`;
      return force || !b || b.staging !== cfg.staging || needsRenewal(b.notAfter) || !b.names.includes(want);
    });
    if (!todo.length) {
      this.refreshCertState();
      return Promise.resolve();
    }
    this.st.cert = { state: "issuing", step: "Starting" };
    this.issuing = (async () => {
      try {
        for (const kind of todo) {
          const b = await issueOne(kind, { domain: d, token: cfg.token, store: this.store, staging: cfg.staging, f: this.fetchFn, onProgress: (s) => (this.st.cert = { state: "issuing", step: s }) });
          this.store.save(b, cfg.staging);
          this.st.cert = { state: "issuing", step: "Saved" };
          this.certChanged.forEach((cb) => cb());
        }
        this.st.cert = { state: "none" };
        this.refreshCertState();
      } catch (e) {
        this.st.cert = { state: "error", error: safeError(e, cfg.token) };
      } finally {
        this.issuing = undefined;
      }
    })();
    return this.issuing;
  }

  // ---- router ----
  /** Port-mapping runs one at a time; a stop moves the epoch, so one begun before it neither starts late nor leaves a mapping behind. */
  private mapEpoch = 0;
  /** True from the start of a stop until it has finished: no mapping is queued meanwhile. */
  private stopping = false;
  /** Set for good when the hub shuts down: nothing is mapped, started or ordered after it. */
  private shut = false;
  private mapChain: Promise<unknown> = Promise.resolve();

  async openRouter() {
    const c = this.cfg;
    if (!c?.enabled || this.stopping || this.shut) return;
    const epoch = this.mapEpoch;
    const run = this.mapChain.then(async () => {
      if (epoch !== this.mapEpoch) return;
      this.st.router = { state: "working", method: "none", externalPort: c.externalPort, message: "Asking your router to open the port…" };
      const lan = lanIpv4();
      const ip = await lookupIp(this.fetchFn, this.st.publicIp);
      this.st.publicIp ??= ip;
      const r = await this.mapper.map(c.externalPort, c.internalPort, lan, ip);
      // Stopped while it was asking: whatever it opened is taken back, and the status stays idle.
      if (epoch !== this.mapEpoch) return void (await this.mapper.unmap());
      this.st.router = { ...r, state: "done" };
    });
    this.mapChain = run.catch(() => {});
    return run;
  }

  // ---- checks ----
  async check() {
    const d = this.domain();
    if (!d) return;
    // The same address the wizard shows: the configured external port included.
    const host = d.fqdn + (this.cfg && this.cfg.externalPort !== 443 ? `:${this.cfg.externalPort}` : "");
    const local = await localCheck(host, this.fetchFn);
    if (local.ok) {
      this.st.reachable = "yes";
      this.st.reachDetail = local.detail;
      return;
    }
    const outside = await externalCheck(host, this.fetchFn);
    if (outside) {
      this.st.reachable = outside.ok ? "yes" : "no";
      this.st.reachDetail = outside.detail;
    } else {
      this.st.reachable = local.hairpinSuspect ? "unknown" : "no";
      this.st.reachDetail = local.detail;
    }
  }

  status(): NetStatus {
    const d = this.domain();
    const c = this.cfg;
    const ext = c?.externalPort ?? 443;
    const port = ext === 443 ? "" : `:${ext}`;
    return {
      enabled: !!c?.enabled,
      configured: !!d,
      domain: d?.fqdn,
      publicIp: this.st.publicIp,
      lanIp: lanIpv4(),
      dns: this.st.dns,
      dnsError: this.st.dnsError,
      cert: this.st.cert,
      router: this.st.router.state === "idle" ? { state: "idle", method: "none", externalPort: ext, message: "Not started yet." } : (this.st.router as any),
      reachable: this.st.reachable,
      reachDetail: this.st.reachDetail,
      externalPort: ext,
      internalPort: c?.internalPort ?? 4443,
      publicUrl: d ? `https://${d.fqdn}${port}` : undefined,
      checkUrl: d ? `https://${d.fqdn}${port}/healthz` : undefined,
    };
  }

  /** Mount for /api/net/* (lead: only for requests from localhost). Returns null when the path isn't ours. */
  async routes(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/net/")) return null;
    const p = url.pathname.slice("/api/net/".length);
    if (req.method === "GET" && p === "status") return json(this.status());
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body: any = await req.json().catch(() => ({}));
    if (p === "config") {
      const d = parseDomain(body.domain);
      const token = String(body.token ?? this.cfg?.token ?? "").trim();
      if (!d) return json({ error: "That doesn't look like a DuckDNS name. Use just the part before .duckdns.org." }, 400);
      if (!/^[0-9a-f-]{20,}$/i.test(token)) return json({ error: "The DuckDNS token is a long code of letters, numbers and dashes. Copy it from the top of the DuckDNS page." }, 400);
      const r = await updateIp(d, token, this.fetchFn);
      if (!r.ok) return json({ error: r.error ?? "DuckDNS didn't accept that name and token." }, 400);
      const externalPort = Number(body.externalPort ?? this.cfg?.externalPort ?? 443);
      const internalPort = Number(body.internalPort ?? this.cfg?.internalPort ?? 4443);
      if (![externalPort, internalPort].every((n) => Number.isInteger(n) && n > 0 && n < 65536)) return json({ error: "Ports must be between 1 and 65535." }, 400);
      if (!(await this.stop())) return json({ error: "The router hasn't confirmed closing the earlier port forward. Try again, or remove it in the router's settings." }, 409);
      this.st.publicIp = r.ip;
      this.st.dns = "ok";
      await this.issuing?.catch(() => {}); // an order for the old name finishes first; its certificate is replaced by the check on names
      if (this.shut) return json({ error: "The host is closing." }, 503);
      this.saveConfig({ domain: d.fqdn, token, externalPort, internalPort, enabled: true, staging: body.staging ?? this.cfg?.staging ?? false });
      await this.start();
      this.certChanged.forEach((cb) => cb()); // the HTTPS listener and the announcement follow every change of setting, not only a new certificate
      return json(this.status());
    }
    if (!this.cfg) return json({ error: "Set up a name first." }, 400);
    if (p === "check") {
      await this.check();
      return json(this.status());
    }
    if (p === "issue-cert") {
      void this.ensureCert(true);
      return json(this.status());
    }
    if (p === "retry-router") {
      if (!this.cfg.enabled) {
        // Off: nothing new is opened, but an unconfirmed old forward is tried again.
        const gone = await this.mapper.unmap();
        this.st.router = gone ? { state: "idle" } : { state: "error", method: "none", message: "Couldn't confirm that the router closed the port. Check the router's forwarding rules." };
        return json(this.status(), gone ? 200 : 409);
      }
      await this.openRouter();
      return json(this.status());
    }
    if (p === "disable") {
      // Off is saved either way, but a forward the router didn't confirm closing is said so, and Retry stays available to try again.
      const gone = await this.stop();
      this.saveConfig({ ...this.cfg, enabled: false });
      this.st.reachable = "unknown";
      this.certChanged.forEach((cb) => cb()); // the HTTPS listener and the announcement follow the setting
      return gone ? json(this.status()) : json({ ...this.status(), error: "Remote access is off, but the router didn't confirm closing the port forward. Press Retry to try again, or remove it in the router's settings." }, 409);
    }
    return json({ error: "not found" }, 404);
  }
}
