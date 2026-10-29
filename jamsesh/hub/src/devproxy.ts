// Dev servers on the host. An agent's dev server runs on its own machine; the hub opens a
// port here that forwards HTTP and WebSockets (so hot reload works) to it, and everyone
// opens it at the host's address. The ports are on the room's network, so each request
// has to come from the host itself or carry a paired device's token (the cookie a paired
// browser already holds, which browsers send to every port of the same address, or a
// bearer header such as the Mac app's relay adds).
import { createHash } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { bus } from "./bus";
import { config, hostAddresses } from "./config";
import { newId } from "./store";
import type { Session } from "./session";
import type { DevServer, Platform } from "./types";

/** How long a dev server may stay unreachable before its tile clears itself. */
export const DEV_GONE_MS = 5 * 60_000;
/** Most dev servers one agent can keep on the host. */
export const MAX_PER_AGENT = 6;

interface WsData {
  path: string;
  protocols: string[];
  up?: WebSocket;
  queue: (string | Uint8Array)[];
  /** The paired device that opened it (none from the host itself), so revoking it closes the socket. */
  deviceId?: string;
}

const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"];

export class DevProxy {
  /** Each dev port's listener, with the target it forwards to (changed in place when a registration moves to another target). */
  private listeners = new Map<string, { server: Server<WsData>; target: { v: string } }>();
  private tokenCache: { at: number; hashes: Map<string, string> } = { at: 0, hashes: new Map() };
  /** Open WebSockets on every dev port. */
  private sockets = new Set<ServerWebSocket<WsData>>();
  private offRevoked: () => void;

  /** Ports on this machine that are the hub's own (it, the canvas): a dev port can't point at them. */
  private reserved = new Set<number>([config.port, config.figcraftPort]);

  constructor(private session: Session) {
    // Disconnecting a device takes it off the dev ports at once: no cached token, no open sockets.
    this.offRevoked = bus.on((msg) => {
      const m = msg as { type: string; deviceId?: string };
      if (m.type !== "revoked" || !m.deviceId) return;
      this.tokenCache.at = 0;
      for (const ws of this.sockets) if (ws.data.deviceId === m.deviceId) ws.close(4401, "disconnected");
    });
  }

  reserve(port: number) {
    this.reserved.add(port);
  }

  restore() {
    for (const d of this.session.devservers()) this.listen(d).catch(() => this.session.store.patch("devservers", d.id, { up: false }));
  }

  async register(opts: { agentId: string; name: string; target: string; platform?: Platform | null }): Promise<DevServer> {
    const target = normalizeTarget(opts.target);
    // Pointing a dev port at the hub would give every paired device the host's own trust.
    const [targetHost, targetPort] = [target.replace(/:\d+$/, ""), Number(target.replace(/^.*:/, ""))];
    if (this.reserved.has(targetPort) && (isLoopback(targetHost) || hostAddresses().some((a) => a.host === targetHost)))
      throw new Error(`Port ${targetPort} on this machine belongs to JamSesh itself; give your dev server's own port.`);
    const existing = this.session.devservers().find((d) => d.agentId === opts.agentId && (d.name === opts.name || d.target === target));
    if (!existing && this.session.devservers().filter((d) => d.agentId === opts.agentId).length >= MAX_PER_AGENT)
      throw new Error(`You already have ${MAX_PER_AGENT} dev servers on the host. Remove one with jam_devserver_remove first.`);
    const used = new Set(this.session.devservers().map((d) => d.hostPort));
    // A registration that is being replaced keeps its listener until the new one is bound.
    let hostPort = existing?.hostPort ?? config.devPortStart;
    const own = () => !!existing && this.listeners.get(existing.id)?.server.port === hostPort;
    while ((used.has(hostPort) && hostPort !== existing?.hostPort) || (!own() && !portFree(hostPort))) hostPort++;
    const d: DevServer = {
      id: existing?.id ?? newId("dev"),
      agentId: opts.agentId,
      name: opts.name,
      target,
      hostPort,
      url: `http://${config.publicHost}:${hostPort}`,
      platform: opts.platform ?? this.session.agent(opts.agentId)?.platform ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      generation: (existing?.generation ?? 0) + 1,
      up: false,
    };
    // The new generation is on record before anything is awaited: a refresh still holding the old one
    // sees it changed and leaves this registration (and its listener) alone.
    this.session.store.put("devservers", d, false);
    try {
      await this.listen(d);
    } catch (e) {
      // The bind failed: the earlier registration, still listening, stays exactly as it was.
      if (existing) this.session.store.put("devservers", existing, false);
      else this.session.store.remove("devservers", d.id);
      throw e;
    }
    const up = await this.check(d);
    // Registered again (or removed) meanwhile: this registration is no longer the one to publish.
    const now = this.session.store.get("devservers", d.id);
    if (!now) {
      this.close(d.id); // taken off the board meanwhile: its port closes again
      return d;
    }
    if ((now.generation ?? 0) !== d.generation) return now;
    this.session.store.put("devservers", { ...d, up, problem: undefined, downSince: undefined });
    const agent = this.session.agent(opts.agentId);
    this.session.upsertArtifact({
      id: this.artifactOf(d)?.id,
      kind: "devserver",
      stage: "built",
      title: opts.name,
      url: d.url,
      agentId: opts.agentId,
      platform: d.platform,
      note: up ? `Live at ${d.url}` : `Registered; ${target} isn't answering yet`,
    });
    if (agent) this.session.touchAgent(agent.id, { activity: `Dev server: ${opts.name}` });
    return { ...d, up };
  }

