// Automatic port forwarding: NAT-PMP first (tiny UDP protocol), then UPnP IGD (SSDP + SOAP).
import dgram from "node:dgram";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type RouterStatus = {
  method: "nat-pmp" | "upnp" | "none";
  externalPort: number;
  routerIp?: string;
  /** What the router says its own WAN address is. */
  externalIp?: string;
  lifetimeSec?: number;
  cgnat?: boolean;
  error?: string;
  /** Human text for the UI. */
  message: string;
};

// ---------- pure helpers (tested) ----------

export function ipToInt(ip: string) {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const inCidr = (ip: string, base: string, bits: number) => ((ipToInt(ip) ^ ipToInt(base)) >>> (32 - bits)) === 0;
export const isCgnatIp = (ip: string) => inCidr(ip, "100.64.0.0", 10);
export const isPrivateIp = (ip: string) => inCidr(ip, "10.0.0.0", 8) || inCidr(ip, "172.16.0.0", 12) || inCidr(ip, "192.168.0.0", 16) || isCgnatIp(ip);

/** Inbound connections are impossible when the router's WAN address isn't the public one. */
export function detectCgnat(publicIp?: string, routerExternalIp?: string): boolean {
  if (routerExternalIp && routerExternalIp !== "0.0.0.0" && isPrivateIp(routerExternalIp)) return true;
  return !!(publicIp && routerExternalIp && routerExternalIp !== "0.0.0.0" && publicIp !== routerExternalIp);
}

export const natPmpExternalAddressRequest = () => Buffer.from([0, 0]);

export function natPmpMapRequest(internalPort: number, externalPort: number, lifetimeSec: number) {
  const b = Buffer.alloc(12);
  b.writeUInt8(0, 0); // version
  b.writeUInt8(2, 1); // opcode: map TCP
  b.writeUInt16BE(internalPort, 4);
  b.writeUInt16BE(externalPort, 6);
  b.writeUInt32BE(lifetimeSec, 8);
  return b;
}

const PMP_ERRORS: Record<number, string> = {
  1: "unsupported version",
  2: "the router isn't allowing port mapping (turned off in its settings)",
  3: "the router's network is down",
  4: "the router is out of mappings",
  5: "unsupported opcode",
};

export type PmpReply =
  | { kind: "address"; result: number; externalIp: string }
  | { kind: "map"; result: number; internalPort: number; externalPort: number; lifetimeSec: number }
  | null;

export function decodeNatPmp(b: Buffer): PmpReply {
  if (b.length < 8 || b[0] !== 0) return null;
  const op = b[1];
  const result = b.readUInt16BE(2);
  if (op === 128 && b.length >= 12) return { kind: "address", result, externalIp: `${b[8]}.${b[9]}.${b[10]}.${b[11]}` };
  if (op === 130 && b.length >= 16) return { kind: "map", result, internalPort: b.readUInt16BE(8), externalPort: b.readUInt16BE(10), lifetimeSec: b.readUInt32BE(12) };
  return null;
}

// ---------- gateway discovery ----------

export async function defaultGateway(): Promise<string | undefined> {
  const run = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
      return await new Response(p.stdout).text();
    } catch {
      return "";
    }
  };
  if (process.platform === "darwin") return (await run(["route", "-n", "get", "default"])).match(/gateway:\s*([\d.]+)/)?.[1];
  if (process.platform === "linux") return (await run(["ip", "route", "show", "default"])).match(/default via ([\d.]+)/)?.[1];
  if (process.platform === "win32") return (await run(["route", "print", "0.0.0.0"])).match(/0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)/)?.[1];
}

// ---------- NAT-PMP ----------

function pmpExchange(gateway: string, req: Buffer, tries = 3): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let n = 0;
    let timer: ReturnType<typeof setTimeout>;
    const done = (b: Buffer | null) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      resolve(b);
    };
    sock.on("message", (m, r) => r.address === gateway && done(m));
    sock.on("error", () => done(null));
    const send = () => {
      if (n >= tries) return done(null);
      sock.send(req, 5351, gateway);
      timer = setTimeout(send, 250 * 2 ** n++);
    };
    send();
  });
}

