// HTTP, WebSocket and MCP on one port.
import { wikiRoute } from "./wiki/routes";
import type { Server, ServerWebSocket } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import type { HostWindows, PairedDevice } from "./auth";
import { AttachmentError, MAX_UPLOAD_BYTES, type AttachmentRef } from "./attachments";
import { bus } from "./bus";
import { ENROL_SCRIPT, ENROL_SECONDS } from "./audio/enrol";
import { learningNote } from "./audio/voiceprint";
import { describeError } from "./brain/llm";
import { synthesize } from "./brain/speech";
import { config, sameLan } from "./config";
import type { Hub } from "./hub";
import { agentGuide, agentIntro, joinScript, hookScript } from "./install-scripts";
import { publicEvent } from "./session";
import { projectsRoute } from "./projects-api";
import { launcherMarkdown, skillMarkdown } from "./skill";
import type { BusMessage, DriveEvent, EventKind, Stage } from "./types";

type WsData = { deviceId: string | null; caller?: string | null; appId?: string; collab?: string; upstream?: WebSocket; queue?: (string | Buffer)[]; pairedId?: string | null; hostWindow?: boolean; driveDenied?: number };

/** Open sockets by device, for relaying WebRTC signaling between devices. */
const sockets = new Map<string, Set<ServerWebSocket<WsData>>>();

/**
 * A device is now registered to `owner`: sockets another window opened for it earlier (before it was
 * registered) stop speaking for it. They keep the live session, as a socket for no device.
 */
function dropForeignSockets(deviceId: string, owner: string | undefined) {
  const set = sockets.get(deviceId);
  if (!set || !owner) return;
  for (const ws of [...set]) {
    if (ws.data.caller === owner) continue;
    set.delete(ws);
    ws.data.deviceId = null;
  }
  if (!set.size) sockets.delete(deviceId);
}

/** The device a socket still speaks for: checked again on each use, so a later registration by another window wins. */
function speaker(hub: Hub, ws: ServerWebSocket<WsData>): string | null {
  const id = ws.data.deviceId;
  if (!id) return null;
  const owner = hub.session.store.get("devices", id)?.pairedId;
  if (owner && owner !== ws.data.caller && (owner === "host" || hub.auth.live(owner))) {
    dropForeignSockets(id, owner);
    return null;
  }
  return id;
}

// Nothing to return means the thing was deleted (a queued edit to something gone): 410, not a crash.
export const json = (v: unknown, status = 200) => (v === undefined ? Response.json({ error: "That was deleted." }, { status: 410 }) : Response.json(v, { status, headers: { "cache-control": "no-store" } }));

/** API paths (after /api) that stand for a person: never callable with an agent's credential. */
const VOICE_NAME_MAX = 64;
export const VOICE_PREVIEW_COOLDOWN_MS = 3_000;
const lastVoicePreview = new Map<string, number>();

export const HUMAN_ONLY = /^\/(say|audio|devices|prompt-window(\/start)?|record\/(start|stop|send)|fonts\/(want|lend|decline|withdraw)|apps(\/[\w-]+(\/(control|input))?)?|annotations(\/send|\/[\w-]+)?|people(\/[\w-]+(\/(voice(\/start|\/end)?|voiceprint|photo))?)?|settings|directives(\/[\w-]+(\/reassign)?)?|triage\/[\w-]+(\/(send|add|merge|replace|dismiss))?|workers|agents\/[\w-]+\/remove|removed-chats\/[\w-]+\/allow|voice-preview|build-requests\/[\w-]+|utterances\/[\w-]+\/assign|stage(\/(unlock|restore|expand|ready\/[\w-]+))?|drive\/(start|stop|pass|together)|screens\/config|display|show-requests\/[\w-]+|shares(\/.*)?|invite|attachments|host\/open-url|layouts|snapshots|wiki(\/.*)?)$/;
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** A stable id for this host (what /api/pair/info returns), made on first use. */
function hostIdOf(hub: Hub) {
  let hostId = hub.session.store.setting<string>("hostId", "");
  if (!hostId) hub.session.store.setSetting("hostId", (hostId = crypto.randomUUID().slice(0, 12)));
  return hostId;
}

/** Human-only paths whose personId is the person acted on, not the caller. */
const TARGETS_A_PERSON = /^\/(utterances\/[\w-]+\/assign|shares\/request|devices)$/;
/** Settings only the host machine may change (SPEC 14, host-only). */
const HOST_ONLY_SETTINGS = ["gatewayKey", "models", "hostControl", "brainEnabled", "fastEngine"] as const;

const RELAY_HEADERS = ["x-forwarded-host", "x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"];