  private artifactOf(d: DevServer) {
    return this.session.artifacts().find((a) => a.kind === "devserver" && a.url === d.url);
  }

  /** Whether a request may use a dev port: from the host itself, or from a paired device. */
  allowed(req: Request, ip: string): boolean {
    return this.who(req, ip) !== null;
  }

  /** Who may use a dev port: "" for the host itself, a paired device's id, or null for nobody. */
  who(req: Request, ip: string): string | null {
    if (isLoopback(ip)) return "";
    // The dev app may send its own Authorization header, so try the cookie's token too.
    const tokens = [req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""), cookieValue(req.headers.get("cookie"), "jam_token")].filter((t): t is string => !!t);
    if (!tokens.length) return null;
    const now = Date.now();
    if (now - this.tokenCache.at > 3000) {
      const devices = this.session.store.setting<{ id: string; tokenHash: string; revoked: boolean }[]>("pairedDevices", []);
      this.tokenCache = { at: now, hashes: new Map(devices.filter((x) => !x.revoked).map((x) => [x.tokenHash, x.id])) };
    }
    for (const t of tokens) {
      const id = this.tokenCache.hashes.get(createHash("sha256").update(t).digest("hex"));
      if (id !== undefined) return id;
    }
    return null;
  }

  private async listen(d: DevServer) {
    const proxy = this;
    const held = this.listeners.get(d.id);
    // The same port again: the listener stays up and only its target changes, so nothing can fail or drop.
    if (held && held.server.port === d.hostPort) {
      held.target.v = d.target;
      return;
    }
    const ref = { v: d.target };
    const server = Bun.serve<WsData, never>({
      hostname: "0.0.0.0",
      port: d.hostPort,
      idleTimeout: 120,
      async fetch(req, srv) {
        const ip = srv.requestIP(req)?.address ?? "";
        const deviceId = proxy.who(req, ip);
        if (deviceId === null) return denied(req);
        const url = new URL(req.url);
        const path = `${url.pathname}${url.search}`;
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
          const headers = protocols.length ? { "sec-websocket-protocol": protocols[0] } : undefined;
          if (srv.upgrade(req, { data: { path, protocols, queue: [], deviceId: deviceId || undefined }, headers })) return undefined;
          return new Response("expected a WebSocket", { status: 400 });
        }
        return forward(req, ref.v, path);
      },
      websocket: {
        open(ws: ServerWebSocket<WsData>) {
          proxy.sockets.add(ws);
          const target = ref.v;
          const up = new WebSocket(`ws://${target}${ws.data.path}`, { protocols: ws.data.protocols.slice(0, 1), headers: { origin: `http://${target}` } } as any);
          up.binaryType = "arraybuffer";
          ws.data.up = up;
          up.onopen = () => {
            for (const m of ws.data.queue) up.send(m as any);
            ws.data.queue = [];
          };
          up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
          up.onclose = () => ws.close();
          up.onerror = () => ws.close();
        },
        message(ws, m) {
          const up = ws.data.up;
          const out = typeof m === "string" ? m : new Uint8Array(m);
          if (up?.readyState === WebSocket.OPEN) up.send(out as any);
          else ws.data.queue.push(out);
        },
        close(ws) {
          proxy.sockets.delete(ws);
          try {
            ws.data.up?.close();
          } catch {}
        },
      },
    });
    this.listeners.set(d.id, { server, target: ref });
    // Moved to another port: the old one closes only now that the new one is up.
    held?.server.stop(true);
  }

  /** Whether the dev server itself answers (asked directly, not through the forwarder). */
  async check(d: DevServer): Promise<boolean> {
    try {
      const r = await fetch(`http://${d.target}/`, { signal: AbortSignal.timeout(3000), redirect: "manual", headers: { "accept-encoding": "identity" } });
      void r.body?.cancel();
      return r.status > 0;
    } catch {
      return false;
    }
  }

  /** How long a dev server may stay unreachable before it's taken off the board (a field so a test can shorten it). */
  goneMs = DEV_GONE_MS;

  /** What happened to a build that stopped answering, in plain words. */
  explain(d: DevServer): string {
    const owner = this.session.agents().find((a) => a.id === d.agentId);
    if (!owner || owner.status === "offline") return `${owner?.ownerName ?? "Its owner"}'s ${owner?.name ?? "agent"} stopped this build`;
    return `The build at port ${d.target.replace(/^.*:/, "")} stopped responding`;
  }

  /**
   * Re-checks every dev server. One that stops answering says why on its tile and tells its agent;
   * if it stays down a few minutes its tile clears itself.
   */
  async refresh(now = Date.now()) {
    for (const checked of this.session.devservers()) {
      const up = await this.check(checked);
      // Registered again (or removed) while it was being checked: that result is about a server that's gone.
      const d = this.session.store.get("devservers", checked.id);
      if (!d || (d.generation ?? 0) !== (checked.generation ?? 0) || d.target !== checked.target) continue;
      if (up) {
        if (!d.up || d.problem || d.downSince) this.session.store.patch("devservers", d.id, { up: true, problem: undefined, downSince: undefined });
        continue;
      }
      const since = d.downSince ?? now;
      const problem = this.explain(d);
      if (!d.downSince) this.session.tellAgent(d.agentId, `${problem}. Its tile on the big screen says so and clears in ${Math.round(this.goneMs / 60_000)} minutes. Start it again and call jam_devserver to put it back.`);
      if (d.up || d.problem !== problem || !d.downSince) this.session.store.patch("devservers", d.id, { up: false, problem, downSince: since });
      if (now - since > this.goneMs) {
        this.session.tellAgent(d.agentId, `Took "${d.name}" off the board: it didn't answer for ${Math.round(this.goneMs / 60_000)} minutes. Call jam_devserver again when it runs.`);
        this.remove(d.id);
      }
    }
  }

  close(id: string) {
    this.listeners.get(id)?.server.stop(true);
    this.listeners.delete(id);
  }

  /** Takes a dev server off the host: its port closes and its tile goes away. */
  remove(id: string) {
    const d = this.session.devservers().find((x) => x.id === id);
    this.close(id);
    this.session.store.remove("devservers", id);
    const art = d && this.artifactOf(d);
    if (art) this.session.store.remove("artifacts", art.id);
  }

  stop() {
    this.offRevoked();
    for (const id of [...this.listeners.keys()]) this.close(id);
  }
}