async function pmpMap(gateway: string, internalPort: number, externalPort: number, lifetimeSec: number) {
  const addrRaw = await pmpExchange(gateway, natPmpExternalAddressRequest());
  const addr = addrRaw && decodeNatPmp(addrRaw);
  if (!addr || addr.kind !== "address") return { supported: false as const };
  const mapRaw = await pmpExchange(gateway, natPmpMapRequest(internalPort, externalPort, lifetimeSec));
  const map = mapRaw && decodeNatPmp(mapRaw);
  if (!map || map.kind !== "map") return { supported: false as const };
  return { supported: true as const, externalIp: addr.externalIp, result: map.result, externalPort: map.externalPort, lifetimeSec: map.lifetimeSec };
}

// ---------- UPnP IGD ----------

type Igd = { control: string; type: string; location: string };

export function parseIgdDescription(xml: string, location: string): Igd | null {
  const re = /<service>([\s\S]*?)<\/service>/g;
  for (let m; (m = re.exec(xml)); ) {
    const type = m[1].match(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/)?.[1];
    const ctl = m[1].match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/)?.[1];
    if (type && ctl && /:(WANIPConnection|WANPPPConnection):/.test(type)) return { type, control: new URL(ctl, location).toString(), location };
  }
  return null;
}

function ssdp(timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Set<string>();
    const st = ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"];
    const finish = () => {
      try {
        sock.close();
      } catch {}
      resolve([...found]);
    };
    sock.on("message", (m) => {
      const loc = m.toString().match(/^location:\s*(\S+)/im)?.[1];
      if (loc) found.add(loc);
    });
    sock.on("error", finish);
    sock.bind(0, () => {
      for (const s of st) sock.send(Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${s}\r\n\r\n`), 1900, "239.255.255.250");
    });
    setTimeout(finish, timeoutMs);
  });
}

export async function soap(igd: Igd, action: string, args: Record<string, string | number>) {
  const body = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
  const res = await fetch(igd.control, {
    method: "POST",
    headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${igd.type}#${action}"` },
    body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${igd.type}">${body}</u:${action}></s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  const err = text.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
  return { ok: res.ok && !err, text, errorCode: err ? Number(err) : undefined };
}

export async function findIgd(): Promise<Igd | null> {
  for (const loc of await ssdp()) {
    try {
      const xml = await (await fetch(loc, { signal: AbortSignal.timeout(4000) })).text();
      const igd = parseIgdDescription(xml, loc);
      if (igd) return igd;
    } catch {}
  }
  return null;
}

// ---------- the mapper ----------

export function manualMessage(externalPort: number, lanIp: string, internalPort: number) {
  return `Your router doesn't allow automatic port forwarding. In your router's settings, forward TCP port ${externalPort} to ${lanIp} port ${internalPort}.`;
}

export const CGNAT_MESSAGE = "Your internet provider shares one public address between many homes (CGNAT), so nothing can connect in from outside on this network. Use Tailscale Funnel or a Cloudflare Tunnel instead, or ask your provider for a public address.";

const LEASE = 3600;

type Mapping = { gateway?: string; method: RouterStatus["method"]; internalPort: number; externalPort: number; lanIp: string };

export class PortMapper {
  private timer?: ReturnType<typeof setInterval>;
  private igd: Igd | null = null;
  private current?: Mapping;
  /**
   * The mapping this machine has asked the router for and not seen removed. For UPnP (which can be permanent) it is on disk
   * from before the request until the router confirms the deletion, so a crash or a failed removal never leaves a port open
   * that nothing remembers.
   */
  private owed?: Mapping;
  /** The record on disk exists but can't be read: a port may be open with nothing to say which, so no new mapping is made over it. */
  private damaged = false;
  /** Everything that touches the router or the record runs one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private statePath?: string) {
    try {
      if (statePath && existsSync(statePath)) {
        const m = JSON.parse(readFileSync(statePath, "utf8"));
        if (!m || typeof m.internalPort !== "number" || typeof m.externalPort !== "number" || (m.method !== "upnp" && m.method !== "nat-pmp")) throw new Error("bad record");
        this.owed = m;
      }
    } catch {
      this.damaged = true;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Replaces the record whole (written beside it, then renamed over it): the old one is never half overwritten. Throws if it can't be written. */
  private write(m: Mapping) {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** The record goes only after the router confirmed the removal; if the file can't be removed the mapping stays owed (removing a gone mapping is harmless). */
  private clear(): boolean {
    try {
      if (this.statePath) rmSync(this.statePath, { force: true });
      this.owed = undefined;
      return true;
    } catch {
      return false;
    }
  }

  /** Takes down what is owed. True when nothing is. Callers hold the lock. */
  private async settle(): Promise<boolean> {
    if (this.damaged) return false;
    const m = this.owed;
    if (!m) return true;
    try {
      await this.remove(m);
    } catch {
      return false; // still owed: stays on disk for the next start
    }
    return this.clear();
  }

  /** Takes down a mapping an earlier run could not (called at start, before a new mapping). True when none is owed any more. */
  settleOwed(): Promise<boolean> {
    return this.exclusive(() => this.settle());
  }

  get owing() {
    return this.owed;
  }

  /** Asks the router for one NAT-PMP exchange (a seam for tests). */
  protected exchange(gateway: string, req: Buffer, tries?: number) {
    return pmpExchange(gateway, req, tries);
  }

  /** Deletes one mapping at the router. Throws when the router did not confirm it. */
  protected async remove(c: Mapping) {
    if (c.method === "nat-pmp") {
      const gateway = c.gateway ?? (await defaultGateway());
      if (!gateway) throw new Error("no router to ask");
      const raw = await this.exchange(gateway, natPmpMapRequest(c.internalPort, 0, 0), 2);
      const reply = raw && decodeNatPmp(raw);
      // Silence, an error, or an answer about another port is not a removal.
      if (!reply || reply.kind !== "map" || reply.result !== 0 || reply.internalPort !== c.internalPort) throw new Error("the router did not confirm the removal");
    } else if (c.method === "upnp") {
      this.igd ??= await findIgd();
      if (!this.igd) throw new Error("no router answered");
      const r = await soap(this.igd, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: c.externalPort, NewProtocol: "TCP" });
      if (!r.ok && String(r.errorCode) !== "714") throw new Error(`UPnP error ${r.errorCode ?? "unknown"}`); // 714: there was no such mapping
    }
  }

  /** Opens externalPort -> lanIp:internalPort. Never throws; the status says what happened. */
  map(externalPort: number, internalPort: number, lanIp: string, publicIp?: string): Promise<RouterStatus> {
    return this.exclusive(() => this.mapLocked(externalPort, internalPort, lanIp, publicIp));
  }

  private async mapLocked(externalPort: number, internalPort: number, lanIp: string, publicIp?: string): Promise<RouterStatus> {
    this.unrenew();
    // What is already open (this run's, or an earlier run's that could not be removed) goes first; while it is still there no new mapping is made over its record.
    if (this.current) {
      const c = this.current;
      this.current = undefined;
      try {
        await this.remove(c);
        if (c.method === "upnp") this.clear();
      } catch {
        if (c.method === "upnp") this.owed = c;
      }
    }
    if (!(await this.settle())) {
      return { method: "none", externalPort, error: "an earlier port mapping could not be removed", message: `${manualMessage(externalPort, lanIp, internalPort)} (An earlier automatic mapping is still open and will be retried at the next start.)` };
    }
    const gateway = await defaultGateway();
    let status: RouterStatus | undefined;

    if (gateway) {
      try {
        const r = await pmpMap(gateway, internalPort, externalPort, LEASE);
        if (r.supported && r.result === 0) {
          this.current = { gateway, method: "nat-pmp", internalPort, externalPort: r.externalPort, lanIp }; // (a NAT-PMP lease runs out by itself; only a UPnP mapping, which can be permanent, is written down)
          status = { method: "nat-pmp", externalPort: r.externalPort, routerIp: gateway, externalIp: r.externalIp, lifetimeSec: r.lifetimeSec, message: `Your router opened port ${r.externalPort} automatically (NAT-PMP).` };
        } else if (r.supported) {
          status = { method: "none", externalPort, routerIp: gateway, externalIp: r.externalIp, error: PMP_ERRORS[r.result] ?? `error ${r.result}`, message: manualMessage(externalPort, lanIp, internalPort) };
        }
      } catch {}
    }

    if (!status || status.method === "none") {
      try {
        this.igd ??= await findIgd();
        if (this.igd) {
          const ip = await soap(this.igd, "GetExternalIPAddress", {});
          const externalIp = ip.text.match(/<NewExternalIPAddress>([^<]*)</)?.[1];
          const map = (lease: number) =>
            soap(this.igd!, "AddPortMapping", {
              NewRemoteHost: "",
              NewExternalPort: externalPort,
              NewProtocol: "TCP",
              NewInternalPort: internalPort,
              NewInternalClient: lanIp,
              NewEnabled: 1,
              NewPortMappingDescription: "JamSesh",
              NewLeaseDuration: lease,
            });
          const record: Mapping = { method: "upnp", internalPort, externalPort, lanIp };
          this.write(record); // on disk before the mapping exists; if it can't be written, no mapping is made
          this.owed = record;
          let add = await map(LEASE);
          let permanent = false;
          // Many routers accept only permanent mappings (error 725): ask again without a lease.
          if (!add.ok && String(add.errorCode) === "725") (add = await map(0), (permanent = add.ok));
          if (add.ok) {
            this.current = record;
            status = { method: "upnp", externalPort, routerIp: gateway, externalIp, lifetimeSec: permanent ? undefined : LEASE, message: `Your router opened port ${externalPort} automatically (UPnP${permanent ? ", with no expiry" : ""}).` };
          } else {
            this.clear(); // the router said no: nothing was opened
            status = { method: "none", externalPort, routerIp: gateway, externalIp, error: `UPnP error ${add.errorCode ?? "unknown"}`, message: manualMessage(externalPort, lanIp, internalPort) };
          }
        }
      } catch (e) {
        status = { method: "none", externalPort, routerIp: gateway, error: (e as Error).message, message: manualMessage(externalPort, lanIp, internalPort) };
      }
    }

    status ??= { method: "none", externalPort, routerIp: gateway, error: "no NAT-PMP or UPnP answer", message: manualMessage(externalPort, lanIp, internalPort) };
    if (detectCgnat(publicIp, status.externalIp)) {
      status.cgnat = true;
      status.message = CGNAT_MESSAGE;
    }
    if (this.current) this.timer = setInterval(() => void this.renew(), (LEASE / 2) * 1000);
    (this.timer as any)?.unref?.();
    return status;
  }

  private unrenew() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async renew() {
    const c = this.current;
    if (!c) return;
    try {
      if (c.method === "nat-pmp" && c.gateway) await pmpMap(c.gateway, c.internalPort, c.externalPort, LEASE);
      else if (c.method === "upnp" && this.igd)
        await soap(this.igd, "AddPortMapping", { NewRemoteHost: "", NewExternalPort: c.externalPort, NewProtocol: "TCP", NewInternalPort: c.internalPort, NewInternalClient: c.lanIp, NewEnabled: 1, NewPortMappingDescription: "JamSesh", NewLeaseDuration: LEASE });
    } catch {}
  }

  /** Removes the mapping (NAT-PMP: lifetime 0; UPnP: DeletePortMapping). A removal the router doesn't confirm is remembered and tried again at the next start. */
  unmap(): Promise<void> {
    return this.exclusive(async () => {
      this.unrenew();
      const c = this.current;
      this.current = undefined;
      if (c) {
        try {
          await this.remove(c);
          if (c.method === "upnp") this.clear();
        } catch {
          if (c.method === "upnp") this.owed = c; // the record on disk already says so
        }
      } else await this.settle();
    });
  }
}