/** Host names this hub answers to: loopback, any IP address, .local names, and its own domains. */
function knownHost(req: Request, hub: Hub) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || /^[\d.]+$/.test(host) || host.includes(":")) return true;
  const domain = hub.net.status().domain?.toLowerCase();
  if (domain && (host === domain || host.endsWith(`.${domain}`))) return true;
  const extra = [process.env.JAMSESH_PUBLIC_URL, process.env.JAMSESH_PUBLIC_HOST].map((u) => (u ? u.replace(/^https?:\/\//, "").replace(/[:/].*$/, "").toLowerCase() : ""));
  return extra.includes(host);
}

/** A browser's WebSocket carries its page's Origin; it must be this host (or the Mac app relaying it). */
/**
 * The device a live-session socket speaks for (RTC signaling, mic level, and the share cleanup when
 * its last socket closes): the one it names only when that device belongs to this window (its pairing,
 * or "host" for the host's own windows). A device not registered yet, or whose window's pairing is
 * gone, is claimed for this window. Any other id gets a socket that speaks for no device.
 */
function socketDevice(hub: Hub, wanted: string | null, caller: string | null): string | null {
  if (!wanted || !caller || !/^[\w-]{1,64}$/.test(wanted)) return null;
  const d = hub.session.store.get("devices", wanted);
  if (!d) return wanted;
  const owner = d.pairedId && (d.pairedId === "host" || hub.auth.live(d.pairedId)) ? d.pairedId : null;
  if (owner && owner !== caller) return null;
  if (!owner) hub.session.touchDevice(wanted, { pairedId: caller });
  return wanted;
}

export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser
  try {
    const o = new URL(origin).host.toLowerCase();
    return o === (req.headers.get("host") ?? "").toLowerCase() || o === (req.headers.get("x-forwarded-host") ?? "").toLowerCase();
  } catch {
    return false;
  }
}
const bad = (msg: string, status = 400) => json({ error: msg }, status);

/** The live state for whoever asked: an agent's copy leaves out the Tasks board's proposals. */
function forCaller<T extends { triage: unknown }>(state: T, agent: boolean): T {
  return agent ? { ...state, triage: [] } : state;
}

function isLocal(ip: string) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function startHttp(hub: Hub, port = config.port, tls?: { cert: string; key: string; serverName: string }[]): Server<WsData> {
  const s = hub.session;
  s.deviceOnline = (id) => (sockets.get(id)?.size ?? 0) > 0;

  const tokenOf = (req: Request, url: URL) =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? cookie(req, "jam_token") ?? url.searchParams.get("token");

  // The dev app may send its own Authorization header, so the paired token can be in the cookie instead.
  const anyToken = (hub: Hub, req: Request, url: URL, ip: string) => {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    for (const t of [bearer, cookie(req, "jam_token"), url.searchParams.get("token")]) {
      const d = t ? hub.auth.check(t, ip) : null;
      if (d) return d;
    }
    return null;
  };

  const PUBLIC_FILES = /^\/(assets\/|icons\/|fonts\/|favicon\.svg$|manifest\.webmanifest$|sw\.js$)/;

  const server = Bun.serve<WsData, any>({
    port,
    hostname: "0.0.0.0",
    ...(tls ? { tls } : {}),
    idleTimeout: 255,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const peer = srv.requestIP(req)?.address ?? "0.0.0.0";
      if (isLocal(peer)) viaLoopback.add(req);
      // Loopback is the host's own windows only when nothing relayed it: a tunnel, a proxy, or the
      // Mac app's relay (which carries agents' traffic) all mark their requests.
      const relayed = RELAY_HEADERS.some((h) => req.headers.has(h));
      const ip = relayed && isLocal(peer) ? "relayed" : peer;
      const path = url.pathname;
      const local = isLocal(ip);
      // On the host, loopback alone isn't a person (every process here reaches it): the host's own
      // windows also carry the hub's window key (SPEC 14, HostWindows in auth.ts).
      const hostWindow = local && hub.auth.windows.matches(cookie(req, "jam_window"));
      // DNS rebinding: a web page can't reach the host under a name of its own choosing.
      if (!knownHost(req, hub)) return bad("Unknown host name.", 421);
      try {
        // ---- open to anyone: health, pairing, the app shell, the canvas relay ----
        if (path.endsWith("/healthz")) return new Response("ok");
        // Dev servers on their own subdomain of the host's address: dev-5100.<name>.duckdns.org.
        const dev = devTarget(req, hub);
        if (dev) {
          if (!local && !anyToken(hub, req, url, ip)) return new Response("Pair this device with JamSesh first: open the host's address and enter the code from the big screen, under the QR code.", { status: 401 });
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const who = local ? null : anyToken(hub, req, url, ip);
            if (srv.upgrade(req, { data: { deviceId: null, collab: `${url.pathname}${url.search}`, devPort: dev, pairedId: who?.id ?? null } as any })) return undefined as any;
          }
          return proxyHttp(req, url, dev);
        }
        // The host's own windows are trusted without a token, so a page on another site can't post as them.
        if (local && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return bad("Not from this site.", 403);
        // A one-time host link: gives this browser the window key (HttpOnly, so page scripts never
        // see it), then shows the page. Only on 127.0.0.1, so the cookie never reaches dev servers,
        // which tiles open as localhost:<port>.
        if (path === "/host-window" && local && req.method === "GET") return await hostWindowRoute(hub.auth.windows, req, url);
        // A new host link for `jamsesh host` on a hub that's already running (a terminal-started hub
        // only): the caller proves it's this Mac's user by the secret in a mode-600 file of the hub's.
        if (path === "/api/host-link" && local && req.method === "POST") {
          const given = req.headers.get("x-jam-link-secret") ?? "";
          const secret = hub.auth.windows.linkSecret;
          if (!secret || !hub.auth.windows.matchesSecret(given)) return bad("Not allowed.", 403);
          return json({ url: `http://127.0.0.1:${url.port || config.port}/host-window?once=${hub.auth.windows.mint()}&next=%2Fhost` });
        }
        // Remote-access setup is only for someone at the host.
        if (local && path.startsWith("/api/net/")) {
          // A JSON body only: a form or text post from another site can't change remote access.
          if (req.method !== "GET" && !(req.headers.get("content-type") ?? "").includes("application/json")) return bad("Send JSON.", 415);
          if (req.method !== "GET" && !hostWindow) return bad(NOT_THE_HOST_WINDOW, 403);
          const r = await hub.net.routes(req, url);
          if (r) return r;
        }
        // The Projects picker's data: the host's own windows only (project names and who came).
        if (path.startsWith("/api/projects")) {
          const r = await projectsRoute(req, url, { local, hostWindow });
          if (r) return r;
        }
        if (path === "/api/pair" && req.method === "POST") return pairRoute(hub, req, url, ip);
        // The Mac app's credential for agents on that Mac: separate from the person's window, so
        // nothing an agent sends can approve a build or speak as a person.
        if (path === "/api/pair/agents" && req.method === "POST") {
          // On the host only the app (it holds the window key) issues the host's agents credential:
          // anyone else on loopback could otherwise revoke the live one and take its place.
          if (local && !hostWindow) return bad(NOT_THE_HOST_WINDOW, 403);
          const owner = local ? null : hub.auth.check(tokenOf(req, url), ip);
          if (!local && owner?.kind !== "browser") return bad("Pair this Mac first.", 401);
          const who = owner?.personId ? s.person(owner.personId)?.name : undefined;
          const personId = owner ? owner.personId : s.store.setting<string>("hostPersonId", "") || null;
          // One live credential per window: the app issues a new one on every launch.
          hub.auth.revokeAgentsOf(owner?.id ?? "host");
          const r = hub.auth.issue({ kind: "agent", label: `${who ? `${who}'s agents` : "Agents"} on ${owner?.label.split(" · ")[0] ?? "the host"}`, personId, ip, ownerDeviceId: owner?.id ?? "host" });
          return json({ token: r.token, deviceId: r.device.id });
        }
        // The code pairs a person's window, so only the host's own windows read it (not any process on the host).
        if (path === "/api/pair/code") return hostWindow ? json({ ...hub.auth.current(), addresses: s.addresses() }) : bad(local ? NOT_THE_HOST_WINDOW : "Only the host shows the code.", 403);
        if (path === "/api/pair/info") {
          // A stable id for this host, so a window that reaches several hosts at one address (the Mac
          // app's relay) keeps each host's identity and unsent changes apart.
          return json({ name: s.settings().sessionName, brainName: s.settings().brainName, hostId: hostIdOf(hub) });
        }
        if (path === "/agent" || path === "/agent.md") return agentRoute(hub, req, url, ip);
        if (path === "/collab" || path.startsWith("/collab/")) {
          // The canvas server checks its own link tokens; JamSesh also requires a current pairing, so
          // a disconnected device can't come back with a link it kept.
          const who = local ? null : hub.auth.check(tokenOf(req, url), ip);
          if (!local && !who) return bad("This device isn't paired with this JamSesh host.", 401);
          if (srv.upgrade(req, { data: { deviceId: null, collab: `${url.pathname.replace(/^\/collab/, "") || "/"}${url.search}`, pairedId: who?.id ?? null } as any })) return undefined as any;
          return bad("expected a WebSocket");
        }

        const device = local ? null : hub.auth.check(tokenOf(req, url), ip);
        const ok = local || !!device;

        if (path === "/") {
          if (local) return Response.redirect("/host", 302);
          if (!wantsHtml(req)) return new Response(agentIntro(originOf(req, url)), { headers: { "content-type": "text/markdown; charset=utf-8" } });
          return Response.redirect(ok ? "/client" : "/connect", 302);
        }
        // The QR code's link, fed to Claude Code or Codex instead of a browser: the agent's guide.
        if (path === "/connect" && url.searchParams.get("c") && !wantsHtml(req) && req.headers.get("sec-fetch-mode") !== "navigate") return agentRoute(hub, req, url, ip);
        if (PUBLIC_FILES.test(path) || path === "/connect") return webApp(path);
        // The Mac app, for people joining from a browser. It holds no secrets.
        if (path === "/download/mac") {
          const dmg = [join(config.home, "JamSesh.dmg"), join(config.repo, "jamsesh", "app", "dist", "JamSesh.dmg")].find((f) => existsSync(f));
          if (!dmg) return new Response("The host doesn't have the Mac app to share yet.", { status: 404 });
          return new Response(Bun.file(dmg), { headers: { "content-type": "application/x-apple-diskimage", "content-disposition": 'attachment; filename="JamSesh.dmg"' } });
        }
        if (!ok) {
          if (wantsHtml(req) && !path.startsWith("/api") && path !== "/mcp" && path !== "/ws") return Response.redirect(`/connect?next=${encodeURIComponent(path + url.search)}`, 302);
          return bad("This device isn't paired with this JamSesh host. Open /connect and enter the code on the big screen, under the QR code.", 401);
        }
        if ((path === "/host" || path.startsWith("/setup")) && !local) return Response.redirect("/client", 302);

        if (path === "/mcp") return hub.mcp.handle(req, ip, device?.id ?? (local ? "host" : null), originOf(req, url));
        // A live Simulator or Mac app's frames (binary JPEGs): for people's windows only, a paired one or
        // the host's own. Agents have nothing to watch there, and loopback alone is any process on the host.
        const appWs = path.match(/^\/ws\/app\/([\w-]+)$/);
        if (appWs) {
          if (!sameOrigin(req)) return bad("Not from this site.", 403);
          if (!hostWindow && device?.kind !== "browser") return bad(local ? NOT_THE_HOST_WINDOW : "That's for people.", 403);
          if (!hub.live.get(appWs[1])) return bad("That app isn't live.", 404);
          if (srv.upgrade(req, { data: { deviceId: null, appId: appWs[1], pairedId: device?.id ?? null } as any })) return undefined as any;
          return bad("expected a WebSocket");
        }
        if (path === "/ws") {
          // A page on another site can't open the live session (and read the room) from a browser.
          if (!sameOrigin(req)) return bad("Not from this site.", 403);
          const caller = hostWindow ? "host" : device?.kind === "browser" ? device.id : null;
          if (srv.upgrade(req, { data: { deviceId: socketDevice(hub, url.searchParams.get("device"), caller), caller, local, hostWindow, pairedId: device?.id ?? null, agent: device?.kind === "agent" } as any })) return undefined as any;
          return bad("expected a WebSocket");
        }
        if (path === "/launcher.md") return new Response(launcherMarkdown(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
        if (path === "/skill.md") return new Response(skillMarkdown(hub, originOf(req, url)), { headers: { "content-type": "text/markdown; charset=utf-8" } });
        if (path === "/hook.sh") return new Response(hookScript(hub), { headers: { "content-type": "text/x-shellscript" } });
        if (path === "/agent/setup.sh") {
          // From the Mac app: agents talk to the app's relay on this computer, which adds the
          // Mac's credentials, so the script carries no token and survives switching hosts.
          const relay = Number(url.searchParams.get("relay"));
          const script = Number.isInteger(relay) && relay > 1023 && relay < 65536 ? joinScript(hub, `http://127.0.0.1:${relay}`, "") : joinScript(hub, originOf(req, url), tokenOf(req, url) ?? "");
          return new Response(script, { headers: { "content-type": "text/x-shellscript" } });
        }
        if (path.startsWith("/api/")) {
          // A change made for another host (an offline queue replayed after the relay switched hosts) never lands here.
          const meant = req.headers.get("x-jam-host");
          if (meant && MUTATING.has(req.method) && meant !== hostIdOf(hub)) return new Response("That change was made for a different JamSesh host.", { status: 409, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
          return await idempotent(hub, req, path, () => api(hub, req, url, ip, device, hostWindow));
        }
        // A frame drawn at the size the screen asked for (the stored render is capped at 1600 px): /renders/full/<artifact id>.png?size=2400
        const full = path.match(/^\/renders\/full\/([\w-]+)\.png$/);
        if (full) return fullRender(hub, full[1], Number(url.searchParams.get("size")));
        if (path.startsWith("/renders/")) return file(join(hub.canvas.rendersDir, path.slice("/renders/".length)), hub.canvas.rendersDir);
        if (path === "/canvas" || path.startsWith("/canvas/")) {
          if (!config.canvasDist) return new Response("The canvas web build isn't installed. Run jamsesh/install.sh.", { status: 404 });
          const rel = path.replace(/^\/canvas\/?/, "") || "index.html";
          return file(join(config.canvasDist, rel), config.canvasDist, true);
        }
        return webApp(path);
      } catch (e) {
        console.error("http:", path, e);
        return bad(e instanceof Error ? e.message : String(e), 500);
      }
    },
    websocket: {
      idleTimeout: 120,
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.appId) {
          const pid = (ws.data as any).pairedId;
          const offRevoked = bus.on((msg) => (msg as any).type === "revoked" && pid && (msg as any).deviceId === pid && ws.close(4401, "disconnected"));
          // A slow viewer skips frames instead of falling behind: only the newest picture matters.
          const unsub = hub.live.subscribe(ws.data.appId, (f) => ws.getBufferedAmount() < 1_500_000 && ws.sendBinary(f));
          (ws as any).off = () => (offRevoked(), unsub?.());
          if (!unsub) ws.close(4404, "not live");
          return;
        }
        if (ws.data.collab != null) {
          // Disconnected in Settings: the canvas (or dev server) connection closes too.
          const pid = (ws.data as any).pairedId;
          if (pid) (ws as any).off = bus.on((msg) => (msg as any).type === "revoked" && (msg as any).deviceId === pid && ws.close(4401, "disconnected"));
          return openCollab(ws, hub);
        }
        // Every open window counts, the host's own big screen included: the Mac stays awake for it.
        hub.peopleOnline++;
        // Agents don't see proposals nobody has accepted (4.1): no triage in their state, and no patches of it.
        const agent = !!(ws.data as any).agent;
        ws.send(JSON.stringify({ type: "state", state: forCaller(s.state(), agent) } satisfies BusMessage));
        const off = bus.on((msg) => {
          // Disconnected in Settings: this window's live session ends now, not at its next request.
          if ((msg as any).type === "revoked" && (msg as any).deviceId && (msg as any).deviceId === (ws.data as any).pairedId) return void ws.close(4401, "disconnected");
          if (msg.type === "event" && msg.event.data?.embedding) {
            const { embedding: _drop, ...data } = msg.event.data;
            msg = { ...msg, event: { ...msg.event, data } };
          }
          if (agent && msg.type === "patch" && msg.key === "triage") return;
          ws.send(JSON.stringify(msg));
        });
        (ws as any).off = off;
        if (ws.data.deviceId) {
          const set = sockets.get(ws.data.deviceId) ?? new Set();
          set.add(ws);
          sockets.set(ws.data.deviceId, set);
        }
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        if (ws.data.appId) return;
        if (ws.data.collab != null) {
          const up = ws.data.upstream;
          if (up?.readyState === WebSocket.OPEN) up.send(raw as any);
          else (ws.data.queue ??= []).push(raw);
          return;
        }
        try {
          const m = JSON.parse(String(raw));
          const me = m.type === "level" || m.type === "rtc" ? speaker(hub, ws) : null;
          if (m.type === "level" && me) {
            bus.send({ type: "level", deviceId: me, level: m.level });
          } else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t, now: Date.now() }));
          else if (m.type === "drive") driveFrom(ws, hub, m);
          else if (m.type === "rtc" && me && typeof m.to === "string") {
            const msg = JSON.stringify({ type: "rtc", from: me, to: m.to, data: m.data });
            for (const peer of sockets.get(m.to) ?? []) peer.send(msg);
          }
        } catch {}
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.appId) return void (ws as any).off?.();
        if (ws.data.collab != null) {
          (ws as any).off?.();
          return void ws.data.upstream?.close();
        }
        hub.peopleOnline = Math.max(0, hub.peopleOnline - 1);
        (ws as any).off?.();
        if (speaker(hub, ws) && ws.data.deviceId) {
          sockets.get(ws.data.deviceId)?.delete(ws);
          if (!sockets.get(ws.data.deviceId)?.size) {
            sockets.delete(ws.data.deviceId);
            s.touchDevice(ws.data.deviceId, { micOn: false, level: 0 });
            for (const sh of s.shares()) if (sh.deviceId === ws.data.deviceId && sh.status === "live") s.endShare(sh.id, "ended", { lost: true });
          }
        }
      },
    },
  });
  if (server.port) {
    hub.devproxy.reserve(server.port);
    // The big screen is a host window, on 127.0.0.1 at this port: the only page a build's frame takes input from.
    hub.devproxy.hostPage(`http://127.0.0.1:${server.port}`);
  }
  return server;
}