/** Passes a request to the dev server and its answer back, without the room's credentials (or the host window key). */
async function forward(req: Request, target: string, path: string): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  headers.set("host", target);
  headers.set("accept-encoding", "identity");
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+jst_/i.test(auth)) headers.delete("authorization");
  const cookie = headers.get("cookie");
  if (cookie) {
    const kept = cookie.split(/;\s*/).filter((c) => !c.startsWith("jam_token=") && !c.startsWith("jam_window="));
    if (kept.length) headers.set("cookie", kept.join("; "));
    else headers.delete("cookie");
  }
  const origin = headers.get("origin");
  if (origin) headers.set("origin", `http://${target}`);
  try {
    const r = await fetch(`http://${target}${path}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, redirect: "manual" } as RequestInit);
    const out = new Headers(r.headers);
    for (const h of HOP) out.delete(h);
    out.delete("content-encoding");
    const loc = out.get("location");
    if (loc?.startsWith(`http://${target}`)) out.set("location", loc.slice(`http://${target}`.length) || "/");
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
  } catch {
    return new Response("That build isn't answering right now. Its agent may have stopped it, or it crashed.", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with JamSesh</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;background:Canvas;color:CanvasText}
main{max-width:30em}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;opacity:.8}</style>
<main><h1>This is a JamSesh dev server</h1><p>It's only open to people in the session. Open the JamSesh screen on this computer first (enter the code shown on the host's screen), then come back and reload this page.</p>
<p>Joined through the JamSesh app? Open the dev server from its tile in the app.</p></main>`;

function denied(req: Request) {
  if ((req.headers.get("accept") ?? "").includes("text/html")) return new Response(PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  return new Response("Pair this device with JamSesh first.", { status: 401, headers: { "cache-control": "no-store" } });
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function cookieValue(header: string | null, name: string) {
  for (const part of (header ?? "").split(/;\s*/)) if (part.startsWith(`${name}=`)) return decodeURIComponent(part.slice(name.length + 1));
  return null;
}

/** Nothing listens on the port on any interface. */
function portFree(port: number) {
  return Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).stdout.toString().trim() === "";
}

/** "http://192.168.1.4:5173/" or "192.168.1.4:5173" → "192.168.1.4:5173". */
export function normalizeTarget(t: string) {
  const s = t.trim().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  const m = s.match(/^([\w.-]+):(\d+)$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`Give the dev server as host:port (got "${t}")`);
  return s.replace(/^localhost:/, "127.0.0.1:");
}

/**
 * The address a dev server is reached at, from where the agent connects: its own machine only.
 * "localhost" and friends become the agent's address; any other host has to be that address.
 */
export function ownTarget(raw: string, agentIp: string): string {
  const ip = agentIp.replace(/^::ffff:/, "");
  const loop = isLoopback(ip) || ip === "";
  const local = loop ? "127.0.0.1" : ip;
  const withHost = raw.trim().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  const m = withHost.match(/^([^:]+):(\d+)$/) ?? (/^\d+$/.test(withHost) ? [withHost, "localhost", withHost] : null);
  if (!m) throw new Error(`Give the dev server as a local URL like http://localhost:5173 (got "${raw}").`);
  const host = m[1].toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(host) || host === local) return normalizeTarget(`${local}:${m[2]}`);
  throw new Error(`A dev server has to run on your own machine; ${host} isn't it. Give its local URL (for example http://localhost:${m[2]}).`);
}
