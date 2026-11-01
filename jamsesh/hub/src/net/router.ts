// Automatic port forwarding: NAT-PMP first (tiny UDP protocol), then UPnP IGD (SSDP + SOAP).
import { runShort } from "../hostctl";
import dgram from "node:dgram";

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
  // The bounded process-group runner (hostctl): a lookup that hangs, or holds its output open, ends at its deadline.
  const run = async (cmd: string[]) => {
    const r = await runShort(cmd, 5000);
    return r.stuck || r.code !== 0 ? "" : r.out;
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
  // The router answered the address request, so it speaks NAT-PMP: no (or no valid) reply to the map request means it may have applied it.
  if (!map || map.kind !== "map") return { supported: false as const, lost: true as const };
  return { supported: true as const, externalIp: addr.externalIp, result: map.result, externalPort: map.externalPort, lifetimeSec: map.lifetimeSec };
}

// ---------- UPnP IGD ----------

type Igd = { control: string; type: string; location: string };

export function parseIgdDescription(xml: string, location: string): Igd | null {
  const re = /<service>([\s\S]*?)<\/service>/g;
  for (let m; (m = re.exec(xml)); ) {
    const type = m[1].match(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/)?.[1];
    const ctl = m[1].match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/)?.[1];
    if (!type || !ctl || !/:(WANIPConnection|WANPPPConnection):/.test(type)) continue;
    // The control endpoint has to be on the device that described it: a description can't point the hub at another service.
    const control = new URL(ctl, location);
    if (control.origin !== new URL(location).origin) continue;
    return { type, control: control.toString(), location };
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
    redirect: "error",
    method: "POST",
    headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${igd.type}#${action}"` },
    body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${igd.type}">${body}</u:${action}></s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  const err = text.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
  return { ok: res.ok && !err, text, errorCode: err ? Number(err) : undefined };
}