/** The most input events a person may send a second, across all their windows. */
const DRIVE_PER_SECOND = 120;
const driveRate = new Map<string, { since: number; n: number }>();
const clamp01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const delta = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(5000, Math.max(-5000, v)) : 0);

/** The sane form of one driver's input event, or null (junk). */
export function cleanDrive(ev: any): DriveEvent | null {
  if (!ev || typeof ev !== "object") return null;
  if (ev.k === "leave") return { k: "leave" };
  if (ev.k === "key") {
    if (typeof ev.key !== "string" || !ev.key || ev.key.length > 32) return null;
    const mods = ev.mods && typeof ev.mods === "object" ? { shift: !!ev.mods.shift, ctrl: !!ev.mods.ctrl, alt: !!ev.mods.alt, meta: !!ev.mods.meta } : undefined;
    return { k: "key", key: ev.key, ...(typeof ev.code === "string" ? { code: ev.code.slice(0, 32) } : {}), down: ev.down !== false, ...(mods ? { mods } : {}) };
  }
  const [x, y] = [clamp01(ev.x), clamp01(ev.y)];
  if (x === null || y === null) return null;
  if (ev.k === "move") return { k: "move", x, y };
  if (ev.k === "down" || ev.k === "up") return { k: ev.k, x, y, b: Math.min(4, Math.max(0, Math.trunc(Number(ev.b) || 0))), n: Math.min(3, Math.max(1, Math.trunc(Number(ev.n) || 1))) };
  if (ev.k === "wheel") return { k: "wheel", x, y, dx: delta(ev.dx), dy: delta(ev.dy), ...(ev.ctrl ? { ctrl: true } : {}) };
  return null;
}

/**
 * A driver's input from their window's WebSocket (6.1). The person is whoever this window is paired as (or the host's own window),
 * never what the message says; agents have no window here. Anyone not driving this screen is dropped, with a note once a second.
 */
export function driveFrom(ws: ServerWebSocket<WsData>, hub: Hub, m: any) {
  const s = hub.session;
  const now = Date.now();
  const dev = hub.auth.get(ws.data.pairedId);
  const personId = dev ? (dev.kind === "browser" ? dev.personId : null) : ws.data.hostWindow ? s.store.setting<string>("hostPersonId", "") || null : null;
  const screen = s.findScreen(typeof m.screen === "string" ? m.screen : undefined)?.id ?? "main";
  const person = personId ? s.person(personId) : undefined;
  const deny = (why: string) => {
    if (now - (ws.data.driveDenied ?? 0) < 1000) return;
    ws.data.driveDenied = now;
    ws.send(JSON.stringify({ type: "drive-denied", screen, why }));
  };
  if (!person) return deny("Pick who you are in this window first.");
  const rate = driveRate.get(person.id);
  if (!rate || now - rate.since >= 1000) driveRate.set(person.id, { since: now, n: 1 });
  else if (++rate.n > DRIVE_PER_SECOND) return;
  if (!s.driversOf(screen).includes(person.id)) return deny("You aren't driving this screen.");
  const ev = cleanDrive(m.ev);
  if (ev) bus.send({ type: "drive", screen, personId: person.id, name: person.name, color: person.color, ev, t: now });
}

/** Relays a canvas WebSocket to the canvas server, which only listens on this machine. */
function openCollab(ws: ServerWebSocket<WsData>, hub: Hub) {
  const port = (ws.data as any).devPort ?? hub.canvas.port;
  const up = new WebSocket(`ws://127.0.0.1:${port}${ws.data.collab}`);
  up.binaryType = "arraybuffer";
  ws.data.upstream = up;
  up.onopen = () => {
    for (const m of ws.data.queue ?? []) up.send(m as any);
    ws.data.queue = [];
  };
  up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
  up.onclose = () => ws.close();
  up.onerror = () => ws.close();
}

/** The dev server port for a dev-<port>.<domain> request, when <domain> is this host's. */
function devTarget(req: Request, hub: Hub): number | null {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const m = host.match(/^dev-(\d{2,5})\.(.+)$/);
  const domain = hub.net.status().domain?.toLowerCase();
  if (!m || !domain || m[2] !== domain.replace(/^https?:\/\//, "")) return null;
  const port = Number(m[1]);
  return hub.session.devservers().some((d) => d.hostPort === port) ? port : null;
}

async function proxyHttp(req: Request, url: URL, port: number): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.set("host", `127.0.0.1:${port}`);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, redirect: "manual" });
    return new Response(r.body, { status: r.status, headers: r.headers });
  } catch {
    return new Response("That dev server isn't answering.", { status: 502 });
  }
}