/** The router's UPnP service. Only an answer from the default gateway itself counts (anyone on the LAN can answer a search), and nothing is followed to another address. */
export async function findIgd(gateway?: string): Promise<Igd | null> {
  for (const loc of await ssdp()) {
    try {
      if (!gateway || new URL(loc).hostname !== gateway) continue;
      const xml = await (await fetch(loc, { redirect: "error", signal: AbortSignal.timeout(4000) })).text();
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

/** Renewal tries again this soon after a failed attempt; this many failures in a row are reported as a lost forward. */
const RETRY_MS = 60_000;
const MAX_RENEW_FAILS = 3;

export class PortMapper {
  /** Called when a renewal shows the forward is gone or moved, with a sentence for the person. */
  onLost?: (message: string) => void;
  /** Overrides the renewal wait (tests only). */
  renewAfterMs?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private fails = 0;
  private granted = LEASE;
  private igd: Igd | null = null;
  private current?: { gateway?: string; method: RouterStatus["method"]; internalPort: number; externalPort: number; lanIp: string };
  /** A request that may have been applied though its reply never came: kept until a delete is confirmed, and never renewed. */
  private maybe?: { gateway?: string; method: RouterStatus["method"]; internalPort: number; externalPort: number; lanIp: string };

  /** Opens externalPort -> lanIp:internalPort. Never throws; the status says what happened. */
  async map(externalPort: number, internalPort: number, lanIp: string, publicIp?: string): Promise<RouterStatus> {
    this.unrenew();
    // An earlier forward the router never confirmed removing is dealt with first: it is not forgotten under a new one.
    if ((this.current || this.maybe) && !(await this.unmap())) return { method: "none", externalPort, error: "the earlier port forward is not confirmed closed", message: "The router hasn't confirmed closing the earlier port forward yet. Try again in a moment, or remove it in the router's settings." };
    const gateway = await defaultGateway();
    let status: RouterStatus | undefined;

    if (gateway) {
      try {
        this.maybe = { gateway, method: "nat-pmp", internalPort, externalPort, lanIp };
        const r = await pmpMap(gateway, internalPort, externalPort, LEASE);
        if (!("lost" in r && r.lost)) this.maybe = undefined; // it answered (or never could): the outcome is known; a lost map reply is not
        if (r.supported && r.result === 0 && r.externalPort !== externalPort) {
          // The router gave another port than the one every link and check names: that forward is taken back rather than reported as working.
          this.current = { gateway, method: "nat-pmp", internalPort, externalPort: r.externalPort, lanIp };
          const closed = await this.unmap();
          status = { method: "none", externalPort, routerIp: gateway, externalIp: r.externalIp, error: `the router gave port ${r.externalPort} instead of ${externalPort}${closed ? "" : " (and it isn't confirmed closed)"}`, message: manualMessage(externalPort, lanIp, internalPort) };
        } else if (r.supported && r.result === 0) {
          this.current = { gateway, method: "nat-pmp", internalPort, externalPort: r.externalPort, lanIp };
          status = { method: "nat-pmp", externalPort: r.externalPort, routerIp: gateway, externalIp: r.externalIp, lifetimeSec: r.lifetimeSec, message: `Your router opened port ${r.externalPort} automatically (NAT-PMP).` };
        } else if (r.supported) {
          status = { method: "none", externalPort, routerIp: gateway, externalIp: r.externalIp, error: PMP_ERRORS[r.result] ?? `error ${r.result}`, message: manualMessage(externalPort, lanIp, internalPort) };
        }
      } catch {}
    }

    // A forward taken from NAT-PMP that couldn't be taken back stays tracked and nothing else is tried over it.
    if (this.current && status && status.method === "none") return status;
    // A NAT-PMP request whose reply never came may be open: that is settled before anything else is tried.
    if (this.maybe && !(await this.unmap())) return { method: "none", externalPort, routerIp: gateway, error: "an earlier request is not confirmed closed", message: "The router hasn't confirmed closing a port forward JamSesh asked for. Try again in a moment, or remove it in the router's settings." };

    if (!status || status.method === "none") {
      try {
        this.igd ??= await findIgd(gateway);
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
          this.maybe = { method: "upnp", internalPort, externalPort, lanIp };
          const add = await map(LEASE);
          // Many routers accept only permanent mappings (error 725): ask again without a lease.
          // Error 725 (a router that only makes permanent forwards) is not worked around: a forward that outlives a crash is not made on its own; the manual rule is shown.
          this.maybe = undefined; // it answered: the outcome is known
          if (add.ok) {
            this.current = { method: "upnp", internalPort, externalPort, lanIp };
            status = { method: "upnp", externalPort, routerIp: gateway, externalIp, lifetimeSec: LEASE, message: `Your router opened port ${externalPort} automatically (UPnP).` };
          } else {
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
    if (this.current) {
      this.fails = 0;
      this.granted = Math.min(LEASE, status.lifetimeSec ?? LEASE); // renewed by the lifetime the router actually granted
      this.schedule(this.granted * 500);
    }
    return status;
  }

  private unrenew() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number) {
    this.unrenew();
    this.timer = setTimeout(() => void this.renew(), this.renewAfterMs ?? Math.max(1000, ms));
    (this.timer as any).unref?.();
  }

  /** A renewal being sent: stopping waits for it, so it can't land after the final delete. */
  private renewing: Promise<void> = Promise.resolve();

  private renew() {
    this.renewing = this.renewing.then(() => this.renewOnce());
    return this.renewing;
  }

  private async renewOnce() {
    const c = this.current;
    if (!c) return;
    let problem: string | undefined;
    let lifetime = LEASE;
    try {
      if (c.method === "nat-pmp" && c.gateway) {
        const r = await pmpMap(c.gateway, c.internalPort, c.externalPort, LEASE);
        if (!r.supported || r.result !== 0) problem = "The router didn't confirm renewing the port forward.";
        else if (r.externalPort !== c.externalPort) {
          // The router moved it: the public link would point at the wrong port, so that forward is taken back and the loss is reported.
          this.current = { ...c, externalPort: r.externalPort };
          await this.unmap(true);
          this.onLost?.(`The router moved the port forward to port ${r.externalPort}, so remote access no longer works. Press Retry.`);
          return;
        } else lifetime = Math.min(LEASE, r.lifetimeSec || LEASE);
      } else if (c.method === "upnp" && this.igd) {
        const r = await soap(this.igd, "AddPortMapping", { NewRemoteHost: "", NewExternalPort: c.externalPort, NewProtocol: "TCP", NewInternalPort: c.internalPort, NewInternalClient: c.lanIp, NewEnabled: 1, NewPortMappingDescription: "JamSesh", NewLeaseDuration: LEASE });
        if (!r.ok) problem = `The router refused to renew the port forward (UPnP error ${r.errorCode ?? "unknown"}).`;
      }
    } catch (e) {
      problem = `The router didn't answer when renewing the port forward (${(e as Error).message}).`;
    }
    if (!this.current) return; // taken down meanwhile
    if (!problem) {
      this.fails = 0;
      this.granted = lifetime;
      this.schedule(lifetime * 500);
      return;
    }
    if (++this.fails >= MAX_RENEW_FAILS) {
      this.onLost?.(`${problem} Remote access may stop working soon. Press Retry.`);
      return; // nothing more is scheduled; the forward is still tracked so turning off tries to remove it
    }
    this.schedule(RETRY_MS);
  }

  /** Removes the mapping (NAT-PMP: lifetime 0; UPnP: DeletePortMapping). True once the router has said it is gone (or there was none); false when that couldn't be confirmed, and the mapping is kept to try again. */
  unmap(fromRenewal = false): Promise<boolean> {
    // One delete at a time: a second caller shares the first's outcome instead of seeing an emptied record and calling it closed.
    return (this.unmapping ??= this.unmapOnce(fromRenewal).finally(() => (this.unmapping = undefined)));
  }
  private unmapping?: Promise<boolean>;

  /** `fromRenewal`: called from inside the renewal itself, which must not wait for itself. */
  private async unmapOnce(fromRenewal: boolean): Promise<boolean> {
    this.unrenew();
    const c = this.current ?? this.maybe;
    this.current = undefined; // a renewal queued from here on finds nothing to renew
    this.maybe = undefined;
    if (!fromRenewal) await this.renewing.catch(() => {});
    if (!c) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (c.method === "nat-pmp" && c.gateway) {
          const raw = await pmpExchange(c.gateway, natPmpMapRequest(c.internalPort, 0, 0), 2);
          const r = raw && decodeNatPmp(raw);
          if (r && r.kind === "map" && r.result === 0) return true;
        } else if (c.method === "upnp" && this.igd) {
          const r = await soap(this.igd, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: c.externalPort, NewProtocol: "TCP" });
          if (r.ok || r.errorCode === 714) return true; // 714: there is no such mapping any more
        } else return true; // a manual rule or none: nothing of ours to remove
      } catch {}
    }
    this.current = c; // still open as far as anyone knows
    return false;
  }
}