/** The web app: hashed assets cached forever, every other path gets index.html. */
export function webApp(path: string): Response {
  if (!config.webDist) return new Response("The JamSesh web app isn't built. Run: cd jamsesh && bun run build:web", { status: 503 });
  const rel = path.replace(/^\//, "");
  const candidate = join(config.webDist, rel);
  if (rel && existsSync(candidate) && statSync(candidate).isFile()) return file(candidate, config.webDist, true);
  return file(join(config.webDist, "index.html"), config.webDist);
}

function wantsHtml(req: Request) {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** POST /api/pair {code, kind, label}: browsers get an HttpOnly cookie, agents get the token. */
async function pairRoute(hub: Hub, req: Request, url: URL, ip: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as any;
  const kind = body.kind === "agent" ? "agent" : "browser";
  const r = hub.auth.pair({ code: String(body.code ?? ""), kind, label: String(body.label ?? ""), ip });
  if (!r.ok) return bad(r.error, 403);
  const res = json({ ok: true, deviceId: r.device.id, token: kind === "agent" ? r.token : undefined, hub: originOf(req, url) });
  if (kind === "browser") {
    const secure = originOf(req, url).startsWith("https") ? "; Secure" : "";
    // On the public address the cookie also covers dev-<port>.<domain>, so dev servers open signed in.
    const domain = hub.net.status().domain;
    const scope = domain && url.hostname.toLowerCase() === domain.toLowerCase() ? `; Domain=${domain}` : "";
    res.headers.append("set-cookie", `jam_token=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}${scope}`);
  }
  return res;
}

/**
 * GET /agent?c=CODE: setup instructions written for a coding agent. A valid code pairs
 * the agent on the spot and the instructions carry its token, so the code's short life
 * doesn't matter once the agent has read the page.
 */
function agentRoute(hub: Hub, req: Request, url: URL, ip: string): Response {
  const origin = originOf(req, url);
  const code = url.searchParams.get("c") ?? url.searchParams.get("code");
  const md = (t: string, status = 200) => new Response(t, { status, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
  if (!code) return md(agentIntro(origin));
  const r = hub.auth.pair({ code, kind: "agent", label: url.searchParams.get("name") ?? "Agent", ip });
  if (!r.ok) return md(`# Couldn't pair\n\n${r.error}\n\nAsk your person for the code on the JamSesh big screen (under the QR code) right now, then fetch ${origin}/agent?c=<code> again.`, 403);
  return md(agentGuide(origin, r.token));
}

async function api(hub: Hub, req: Request, url: URL, ip: string, paired: PairedDevice | null, hostWindow = false): Promise<Response> {
  const s = hub.session;
  const path = url.pathname.slice("/api".length);
  // A file upload is read with a byte cap before it is parsed, so a body that gives no length can't run past it.
  const upload = path === "/attachments" && req.method === "POST";
  // A font lend carries up to a family's worth of base64: read at most that much, never Bun's 128 MB default.
  const cap = path.startsWith("/fonts/") ? FONT_BODY_MAX : Infinity;
  if (!upload && Number(req.headers.get("content-length") ?? 0) > cap) return bad("That request is too large.", 413);
  const body = upload ? (paired?.kind === "agent" ? null : await readCapped(req, MAX_UPLOAD_BYTES)) : req.method === "POST" || req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE" ? await readBody(req, cap) : null;
  if (body === TOO_LARGE) return bad("That request is too large.", 413);

  /** Who is calling, for what only one window may do: its pairing, or "host" for the host's own windows. */
  const caller = hostWindow ? "host" : paired?.kind === "browser" ? paired.id : null;
  /** Refuses what's for people's windows (a paired one, or the host's own) to anyone else: agents, and other processes on the host. */
  const notAPerson = () => (caller ? null : bad(paired?.kind === "agent" ? "That's for people; agents use their jam_ tools." : isLocal(ip) ? NOT_THE_HOST_WINDOW : "That's for people.", 403));

  if (path === "/state") return json(forCaller(s.state(), paired?.kind === "agent"));
  if (path === "/clock") return json({ now: Date.now() });

  // The older part of a list the state leaves out (people and agents alike may read it): /history/events?before=<id>&limit=50&kinds=speech,prompt
  let hm = path.match(/^\/history\/(events|utterances|directives|artifacts)$/);
  if (hm && req.method === "GET") {
    const q = url.searchParams;
    const kinds = (q.get("kinds") ?? "").split(",").filter(Boolean) as EventKind[];
    const r = s.history(hm[1], { before: q.get("before") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined, kinds });
    return r ? json(r) : bad("unknown list", 404);
  }

  // Things only people do: speak, record, pin, approve, steer the screen, share, invite. An agent's
  // credential is refused on all of them (agents talk to the room through MCP), and a person's
  // window always acts as its own person, whatever the request says.
  if (req.method !== "GET" && HUMAN_ONLY.test(path)) {
    if (paired?.kind === "agent") return bad("That's for people; agents use their jam_ tools.", 403);
    // On the host, only its own windows act as a person: not another process that reaches loopback.
    if (isLocal(ip) && !hostWindow) return bad(NOT_THE_HOST_WINDOW, 403);
    // Except where personId names someone else: the speaker a line is corrected to, the person asked to share.
    // A window that hasn't said who it is yet is nobody in particular, not whoever the request names.
    if (paired && body && typeof body === "object" && "personId" in body && !TARGETS_A_PERSON.test(path)) body.personId = paired.personId;
  }

  // Fonts for the canvases (SPEC 12.4). The bytes go to people's canvases only: an agent's credential gets
  // names and counts in the state, never a font file (agents run on Macs, and a borrowed font stays off them).
  let fm = path.match(/^\/fonts\/([^/]{1,300})\/(\d{1,2})$/);
  if (fm && req.method === "GET") {
    if (!caller) return paired?.kind === "agent" ? bad("Fonts are for people's canvases; agents don't get the files.", 403) : notAPerson()!;
    const key = (() => { try { return decodeURIComponent(fm[1]); } catch { return ""; } })();
    const data = hub.fonts.face(key, Number(fm[2]));
    // A copy, and never cached to disk: a borrowed font is not kept on anyone's Mac.
    return data ? new Response(data.slice(), { headers: { "content-type": "font/ttf", "cache-control": "no-store" } }) : bad("No such font.", 404);
  }
  if (path.startsWith("/fonts/") && req.method === "POST") {
    const personId = String(paired?.personId || (hostWindow ? s.store.setting<string>("hostPersonId", "") : "") || "");
    const person = personId ? s.person(personId) : undefined;
    if (path === "/fonts/want") {
      await hub.fonts.want(person?.id ?? null, body?.families);
      return json(s.fonts());
    }
    if (!person) return bad("Choose who you are first, so JamSesh knows whose font this is.", 403);
    if (path === "/fonts/decline") return hub.fonts.decline(person.id, body?.family) ? json({ ok: true }) : json({ ok: true, nothing: true });
    if (path === "/fonts/withdraw") return hub.fonts.withdraw(person.id, body?.family) ? json({ ok: true }) : bad("You aren't sharing that font.", 404);
    if (path === "/fonts/lend") {
      const r = hub.fonts.lend(person.id, body?.family, body?.files);
      return r.ok ? json(r) : bad(r.error, r.status);
    }
  }

  if (path === "/me") {
    const personId = paired ? paired.personId : isLocal(ip) ? s.store.setting<string>("hostPersonId", "") : null;
    return json({ onHost: isLocal(ip), device: paired && { id: paired.id, kind: paired.kind, label: paired.label }, person: personId ? s.person(personId) ?? null : null });
  }

  if (path === "/devices" && req.method === "POST") {
    if (!body?.deviceId) return bad("deviceId is required");
    const cur = s.store.get("devices", String(body.deviceId));
    // The first window to register a device owns it until that pairing is gone. Only it, or the host's
    // own window, changes whose it is: another window can't take it over or speak and share as it.
    const owner = cur?.pairedId && (cur.pairedId === "host" || hub.auth.live(cur.pairedId)) ? cur.pairedId : (caller ?? undefined);
    if (owner && owner !== caller && !hostWindow) return bad("That device belongs to another window.", 403);
    if (paired?.kind === "browser") {
      // So this is the browser's own device. The browser becomes the person it first says it is; after that a
      // request can't make it someone else (only a person who was removed frees it to pick again), and its
      // devices are that person's. Owner-only answers rest on this.
      if (body.personId && s.person(String(body.personId)) && !(paired.personId && s.person(paired.personId))) hub.auth.update(paired.id, { personId: String(body.personId) });
      if (body.personId !== undefined) body.personId = hub.auth.get(paired.id)?.personId ?? null;
    }
    // The person using the host's own window: agents on the host Mac work for them.
    if (hostWindow && owner === "host" && body.kind !== "host" && body.personId) {
      s.store.setSetting("hostPersonId", String(body.personId));
      hub.auth.setOwnerPerson("host", String(body.personId));
    }
    const location = body.location === "remote" || body.location === "room" ? body.location : cur?.location ?? (sameLan(ip) ? "room" : "remote");
    const registered = s.touchDevice(String(body.deviceId), { label: body.label, personId: body.personId, kind: isLocal(ip) && body.kind === "host" ? "host" : "client", micOn: body.micOn, location, pairedId: owner });
    // A socket another window opened for this id before it was registered stops speaking for it.
    dropForeignSockets(registered.id, registered.pairedId);
    return json(registered);
  }

  if (path === "/audio" && req.method === "POST") {
    const q = url.searchParams;
    const deviceId = q.get("deviceId");
    if (!deviceId) return bad("deviceId is required");
    // Only the window that owns a device sends its audio: a device's owner names the speaker and teaches
    // their voiceprint, so another window's microphone can't be spoken through.
    const dev = s.store.get("devices", deviceId);
    if (!dev) return bad("Register this device first (POST /api/devices).", 404);
    if (!caller || dev.pairedId !== caller) return bad("That device belongs to another window.", 403);
    // A timed-out upload is retried; the same segment from the same device only counts once.
    const segKey = `${deviceId}:${q.get("t0")}`;
    if (recentSegments.has(segKey) || segmentsInFlight.has(segKey)) return json({ ok: true, duplicate: true, lag: Math.round(hub.audio.deviceLag(deviceId)) });
    // Only a segment that was ingested counts as received: a failed or cut-off upload is retried.
    segmentsInFlight.add(segKey);
    try {
      const bytes: Uint8Array = body?.__raw ?? new Uint8Array(await req.arrayBuffer());
      const seg = await hub.audio.ingest({
        deviceId,
        t0: Number(q.get("t0")),
        t1: Number(q.get("t1")),
        wav: bytes,
        levelDb: q.has("level") ? Number(q.get("level")) : undefined,
        noiseDb: q.has("noise") ? Number(q.get("noise")) : undefined,
      });
      remember(recentSegments, segKey, 4000);
      return json({ ok: true, segment: seg.id, lag: Math.round(hub.audio.deviceLag(deviceId)) });
    } finally {
      segmentsInFlight.delete(segKey);
    }
  }

  if (path === "/people" && req.method === "POST") {
    if (!body?.name?.trim()) return bad("name is required");
    return json(s.upsertPerson({ id: body.id, name: body.name, role: body.role, weight: body.weight != null ? Number(body.weight) : undefined }));
  }
  let m = path.match(/^\/people\/([\w-]+)$/);
  if (m && req.method === "DELETE") return (s.removePerson(m[1]), hub.fonts.dropLender(m[1]), json({ ok: true }));
  if (m && req.method === "PATCH") {
    const p = s.person(m[1]);
    if (!p) return bad("no such person", 404);
    return json(s.upsertPerson({ id: p.id, name: body?.name ?? p.name, role: body?.role, weight: body?.weight != null ? Number(body.weight) : undefined }));
  }
  // A voice belongs to its person: only their own window or device reads, reads aloud, brings or forgets it.
  const own = (id: string) => {
    if (paired?.kind === "agent") return "That's for people; agents use their jam_ tools.";
    if (isLocal(ip) && !hostWindow) return NOT_THE_HOST_WINDOW;
    const me = paired ? paired.personId : isLocal(ip) ? s.store.setting<string>("hostPersonId", "") : null;
    return me && me === id ? null : "A voice is only for its own person to give.";
  };
  m = path.match(/^\/people\/([\w-]+)\/voiceprint$/);
  if (m) {
    const refused = own(m[1]);
    if (refused) return bad(refused, 403);
    if (!s.person(m[1])) return bad("no such person", 404);
    if (req.method === "GET") return json(hub.voiceprintOf(m[1]));
    if (req.method === "PUT") {
      const r = hub.carryVoiceprint(m[1], body);
      return r.ok ? json(r) : "reset" in r ? json({ error: r.reason, reset: true }, 409) : bad(r.reason);
    }
    if (req.method === "DELETE") return json(hub.resetVoice(m[1]));
  }
  if (path === "/voice/script" && req.method === "GET") return paired?.kind === "agent" ? bad("That's for people; agents use their jam_ tools.", 403) : json({ sentences: ENROL_SCRIPT, seconds: ENROL_SECONDS });
  m = path.match(/^\/people\/([\w-]+)\/voice\/start$/);
  if (m && req.method === "POST") {
    const refused = own(m[1]);
    if (refused) return bad(refused, 403);
    return (hub.audio.beginEnrolment(m[1]), json({ ok: true }));
  }
  // The read stopped without reaching the host (the microphone failed, the upload failed): `read` says
  // whether anything was said aloud, which earns the grace for copies still on their way.
  m = path.match(/^\/people\/([\w-]+)\/voice\/end$/);
  if (m && req.method === "POST") {
    const refused = own(m[1]);
    if (refused) return bad(refused, 403);
    if (body?.read) hub.audio.endEnrolment(m[1]);
    else hub.audio.cancelEnrolment(m[1]);
    return json({ ok: true });
  }

  m = path.match(/^\/utterances\/([\w-]+)\/assign$/);
  if (m && req.method === "POST") {
    let personId = body?.personId;
    if (!personId && body?.name) personId = s.upsertPerson({ name: body.name, role: body.role }).id;
    if (!personId) return bad("personId or name is required");
    const { utterance, learning } = hub.audio.assign(m[1], personId);
    const person = s.person(personId)!;
    s.store.put("people", person);
    hub.confirmLearning(person.name, learning);
    return json({ ...utterance, learning: { ...learning, message: learningNote(person.name, learning) } });
  }

  if (path === "/voice-preview" && req.method === "POST") {
    // A fixed sentence in the chosen voice, so the picker can be tried without a real reply. Each one costs a speech call:
    // one per device every few seconds is plenty for clicking through voices.
    const voice = typeof body?.voice === "string" ? body.voice.trim() : undefined;
    if (voice && voice.length > VOICE_NAME_MAX) return bad("That voice name is too long.");
    const who = paired?.id ?? ip;
    if (Date.now() - (lastVoicePreview.get(who) ?? 0) < VOICE_PREVIEW_COOLDOWN_MS) return bad("One sample at a time; try again in a moment.", 429);
    lastVoicePreview.set(who, Date.now());
    if (lastVoicePreview.size > 200) for (const [k, at] of lastVoicePreview) if (Date.now() - at > VOICE_PREVIEW_COOLDOWN_MS) lastVoicePreview.delete(k);
    try {
      return json(await synthesize(s, "Hi, I'm the room brain. This is how I sound.", voice));
    } catch (e) {
      return bad(`Couldn't make a sample: ${describeError(e)}`, 502);
    }
  }

  // What a person puts on a screen is theirs until they unlock it (3.1). A paired window is the person its credential is
  // bound to, whatever the body says. The host's own windows are the room's (the big screen is shared), so they may name
  // who is acting, else the person at the host. `by` is only a fallback name for a window that hasn't picked who it is.
  const actor = () => {
    const id = String((paired ? paired.personId : body?.personId || s.store.setting<string>("hostPersonId", "")) ?? "");
    const p = id ? s.person(id) : undefined;
    return { id: p?.id ?? null, name: p?.name ?? String(body?.by ?? "Someone in the room") };
  };
  if (path === "/say" && req.method === "POST") {
    // Only people speak as people: agents post through MCP, and a window speaks as its own person.
    if (paired?.kind === "agent") return bad("Agents post with jam_update and jam_message, not as a person.", 403);
    if (paired?.personId && body?.personId && body.personId !== paired.personId) return bad("This device speaks as its own person.", 403);
    let attached: AttachmentRef[] = [];
    try {
      attached = hub.attachments.refs(body?.attachments);
    } catch (e) {
      if (e instanceof AttachmentError) return bad(e.message, e.status);
      throw e;
    }
    if (!body?.text?.trim() && !attached.length) return bad("text is required");
    // Spoken as the credential's person; a window with none speaks as nobody in particular.
    return json(hub.typed(actor().id, String(body.text ?? ""), !!body.direct, attached));
  }

  // An image, screenshot or file for a message: one per request, as form field 'file'. People add them; people and agents of the session fetch them.
  if (path === "/attachments" && req.method === "POST") {
    if (paired?.kind === "agent") return bad("Agents share files with jam_post_image, not message attachments.", 403);
    if (body?.__tooBig) return bad("That file is too big.", 413);
    const f = (body?.__form as FormData | undefined)?.get("file");
    if (!(f instanceof Blob)) return bad("send the file as form field 'file'");
    const who = s.person(paired?.personId ?? (isLocal(ip) ? s.store.setting<string>("hostPersonId", "") : ""))?.name ?? "Someone";
    try {
      const rec = hub.attachments.save(new Uint8Array(await f.arrayBuffer()), (f as File).name, who);
      return json(hub.attachments.ref(rec.id));
    } catch (e) {
      if (e instanceof AttachmentError) return bad(e.message, e.status);
      throw e;
    }
  }
  m = path.match(/^\/attachments\/([\w-]+)$/);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const f = hub.attachments.file(m[1]);
    if (!f) return bad("No such file.", 404);
    const inline = f.rec.kind === "image" || f.rec.kind === "text";
    // The type is the sniffed one, never sniffed again by the browser, and the file can't run anything.
    return new Response(req.method === "HEAD" ? null : Bun.file(f.path), {
      headers: {
        "content-type": f.rec.kind === "text" ? "text/plain; charset=utf-8" : f.rec.type,
        "content-length": String(f.rec.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.rec.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  if (path === "/settings" && req.method === "POST") {
    if (!isLocal(ip) && HOST_ONLY_SETTINGS.some((k) => body?.[k] !== undefined)) return bad("Change the gateway key, models, host control, the faster engine and the brain's on/off switch on the host itself.", 403);
    s.updateSettings(body ?? {});
    hub.brain.refreshStatus();
    if (body?.fastEngine !== undefined || body?.transcription !== undefined) void hub.transcriber.syncFastEngine();
    return json(s.settings());
  }

  // With several screens, the caller says which (an id or a name); none, or one that isn't there, is the main one.
  const screenOf = () => s.findScreen(typeof body?.screen === "string" ? body.screen : undefined)?.id ?? "main";

  if (path === "/stage" && req.method === "POST") {
    const stage = body as Partial<Stage> & { mode: Stage["mode"] };
    if (!stage?.mode) return bad("mode is required");
    const who = actor();
    const screen = screenOf();
    return json(s.setStage({ ...stage, pinned: stage.pinned ?? stage.mode !== "board" }, who.name, screen, { person: who }));
  }
  // Driving the big screen (6.1): the lock's owner starts, passes control or drives together; `to` names the other person.
  // The big screen's key for the builds it frames (devdrive.ts): the host's own windows only.
  if (path === "/drive/frame-key" && req.method === "GET") return hostWindow ? json({ key: hub.devproxy.frameKey }) : bad(isLocal(ip) ? NOT_THE_HOST_WINDOW : "Only the host's big screen drives builds.", 403);
  if (path === "/drive/online" && req.method === "GET") return notAPerson() ?? json({ people: s.onlinePeople() });
  m = path.match(/^\/drive\/(start|stop|pass|together)$/);
  if (m && req.method === "POST") {
    const r = s.drive(m[1] as "start", screenOf(), actor().id, typeof body?.to === "string" ? body.to : typeof body?.who === "string" ? body.who : null);
    return r.ok ? json({ drivers: r.drivers }) : bad(r.error, r.status);
  }
  if (path === "/stage/unlock" && req.method === "POST") {
    s.unlockStage(screenOf());
    return json(s.stage(screenOf()));
  }
  if (path === "/stage/restore" && req.method === "POST") {
    const who = actor();
    const screen = screenOf();
    const lock = s.lockOf(screen);
    if (lock && lock.personId !== who.id) return bad(`${lock.by} has this screen locked. Unlock it first to bring something else back.`, 409);
    const stage = s.restoreHistory(String(body?.id ?? ""), screen, who);
    return stage ? json(stage) : bad("That screen is no longer in the history.", 404);
  }
  m = path.match(/^\/stage\/ready\/([\w-]+)$/);
  if (m && req.method === "POST") {
    if (body?.action === "dismiss") return (s.dismissReady(m[1]), json({ ok: true }));
    const stage = s.showReady(m[1], actor());
    return stage ? json(stage) : bad("That item isn't waiting any more.", 404);
  }
  m = path.match(/^\/show-requests\/([\w-]+)$/);
  if (m && req.method === "POST") {
    const asked = s.showRequests().find((r) => r.id === m![1]);
    const who = actor();
    // The lock's owner answers; so does the host's own window, where the room is looking at the question.
    if (asked && !hostWindow && (!who.id || asked.ownerId !== who.id)) return bad(`Only ${asked.ownerName} can answer that.`, 403);
    const done = s.answerShowRequest(m[1], !!body?.approve, who.name);
    if (done?.status === "expired") return bad("The screen changed since that question, so it no longer applies. The item is still waiting.", 409);
    return done ? json(done) : bad("That question has already been answered.", 404);
  }

  // Expand one tile to fill the presentation area, or collapse (`tile` null). `screen` picks an extra big screen.
  if (path === "/stage/expand" && req.method === "POST") {
    // Agents steer the screen with jam_show; expanding is for people looking at it.
    if (paired?.kind === "agent") return bad("Agents use jam_show; expanding a tile is for people.", 403);
    if (body?.tile !== null && (typeof body?.tile !== "string" || !body.tile.trim())) return bad("tile must be a tile key, or null to collapse");
    const tile: string | null = body.tile === null ? null : body.tile.trim();
    const screen = typeof body?.screen === "string" && body.screen ? body.screen : "main";
    if (screen !== "main" && !s.screens().some((sc) => sc.id === screen)) return bad("no such screen", 404);
    if (tile !== null && !s.stageTileKeys(screen).some((t) => t.key === tile)) return bad("That isn't on the screen right now.", 404);
    return json(s.expandTile(tile, screen));
  }

  // Take an agent out of the room (one that joined by mistake, say); `purge` also deletes what it put in the feed.
  const rm = path.match(/^\/agents\/([\w-]+)\/remove$/);
  if (rm && req.method === "POST") {
    const r = s.removeAgent(rm[1], { purge: !!body?.purge });
    return r.removed ? json(r) : bad("no such agent", 404);
  }
  // Chats the room removed (kept out of jam_join), and letting one back in: people only.
  if (path === "/removed-chats" && req.method === "GET") return paired?.kind === "agent" ? bad("That's for people.", 403) : json(s.removedChats().map(({ id, name, ownerName, at }) => ({ id, name, ownerName, at })));
  const rc = path.match(/^\/removed-chats\/([\w-]+)\/allow$/);
  if (rc && req.method === "POST") return s.allowRejoin({ id: rc[1] }) ? json({ ok: true }) : bad("No removed chat with that id.", 404);

  if (path === "/directives" && req.method === "POST") {
    const targets = (body?.targets ?? []).filter((t: string) => s.agent(t));
    if (!body?.text?.trim() || !targets.length) return bad("text and at least one agent id in targets are required");
    // Observers only watch: product work for observers alone would reach nobody.
    const mode = body.mode ?? "explore";
    if (mode !== "answer" && mode !== "note" && targets.every((t: string) => s.agent(t)?.role === "observer")) return bad("Those agents only watch (observers), so nobody would do this. Pick a working agent.");
    const p = s.person(body.personId);
    return json(s.createDirective({ text: body.text.trim(), mode, targets, requestedBy: p?.name ?? "Someone in the room", rationale: body.rationale ?? "Sent directly from the room." }));
  }

  m = path.match(/^\/directives\/([\w-]+)$/);
  if (m && req.method === "POST") {
    if (body?.status !== "done" && body?.status !== "cancelled") return bad("status is done or cancelled");
    return json(s.endDirective(m[1], body.status));
  }
  m = path.match(/^\/directives\/([\w-]+)\/reassign$/);
  if (m && req.method === "POST") {
    let moved;
    try {
      moved = s.reassignDirective(m[1], s.person(body?.personId)?.name ?? "Someone in the room", typeof body?.to === "string" && body.to ? body.to : undefined, typeof body?.agentId === "string" ? body.agentId : undefined);
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
    return moved ? json(moved) : bad("Nobody else is free to take it, or it's already done");
  }


  // The project wiki (12.8). People read, search and edit; agents use the jam_wiki_* tools and can't edit pages.
  if (path === "/wiki" || path.startsWith("/wiki/")) {
    if (paired?.kind === "agent") return bad("That's for people; agents use the jam_wiki_ tools.", 403);
    // Who writes is who is signed in: a paired person's own device, or the host's window as its person. Never a
    // personId in the body, which any caller could fill in (HUMAN_ONLY above already refused other loopback callers).
    const p = paired ? (paired.personId ? s.person(paired.personId) : undefined) : hostWindow ? s.person(s.store.setting<string>("hostPersonId", "")) : undefined;
    // Every change to the wiki names a person, the host's own window included.
    if (req.method !== "GET" && !p) return bad("Pick who you are in this window first.", 403);
    const who = { id: p?.id ?? null, name: p?.name ?? "Someone" };
    const r = await wikiRoute(hub.wiki, req.method, path, url, body, who);
    if (r) return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  }

  // The Tasks board (4.1): proposals wait here until a person acts. Only people act on them: an agent's credential is refused
  // (HUMAN_ONLY), and a window must know who is using it so the record says who sent or dismissed what.
  if (path === "/triage" && req.method === "GET") {
    // Agents don't see proposals nobody has accepted; they read the knowledge, the inbox and the changelog.
    if (paired?.kind === "agent") return bad("That's for people; agents use their jam_ tools.", 403);
    return json({ cards: s.board.shown(), stats: s.board.stats() });
  }
  if (path === "/changelog" && req.method === "GET") return json(s.changelog(Math.min(200, Number(url.searchParams.get("limit")) || 50)).map(publicEvent));
  m = path.match(/^\/triage\/([\w-]+)(?:\/(send|add|merge|replace|dismiss))?$/);
  if (m && req.method !== "GET") {
    const who = actor();
    // A wiki card writes pages under the name of whoever accepts it, so it needs a person even in the host's window.
    if (!who.id && (!hostWindow || s.board.get(m[1])?.type === "wiki")) return bad("Pick who you are in this window first.", 403);
    const edit = { text: body?.text, mode: body?.mode, targets: body?.targets, workstream: body?.workstream, kind: body?.kind, pages: body?.pages };
    const verb = m[2];
    const r = !verb
      ? req.method === "PATCH"
        ? s.board.edit(m[1], edit, who.name)
        : { ok: false as const, error: "Use PATCH to edit a card.", status: 405 }
      : verb === "send"
        ? s.board.send(m[1], who.name, edit)
        : verb === "add"
          ? s.board.add(m[1], who.name, edit)
          : verb === "merge"
            ? typeof body?.factId === "string" ? s.board.merge(m[1], body.factId, who.name, typeof body?.text === "string" ? body.text : undefined) : { ok: false as const, error: "factId is required: the fact to merge into.", status: 400 }
            : verb === "replace"
              ? s.board.replace(m[1], who.name, typeof body?.factId === "string" ? body.factId : undefined, edit)
              : s.board.dismiss(m[1], who.name);
    return r.ok ? json(r) : bad(r.error, r.status);
  }

  if (path === "/upload" && req.method === "POST") {
    const form = body?.__form as FormData | undefined;
    const f = form?.get("file");
    if (!(f instanceof Blob)) return bad("send the image as form field 'file'");
    const agent = s.agent(String(form!.get("agent") ?? "")) ?? null;
    const art = await hub.saveUpload(agent, new Uint8Array(await f.arrayBuffer()), {
      title: String(form!.get("title") ?? "Screenshot"),
      stage: form!.get("stage") === "mockup" ? "mockup" : "built",
      note: String(form!.get("note") ?? ""),
      platform: (form!.get("platform") as any) ?? undefined,
      replaces: String(form!.get("replaces") ?? "") || undefined,
    });
    return json({ id: art.id, url: `${s.hubUrl}${art.image}` });
  }

  // Claude Code's hooks. They speak for an agent, so only an agent's credential sends them, or the
  // host's own loopback, which is the host's agents (the app's relay hands any process there that
  // credential anyway; relayed requests never count as loopback). A hook only reaches a chat that
  // joined from the same machine as its credential, so no other device can read or drain its inbox
  // or post prompts as its person.
  const hook = path.match(/^\/hooks\/(prompt|joined|stop|tool|listen)$/)?.[1];
  if (hook && req.method === "POST") {
    if (paired && paired.kind !== "agent") return bad("Hooks are for agents' credentials.", 403);
    const machine = paired ? hub.auth.machineOf(paired.id) : isLocal(ip) ? "host" : null;
    if (!machine) return bad("This device isn't paired with this JamSesh host.", 401);
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    // With this room's id: a hook keeps it with the chat, so a prompt queued while the host is away
    // is only ever sent to this room.
    if (hook === "joined") return json({ joined: hub.chatJoined(b, machine), room: s.roomId() });
    // Sent for one room (a queued prompt, or a call made just before this Mac's relay switched hosts):
    // refused before anything is recorded, read or acknowledged, so the hook keeps it for that room.
    const room = req.headers.get("x-jam-room");
    if (room && room !== s.roomId()) return json({ error: "That was meant for another JamSesh room.", room: s.roomId() }, 409);
    // What the hook script passed on to the agent since its last call (see Hub.offer).
    const promptId = req.headers.get("x-jam-prompt-id") ?? "";
    if (/^[\w-]{1,80}$/.test(promptId)) b.jamPromptId = promptId;
    b.jamAcks = (req.headers.get("x-jam-ack") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 50);
    // A chat that isn't (or is no longer) in the room: the script stops sending for it.
    const joined = !!hub.hookAgent(b, ip, machine);
    const headers: Record<string, string> = { "cache-control": "no-store", "x-jam-joined": joined ? "1" : "0" };
    if (hook === "listen") {
      // Held open until the room has something for the idle agent (or it gives up); plain text so the hook script can print it.
      const r = joined ? await hub.listen(b, ip, machine, undefined, () => !paired || !!hub.auth.get(paired.id)) : { text: "", delivery: null };
      if (r.delivery) headers["x-jam-delivery"] = r.delivery;
      return new Response(r.text, { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    }
    const out: any = !joined ? {} : hook === "prompt" ? hub.onPrompt(b, ip, machine) : hook === "tool" ? hub.onTool(b, ip, machine) : hub.onStop(b, ip, machine);
    const { jamDelivery, ...rest } = out;
    if (jamDelivery) headers["x-jam-delivery"] = jamDelivery;
    return Response.json(rest, { headers });
  }

  if (path === "/workers" && req.method === "POST") {
    if (!body?.url || !body?.id) return bad("id and url are required");
    // A worker is the caller's own machine: its audio goes there, so it can't name another host or replace the local engine.
    if (String(body.id) === "local") return bad("That id is reserved.");
    const self = ip.replace(/^::ffff:/, "");
    const workerUrl = String(body.url).replace(/\/\/(localhost|127\.0\.0\.1)/, `//${isLocal(ip) ? "127.0.0.1" : self}`);
    let workerHost = "";
    try {
      workerHost = new URL(workerUrl).hostname.replace(/^\[|\]$/g, "");
    } catch {}
    if (ip === "relayed" || !workerHost || workerHost !== (isLocal(ip) ? "127.0.0.1" : self)) return bad("A worker has to run on the machine that offers it.", 403);
    hub.transcriber.addWorker(String(body.id), String(body.label ?? "worker"), workerUrl);
    return json({ ok: true, engines: hub.transcriber.engineList() });
  }
  if (path === "/engines") return json({ transcription: hub.transcriber.engineList(), whisperModel: hub.transcriber.whisper.status(), speechModel: hub.transcriber.parakeet.status(), vocabulary: hub.transcriber.vocabulary().map((v) => v.term), voiceprints: s.voiceprints(), problem: hub.transcriber.problem() });

  if (path === "/canvas-link") {
    const kind = url.searchParams.get("kind") === "view" ? "view" : "edit";
    // Through the hub's relay at the address this person used (LAN, remote, HTTPS), so the
    // canvas server itself never has to be reachable from outside this machine.
    const ws = kind === "view" ? s.canvas.wsView : s.canvas.wsEdit;
    const q = ws?.match(/\?(file=[^&]+&token=[^&]+)/)?.[1];
    const origin = originOf(req, url);
    const relay = q ? `${origin.replace(/^http/, "ws")}/collab/?${q}` : null;
    const link = isLocal(ip) ? hub.canvas.localWs(kind) : relay;
    const desktop = q ? `figcraft://join?server=${encodeURIComponent(`${origin.replace(/^http/, "ws")}/collab/`)}&${q}` : null;
    return json({ link, status: s.canvas.status, reason: s.canvas.reason, desktop });
  }

  // ---- shares (screens and cameras) ----
  // Every share call acts for the window that made it: a share starts from that window's own
  // device and ends or is declined only by it (or, for a request, by the person asked). The host's
  // own window is the one separate authority: it can end or decline any share in its room.
  if (path === "/shares" && req.method === "POST") {
    if (!body?.deviceId) return bad("deviceId is required");
    if (!caller || s.store.get("devices", String(body.deviceId))?.pairedId !== caller) return bad("Share from your own window.", 403);
    // A share someone ended stays ended: its window re-registering it (after missing the end) is told so and stops.
    const was = typeof body.shareId === "string" ? s.store.get("shares", body.shareId) : undefined;
    if (was && was.deviceId === String(body.deviceId) && (was.status === "ended" || was.status === "declined") && !was.lost) return bad("That share was ended.", 409);
    const share = s.startShare(String(body.deviceId), body.kind === "camera" ? "camera" : "screen", typeof body.shareId === "string" ? body.shareId : undefined, body.label);
    s.placeShare(share);
    return json(share);
  }
  if (path === "/shares/request" && req.method === "POST") {
    const p = s.person(body?.personId) ?? s.personByName(String(body?.name ?? ""));
    if (!p) return bad("Who should share? Give personId or name.");
    const share = s.requestShare(p.id, body?.kind === "camera" ? "camera" : "screen", String(body?.reason ?? ""), body?.by ?? "Someone in the room");
    return share ? json(share) : bad(`${p.name} has no JamSesh window open.`, 409);
  }
  m = path.match(/^\/shares\/([\w-]+)(\/decline)?$/);
  if (m && (req.method === "DELETE" || (req.method === "POST" && m[2]))) {
    const sh = s.store.get("shares", m[1]);
    if (!sh) return json({ ok: true }); // already gone: a repeated call
    const decline = !!m[2] && sh.status === "requested";
    const own = !!caller && s.store.get("devices", sh.deviceId)?.pairedId === caller;
    const asked = decline && !!paired?.personId && sh.personId === paired.personId;
    if (!hostWindow && !own && !asked) return bad(decline ? "That request was for someone else." : "That isn't your share.", 403);
    if (sh.status === "live" || sh.status === "requested") s.endShare(sh.id, decline ? "declined" : "ended", { note: !own && sh.status === "live" ? `The host stopped your ${sh.kind} share.` : "" });
    return json({ ok: true });
  }

  // ---- annotations ----
  if (path === "/annotations" && req.method === "POST") {
    if (!body?.target?.kind || typeof body.x !== "number") return bad("target and x, y are required");
    const ann = s.addAnnotation({ personId: body.personId ?? null, authorName: body.authorName, target: body.target, x: body.x, y: body.y, text: String(body.text ?? ""), source: body.source === "pointer" ? "pointer" : "pin" });
    if (ann.target.kind === "canvas" && ann.target.canvasX != null) hub.canvas.comment(ann).catch(() => {});
    return json(ann);
  }
  if (path === "/annotations/send" && req.method === "POST") {
    const ev = hub.sendAnnotations(body?.personId ?? null, body?.ids, String(body?.text ?? ""));
    return ev ? json(ev) : bad("No open annotations to send.");
  }
  m = path.match(/^\/annotations\/([\w-]+)$/);
  if (m && req.method === "PATCH") {
    const fields: Record<string, unknown> = {};
    if (typeof body?.text === "string") fields.text = body.text;
    if (["open", "sent", "done"].includes(body?.status)) fields.status = body.status;
    return json(s.store.patch("annotations", m[1], fields));
  }
  if (m && req.method === "DELETE") return (s.store.remove("annotations", m[1]), json({ ok: true }));

  // ---- voice enrollment: a person reads a sentence so JamSesh knows their voice ----
  m = path.match(/^\/people\/([\w-]+)\/voice$/);
  if (m && req.method === "POST") {
    const refused = own(m[1]);
    if (refused) return bad(refused, 403);
    const bytes: Uint8Array = body?.__raw ?? new Uint8Array();
    return json(hub.enrollVoice(m[1], bytes));
  }

  // ---- profile photos ----
  m = path.match(/^\/people\/([\w-]+)\/photo$/);
  if (m && req.method === "POST") {
    const bytes: Uint8Array = body?.__raw ?? (body?.__form?.get("file") instanceof Blob ? new Uint8Array(await (body.__form.get("file") as Blob).arrayBuffer()) : new Uint8Array());
    return json(await hub.savePhoto(m[1], bytes));
  }

  // ---- prompts addressed to the brain ----
  if (path === "/prompt-window/start" && req.method === "POST") {
    if (!body?.deviceId) return bad("deviceId is required");
    hub.promptStart(String(body.deviceId), Number(body.t0) || Date.now());
    return json({ ok: true });
  }
  if (path === "/prompt-window" && req.method === "POST") {
    if (!body?.deviceId || !body?.t0 || !body?.t1) return bad("deviceId, t0 and t1 are required");
    return json(await hub.promptWindow({ deviceId: body.deviceId, personId: body.personId ?? null, t0: Number(body.t0), t1: Number(body.t1), pointer: body.pointer ?? [], typed: body.text }));
  }

  // ---- Record: talk and point, review the notes, send them to the agents that own the work ----
  // A recording is on the caller's own window's device, and its notes go out only from that window.
  if (path.startsWith("/record/") && req.method === "POST") {
    if (!caller) return notAPerson()!;
    const ownDevice = (id: unknown) => typeof id === "string" && s.store.get("devices", id)?.pairedId === caller;
    if (path === "/record/start") {
      if (!body?.deviceId) return bad("deviceId is required");
      if (!ownDevice(body.deviceId)) return bad("Record from your own window.", 403);
      const r = hub.recordStart(String(body.deviceId), actor().id, Number(body.t0) || Date.now(), typeof body.screen === "string" ? body.screen : null);
      return r.ok ? json(r) : bad(r.reason, r.status);
    }
    if (path === "/record/stop") {
      if (!body?.deviceId || !body?.t0 || !body?.t1) return bad("deviceId, t0 and t1 are required");
      if (!ownDevice(body.deviceId)) return bad("Stop recording from the window that started it.", 403);
      const r = await hub.recordStop({ deviceId: String(body.deviceId), caller, personId: actor().id, t0: Number(body.t0), t1: Number(body.t1), pointer: body.pointer ?? [], typed: typeof body.text === "string" ? body.text : undefined });
      return r.ok ? json(r) : r.status ? bad(r.reason, r.status) : json(r);
    }
    if (path === "/record/send") {
      if (!body?.recordingId || !Array.isArray(body?.notes)) return bad("recordingId and notes are required");
      const r = await hub.recordSend({ caller, personId: actor().id, recordingId: String(body.recordingId), notes: body.notes });
      return r.ok ? json(r) : r.status ? bad(r.reason, r.status) : json(r);
    }
  }

  // ---- snapshots ----
  if (path === "/snapshots" && req.method === "GET") return json({ snapshots: hub.autosave.list().map(({ dir: _d, ...x }) => x), layouts: Object.keys(s.savedLayouts()) });
  if (path === "/snapshots" && req.method === "POST") {
    const snap = await hub.autosave.save(String(body?.label ?? "saved by hand"));
    return snap ? json({ id: snap.id, canvas: snap.canvas }) : bad("Nothing to save.");
  }
  m = path.match(/^\/snapshots\/([\w.-]+)\/(canvas\.figcraft|notes\.md|context\.json)$/);
  if (m && req.method === "GET") {
    const f = join(hub.autosave.dir, m[1], m[2]);
    if (!existsSync(f)) return bad("not found", 404);
    return new Response(Bun.file(f), { headers: { "content-disposition": `attachment; filename="${m[1]}-${m[2]}"` } });
  }
  if (path === "/layouts" && req.method === "POST") {
    if (!body?.name?.trim()) return bad("name is required");
    return json(Object.keys(s.saveLayout(String(body.name))));
  }

  // Whether a public page refuses to be shown in a frame (X-Frame-Options, CSP frame-ancestors).
  // Browsers can't tell from inside the page, so the host reads the headers. Public sites only.
  if (path === "/frame-check" && req.method === "GET") {
    if (paired?.kind === "agent") return bad("not for agents", 403);
    const target = (() => {
      try {
        return new URL(url.searchParams.get("url") ?? "");
      } catch {
        return null;
      }
    })();
    const privateHost = (h: string) => /^(localhost|.*\.local|.*\.lan|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?|\[?f[cd])/i.test(h);
    if (!target || !/^https?:$/.test(target.protocol) || privateHost(target.hostname)) return json({ blocked: false, checked: false });
    try {
      const res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(5000), headers: { "user-agent": "Mozilla/5.0 JamSesh frame check" } });
      res.body?.cancel().catch(() => {});
      const xfo = (res.headers.get("x-frame-options") ?? "").toLowerCase();
      const ancestors = (res.headers.get("content-security-policy") ?? "").match(/frame-ancestors([^;]*)/i)?.[1]?.trim().toLowerCase();
      const blocked = /deny|sameorigin/.test(xfo) || (ancestors !== undefined && !/(^|\s)\*(\s|$)/.test(ancestors));
      return json({ blocked, checked: true });
    } catch {
      return json({ blocked: false, checked: false });
    }
  }

  // A person opens a page in a browser on the host, for sites that refuse to show inside a tile.
  if (path === "/host/open-url" && req.method === "POST") {
    if (!isLocal(ip) && paired?.kind !== "browser") return bad("Only people in the session can open pages on the host.", 403);
    if (!s.settings().hostControl) return bad("Host control is turned off in Settings.", 409);
    return json({ result: await hub.host.act({ action: "open_url", url: String(body?.url ?? "") }) });
  }

  // An invite link for someone who isn't in the room: good once, for ten minutes.
  if (path === "/invite" && req.method === "POST") {
    if (!isLocal(ip) && paired?.kind !== "browser") return bad("Only people in the session can invite.", 403);
    const { code, expiresAt } = hub.auth.invite();
    const addr = s.addresses().find((a) => a.url.startsWith("https")) ?? s.addresses()[0];
    return json({ url: `${addr?.url ?? originOf(req, url)}/connect?c=${code}`, code, expiresAt });
  }

  // ---- connected devices (Settings): everyone can see them; only the host disconnects ----
  if (path === "/paired" && req.method === "GET") return json(hub.auth.list());
  m = path.match(/^\/paired\/([\w-]+)$/);
  if (m && req.method === "DELETE") {
    if (!hostWindow) return bad(isLocal(ip) ? NOT_THE_HOST_WINDOW : "Only the host can disconnect devices.", 403);
    return hub.auth.revoke(m[1]) ? json({ ok: true }) : bad("No such device.", 404);
  }

  // Live apps (6.3): a person starts a tile for a running Simulator or Mac app, takes or passes control, and drives it.
  // Starting one builds nothing (builds still wait for approval); it only shows what's already running on the host.
  m = path.match(/^\/apps(?:\/([\w-]+)(?:\/(control|input))?)?$/);
  if (m && req.method !== "GET") {
    const personId = paired?.personId ?? (hostWindow ? s.store.setting<string>("hostPersonId", "") || null : null);
    const person = personId ? s.person(personId) : undefined;
    if (!person) return bad("Pick who you are in this window first.", 403);
    const who = { personId: person.id, name: person.name, host: hostWindow };
    if (!m[1] && req.method === "POST") {
      if (!hostWindow) return bad("Only the host can put an app on a tile.", 403);
      if (!s.settings().hostControl) return bad("Host control is turned off in Settings.", 409);
      const r = body?.kind === "mac" ? await hub.live.startMac({ name: String(body?.name ?? ""), bundle: typeof body?.bundle === "string" ? body.bundle : undefined }, person.name) : await hub.live.startIos(body?.device ? String(body.device) : undefined, person.name);
      return typeof r === "string" ? bad(r, 409) : json({ app: r });
    }
    if (m[1] && !m[2] && req.method === "DELETE") return hostWindow || hub.live.drives(m[1], who.personId) ? (hub.live.stop(m[1]) ? json({ ok: true }) : bad("No such app.", 404)) : bad("Only the host or whoever is driving can stop it.", 403);
    if (m[1] && m[2] === "control" && req.method === "POST") {
      const toPerson = body?.to ? s.person(String(body.to)) : undefined;
      if (body?.action === "pass" && !toPerson) return bad("Say who to pass control to.", 400);
      const act = body?.action === "release" || body?.action === "pass" ? body.action : "take";
      return json({ result: hub.live.control(m[1], act, who, toPerson ? { personId: toPerson.id, name: toPerson.name } : undefined) });
    }
    if (m[1] && m[2] === "input" && req.method === "POST") {
      // The big screen's window replays a driver's cursor on the tile: it acts as that driver, and only if they drive the tile's screen.
      const { as, ...input } = (body ?? {}) as Record<string, unknown>;
      const asDriver = hostWindow && typeof as === "string" && hub.live.screenDriverIds(m[1])?.includes(as) ? s.person(as) : undefined;
      const why = await hub.live.input(m[1], asDriver ? { personId: asDriver.id, name: asDriver.name, host: false } : who, input as any);
      return why ? json({ ok: false, error: why }, 409) : json({ ok: true });
    }
    return bad("not found", 404);
  }

  // A person approves or denies an agent's host build. Agents can't: their tokens are refused here.
  m = path.match(/^\/build-requests\/([\w-]+)$/);
  if (m && req.method === "POST") {
    // A person's window: the host's own (window key), or a paired window that belongs to a person.
    if (!hostWindow && (paired?.kind !== "browser" || !paired.personId)) return bad("Only people in the session can approve host builds. Pick who you are in this window first.", 403);
    const personId = (paired?.personId ?? body?.personId) as string | undefined;
    const by = (personId && s.person(personId)?.name) || (hostWindow ? "the host" : "someone in the room");
    return json({ result: hub.host.decide(m[1], body?.approve === true, by) });
  }

  // The big screen reports its size so the brain can plan layouts for its shape.
  // A big-screen window reports or retires its display: only the host's own windows (not another process on the host).
  if (path === "/display" && (req.method === "POST" || req.method === "DELETE") && !hostWindow) return bad("Only the host's own screens report themselves.", 403);
  if (path === "/display" && req.method === "POST") {
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
    const info = { width: n(body?.width), height: n(body?.height), dpr: n(body?.dpr) || 1, screenX: n(body?.screenX), screenY: n(body?.screenY), at: Date.now() };
    const screen = /^[\w-]{1,32}$/.test(String(body?.screen ?? "")) ? String(body.screen) : "main";
    if (screen === "main") hub.host.bigScreen = info;
    s.reportScreen(screen, info);
    return json({ ok: true });
  }
  // The host app names the room's screens ("Left TV") after setting them up.
  if (path === "/screens/config" && req.method === "POST") {
    if (!hostWindow) return bad("Only the host app names the screens.", 403);
    s.configureScreens(Array.isArray(body?.screens) ? body.screens : []);
    return json({ screens: s.screens().map(({ id, name, role }) => ({ id, name, role })) });
  }
  // A big-screen window closed: it stops being a place to put things until a window for it reports again.
  if (path === "/display" && req.method === "DELETE") {
    const screen = String(body?.screen ?? "");
    if (/^[\w-]{1,32}$/.test(screen)) s.removeScreen(screen);
    return json({ ok: true });
  }

  if (path === "/brain/digest" && req.method === "POST") return (await hub.brain.digest(true), json({ digest: s.store.digest("session")?.text ?? "" }));

  return bad("not found", 404);
}

// ---- replayed calls ----
// Laptops queue changes while they're offline and resend them with the same `x-jam-idem` key,
// including calls whose response was lost on the way back. A repeated key gets the first
// answer again instead of running twice; one that arrives mid-flight waits for the first.
const IDEM_TTL_MS = 24 * 60 * 60_000;
const idemSeen = new Map<string, { at: number; done: Promise<{ status: number; body: string; type: string }> }>();
const recentSegments = new Set<string>();
const segmentsInFlight = new Set<string>();

function remember(set: Set<string>, key: string, max: number) {
  set.add(key);
  if (set.size > max) set.delete(set.values().next().value!);
}

async function idempotent(hub: Hub, req: Request, path: string, run: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get("x-jam-idem");
  if (!key || req.method === "GET" || path === "/api/audio" || key.length > 100) return run();
  const now = Date.now();
  for (const [k, v] of idemSeen) {
    if (now - v.at < IDEM_TTL_MS && idemSeen.size <= 2000) break;
    idemSeen.delete(k);
  }
  // Answered before a restart: replay it from the database.
  const saved = idemSeen.has(key) ? null : hub.session.store.reply(key);
  if (saved) return new Response(saved.body, { status: saved.status, headers: { "content-type": saved.type, "x-jam-idem-replay": "1" } });
  const seen = idemSeen.get(key);
  if (seen) {
    const r = await seen.done;
    return new Response(r.body, { status: r.status, headers: { "content-type": r.type, "x-jam-idem-replay": "1" } });
  }
  let settle!: (r: { status: number; body: string; type: string }) => void;
  idemSeen.set(key, { at: now, done: new Promise((res) => (settle = res)) });
  try {
    const res = await run();
    const body = await res.clone().text();
    // Server errors aren't remembered, so the retry can succeed.
    const reply = { status: res.status, body, type: res.headers.get("content-type") ?? "application/json" };
    if (res.status >= 500) idemSeen.delete(key);
    else hub.session.store.saveReply(key, reply);
    settle(reply);
    return res;
  } catch (e) {
    idemSeen.delete(key);
    settle({ status: 500, body: JSON.stringify({ error: String(e) }), type: "application/json" });
    throw e;
  }
}

/** The origin the client used to reach this host (proxies forward the original host). */
/** Requests that reached the hub from this computer: only a relay or tunnel here can say where it was asked. */
const viaLoopback = new WeakSet<Request>();
/** A host name or address with an optional port, nothing else (it ends up in scripts and links). */
const HOST_SHAPE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})(:\d{1,5})?$/;

/**
 * The address the caller reached the hub at. X-Forwarded-* count only from a relay or tunnel on this
 * computer (anyone else could send them), and a value that isn't plainly a host and port is ignored.
 */
export function originOf(req: Request, url: URL) {
  const relay = viaLoopback.has(req);
  const host = [relay ? req.headers.get("x-forwarded-host") : null, req.headers.get("host"), url.host].find((h): h is string => !!h && HOST_SHAPE.test(h)) ?? "127.0.0.1";
  const fwd = relay ? req.headers.get("x-forwarded-proto") : null;
  const proto = fwd === "http" || fwd === "https" ? fwd : url.protocol === "https:" ? "https" : "http";
  return `${proto}://${host}`;
}

/** A multipart body read to at most `max` bytes, then parsed: `{ __tooBig: true }` past that, whatever the headers said. */
export async function readCapped(req: Request, max: number): Promise<{ __form: FormData } | { __tooBig: true } | null> {
  // Even a declared length past the cap is read up to the cap and then cut off: a reply to a body nobody reads
  // can leave the sender hanging.
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data") || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { __tooBig: true };
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  try {
    return { __form: await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData() };
  } catch {
    return null;
  }
}

/** The most a /api/fonts request may carry: a family's files (32 MB) as base64, plus the envelope. */
export const FONT_BODY_MAX = 45 * 1024 * 1024;
const TOO_LARGE = Symbol("too large");

/** The text of a request body, read in chunks and abandoned past `max` bytes (null: over). */
async function readTextCapped(req: Request, max: number): Promise<string | null> {
  if (max === Infinity) return req.text();
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) return (await reader.cancel().catch(() => {}), null);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req: Request, max = Infinity): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const text = await readTextCapped(req, max);
    if (text === null) return TOO_LARGE;
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (type.includes("multipart/form-data")) return { __form: await req.formData() };
  if (type.includes("audio/") || type.includes("image/") || type.includes("octet-stream")) return { __raw: new Uint8Array(await req.arrayBuffer()) };
  return null;
}

function file(p: string, root: string, cache = false): Response {
  const full = normalize(p);
  if (!full.startsWith(normalize(root)) || !existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = {};
  if (cache && /\.(js|css|wasm|png|jpg|woff2?)$/.test(full) && /[-.][0-9a-f]{8,}\./.test(full)) headers["cache-control"] = "public, max-age=31536000, immutable";
  else headers["cache-control"] = "no-cache";
  if (full.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
  return new Response(Bun.file(full), { headers });
}

export const FULL_SIZES = [1600, 2400, 3200, 4096];
const FULL_KEEP = 60;
const fullInflight = new Map<string, Promise<string | null>>();

/** One frame, drawn at exactly one of FULL_SIZES and kept beside the stored render (the newest FULL_KEEP files stay). */
export async function fullRender(hub: Hub, artifactId: string, size: number): Promise<Response> {
  if (!FULL_SIZES.includes(size)) return new Response(`size must be one of ${FULL_SIZES.join(", ")}`, { status: 400 });
  const art = hub.session.store.get("artifacts", artifactId);
  const base = art?.image?.match(/^\/renders\/([\w-]+)\.png$/)?.[1];
  if (!art || art.kind !== "frame" || !art.nodeId || !base) return new Response("not found", { status: 404 });
  const dir = join(hub.canvas.rendersDir, "full");
  const name = `${base}@${size}.png`;
  let job = fullInflight.get(name);
  if (!job) {
    job = (async () => {
      if (existsSync(join(dir, name))) return name;
      // The canvas draws at 1x unless asked: `maxSize` only caps, so the scale that fills `size` is asked for.
      const long = Math.max(art.width ?? 0, art.height ?? 0);
      const r = await hub.canvas.renderNode(art.nodeId!, size, long > 0 ? Math.min(8, size / long) : 4).catch(() => null);
      const img = r?.isError ? undefined : (r?.content.find((c) => c.type === "image") as { data: string } | undefined);
      if (!img) return null;
      mkdirSync(dir, { recursive: true });
      await Bun.write(join(dir, name), Buffer.from(img.data, "base64"));
      for (const f of readdirSync(dir).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((x, y) => y.t - x.t).slice(FULL_KEEP)) rmSync(join(dir, f.n), { force: true });
      return name;
    })().finally(() => fullInflight.delete(name));
    fullInflight.set(name, job);
  }
  const done = await job;
  return done ? file(join(dir, done), dir) : new Response("not found", { status: 404 });
}

const NOT_THE_HOST_WINDOW = "On the host, do this from the JamSesh window. A host started from a terminal printed a one-time host link: open that (restart the host for a new one).";

/** GET /host-window?once=…&next=/path: a one-time host link (see HostWindows in auth.ts). */
export async function hostWindowRoute(windows: HostWindows, req: Request, url: URL): Promise<Response> {
  const next = url.searchParams.get("next") ?? "/host";
  const target = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/host";
  const name = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  // The key lives on 127.0.0.1 only: send localhost (shared with dev tiles) and others there first.
  if (name !== "127.0.0.1") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${url.port || config.port}${url.pathname}${url.search}`, "cache-control": "no-store" } });
  const key = await windows.takeSoon(url.searchParams.get("once"));
  const headers = new Headers({ location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (key) headers.append("set-cookie", `jam_window=${key}; Path=/; HttpOnly; SameSite=Strict`);
  return new Response(null, { status: 302, headers });
}

export function cookie(req: Request, name: string) {
  return req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] ?? null;
}

