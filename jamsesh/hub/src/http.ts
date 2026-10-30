// HTTP, WebSocket and MCP on one port.
import type { Server, ServerWebSocket } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize } from "node:path";
import type { HostWindows, PairedDevice } from "./auth";
import { forward } from "./devproxy";
import { DEV_CODE_PARAM, DevLinks, cleanRedirect, scrubHeaders, withoutCredentials } from "./devlinks";
import { BODY_LIMITS, buffered, limitFor, readBytes } from "./body";
import { methodAllowed } from "./methods";
import { AttachmentError, MAX_UPLOAD_BYTES, type AttachmentRef } from "./attachments";
import { bus } from "./bus";
import { voiceprintStatus, learningNote } from "./audio/voiceprint";
import { describeError } from "./brain/llm";
import { synthesize } from "./brain/speech";
import { config, sameLan } from "./config";
import type { Hub } from "./hub";
import { agentGuide, agentIntro, joinScript, hookScript } from "./install-scripts";
import { publicEvent } from "./session";
import { projectsRoute } from "./projects-api";
import { launcherMarkdown, skillMarkdown } from "./skill";
import type { BusMessage, EventKind, Stage } from "./types";

type WsData = { deviceId: string | null; collab?: string; upstream?: WebSocket; queue?: (string | Buffer)[] };

/** Open sockets by device, for relaying WebRTC signaling between devices. */
const sockets = new Map<string, Set<ServerWebSocket<WsData>>>();

// Nothing to return means the thing was deleted (a queued edit to something gone): 410, not a crash.
export const json = (v: unknown, status = 200) => (v === undefined ? Response.json({ error: "That was deleted." }, { status: 410 }) : Response.json(v, { status, headers: { "cache-control": "no-store" } }));

/** API paths (after /api) that stand for a person: never callable with an agent's credential. */
const VOICE_NAME_MAX = 64;
export const VOICE_PREVIEW_COOLDOWN_MS = 3_000;
const lastVoicePreview = new Map<string, number>();

export const HUMAN_ONLY = /^\/(say|audio|devices|prompt-window(\/start)?|annotations(\/send|\/[\w-]+)?|people(\/[\w-]+(\/(voice|voiceprint|photo))?)?|settings|directives(\/[\w-]+(\/reassign)?)?|triage\/[\w-]+(\/(send|add|merge|replace|dismiss))?|workers|agents\/[\w-]+\/remove|removed-chats\/[\w-]+\/allow|voice-preview|build-requests\/[\w-]+|utterances\/[\w-]+\/assign|stage(\/(unlock|restore|expand|ready\/[\w-]+))?|screens\/config|display|show-requests\/[\w-]+|shares(\/.*)?|invite|attachments|host\/open-url|layouts|snapshots|devserver\/link)$/;
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
const HOST_ONLY_SETTINGS = ["gatewayKey", "models", "hostControl", "brainEnabled"] as const;

/** Per request, what releases its count at once: a request that is only waiting for the room (a hook's listen) isn't work in flight. */
const waiting = new WeakMap<Request, () => void>();
/** Per response: the body-memory charge it still holds, released when its stream has ended. */
const budgetHeld = new WeakMap<Response, () => void>();
/** Per request: the wait it carries, told when its reply has been sent or the client has gone. */
const liveCalls = new WeakMap<Request, import("./mcp").LiveCall>();
const markWaiting = (req: Request) => waiting.get(req)?.();

const RELAY_HEADERS = ["x-forwarded-host", "x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"];

/** Host names this hub answers to: loopback, any IP address, this Mac's own .local names, and its own domains. */
export function knownHost(req: Request, hub: Hub) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return true;
  if (ownLocalNames().has(host)) return true;
  const domain = hub.net.status().domain?.toLowerCase();
  if (domain && (host === domain || host.endsWith(`.${domain}`))) return true;
  const extra = [process.env.JAMSESH_PUBLIC_URL, process.env.JAMSESH_PUBLIC_HOST].map((u) => (u ? u.replace(/^https?:\/\//, "").replace(/[:/].*$/, "").toLowerCase() : ""));
  return extra.includes(host);
}

/** This Mac's own Bonjour names (name.local), and no other `.local` name: a page can't reach the host under one it picked. */
let localNames: Set<string> | null = null;
function ownLocalNames(): Set<string> {
  if (localNames) return localNames;
  const names = new Set<string>();
  const add = (n: string) => {
    const base = n.trim().toLowerCase().replace(/\.local\.?$/, "");
    if (base) (names.add(`${base}.local`), names.add(base));
  };
  add(hostname());
  try {
    const r = Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) add(r.stdout.toString());
  } catch {}
  for (const n of (process.env.JAMSESH_HOSTNAMES ?? "").split(",")) add(n);
  return (localNames = names);
}

/** A browser's WebSocket carries its page's Origin; it must be this host (or the Mac app relaying it). */
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

  // A device token comes in a header or the cookie, never the URL (a one-time dev-server sign-in link is the only URL token: anyToken).
  const tokenOf = (req: Request, _url: URL) =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? cookie(req, "jam_token");

  // The dev app may send its own Authorization header, so the paired token can be in the cookie instead; or the dev origin's own
  // sign-in cookie (devlinks.ts). Never the address.
  const anyToken = (hub: Hub, req: Request, _url: URL, ip: string) => {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    for (const t of [bearer, cookie(req, "jam_token")]) {
      const d = t ? hub.auth.check(t, ip) : null;
      if (d) return d;
    }
    return hub.auth.get(hub.auth.devLinks.deviceOf(cookie(req, DevLinks.cookieName)));
  };

  /** The credential on a loopback request: the Authorization header or the jam_token cookie, never the address. */
  const fileReader = (req: Request) => {
    for (const t of [req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""), cookie(req, "jam_token")]) {
      const d = t ? hub.auth.check(t, "127.0.0.1") : null;
      if (d) return d;
    }
    return null;
  };

  const PUBLIC_FILES = /^\/(assets\/|icons\/|fonts\/|favicon\.svg$|manifest\.webmanifest$|sw\.js$)/;

  const route = async (incoming: Request, srv: Server<WsData>): Promise<Response | undefined> => {
      const peer = srv.requestIP(incoming)?.address ?? "0.0.0.0";
      const incomingUrl = new URL(incoming.url);
      // Loopback is the host's own windows only when nothing relayed it: a tunnel, a proxy, or the
      // Mac app's relay (which carries agents' traffic) all mark their requests.
      const relayed = RELAY_HEADERS.some((h) => incoming.headers.has(h));
      const ip = relayed && isLocal(peer) ? "relayed" : peer;
      const local = isLocal(ip);
      // On the host, loopback alone isn't a person (every process here reaches it): the host's own
      // windows also carry the hub's window key (SPEC 14, HostWindows in auth.ts).
      const hostWindow = local && hub.auth.windows.matches(cookie(incoming, "jam_window"));
      const refused = await methodAllowed(incoming);
      if (refused) return refused;
      // A route that takes a recording or a file is for someone paired (or the host's window): nobody else gets a big buffer.
      if (limitFor(incoming) > BODY_LIMITS.json && incomingUrl.pathname !== "/mcp" && !hostWindow && !(local ? fileReader(incoming) : hub.auth.check(tokenOf(incoming, incomingUrl), ip))) return local ? bad(NOT_THE_HOST_WINDOW, 403) : bad("This device isn't paired with this JamSesh host.", 401);
      // MCP from another machine needs its credential before anything is buffered (on this Mac it is the documented tokenless setup).
      if (incomingUrl.pathname === "/mcp" && !local && !hub.auth.check(tokenOf(incoming, incomingUrl), ip)) return bad("This device isn't paired with this JamSesh host.", 401);
      // Every body is read here, bounded, before any route (or the closing check below) looks at the request; its memory stays
      // charged until the request has been answered.
      const got = await buffered(incoming);
      if (!("req" in got)) return bad(got.message, got.status);
      const req = got.req;
      const release = got.release;
      let holdsBudget = false;
      const url = new URL(req.url);
      const path = url.pathname;
      // DNS rebinding: a web page can't reach the host under a name of its own choosing.
      if (!knownHost(req, hub)) return (release(), bad("Unknown host name.", 421));
      try {
      // Once the final save has begun nothing is written: every route that changes something is turned away here, after its body was read.
      if (hub.closing && req.method !== "GET") return (release(), bad("The session is saving and closing.", 503));
      // Accepted for dispatch: from here the request is work in flight, until its response has been sent.
      const admission = hub.admit(`${req.method} ${path}`);
      waiting.set(incoming, admission);
      waiting.set(req, admission);
      try {
        // ---- open to anyone: health, pairing, the app shell, the canvas relay ----
        if (path.endsWith("/healthz")) return new Response("ok");
        // Dev servers on their own subdomain of the host's address: dev-5100.<name>.duckdns.org.
        const dev = devTarget(req, hub);
        if (dev) {
          // A one-time sign-in link: the code becomes this origin's own cookie and the address loses it.
          const stale = cleanRedirect(url);
          if (stale) return stale;
          const code = url.searchParams.get(DEV_CODE_PARAM);
          if (code) {
            const device = hub.auth.devLinks.redeem(code);
            if (!device) return new Response("That link has been used or has expired. Open the dev server again from JamSesh.", { status: 401, headers: { "cache-control": "no-store" } });
            return new Response(null, { status: 302, headers: { location: withoutCredentials(url) || "/", "set-cookie": hub.auth.devLinks.setCookie(hub.auth.devLinks.open(device), url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https"), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
          }
          if (!local && !anyToken(hub, req, url, ip)) return new Response("Pair this device with JamSesh first: open the host's address and enter the code.", { status: 401 });
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const who = local ? null : anyToken(hub, req, url, ip);
            if (srv.upgrade(req, { data: { deviceId: null, collab: withoutCredentials(url), devPort: dev, pairedId: who?.id ?? null } as any })) return undefined as any;
          }
          // The same forwarder as the LAN ports (it also strips what is ours): this hop is to the hub's own listener for that dev server.
          return forward(req, `127.0.0.1:${dev}`, withoutCredentials(url));
        }
        // The host's own windows are trusted without a token, so a page on another site can't post as them.
        // A page on any other origin (a dev preview on this host included) can't post here, whoever's cookie the browser would send.
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return bad("Not from this site.", 403);
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

        // On loopback a request is the host's, except reading an attachment: there a paired agent calling the hub directly
        // is its credential (the route still turns away a local process with neither a credential nor the host's window).
        const readsFile = local && (req.method === "GET" || req.method === "HEAD") && /^\/api\/attachments\/[\w-]+$/.test(path);
        // A credential is the caller's role wherever it comes from: an agent's token over loopback is an agent. It only ever
        // lowers standing; loopback with no credential gets no more than the agents' view of room data (seesAll below).
        const loopbackCredential = local ? fileReader(req) : null;
        const device = local ? (readsFile || loopbackCredential?.kind === "agent" ? loopbackCredential : null) : hub.auth.check(tokenOf(req, url), ip);
        // Who is reading room data: the host's own window (its key), or a paired person's browser. Loopback alone grants nothing:
        // an agent's token, or no credential at all, gets the agents' view (no Tasks board proposals).
        const seesAll = hostWindow || (local ? loopbackCredential : device)?.kind === "browser";
        const ok = local || !!device;
        // A page in a browser (it sends an Origin) reaching loopback without the host window's key or a credential reads no room data.
        if (local && incoming.headers.get("origin") && !hostWindow && !loopbackCredential && (path === "/ws" || path === "/api/state")) return bad("Open JamSesh from its own window.", 403);

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
          return bad("This device isn't paired with this JamSesh host. Open /connect and enter the code on the big screen.", 401);
        }
        if ((path === "/host" || path.startsWith("/setup")) && !local) return Response.redirect("/client", 302);

        if (path === "/mcp") {
          // Counted until its response ends: parsing the body, dispatching the tool and its last write are all inside. Only a call that
          // waits for the room (jam_wait, known from the parsed top-level tool name) and the agent's open stream are idle.
          const kind = await hub.mcp.classify(req);
          if (kind.reject) return bad(kind.reject, 400);
          if (kind.idle) markWaiting(req);
          if (kind.live) {
            liveCalls.set(incoming, kind.live);
            kind.live.idle = () => markWaiting(req);
          }
          const res = await hub.mcp.handle(req, ip, device?.id ?? (local ? "host" : null), originOf(req, url));
          holdsBudget = true;
          budgetHeld.set(res, release);
          return res;
        }
        if (path === "/ws") {
          // A page on another site can't open the live session (and read the room) from a browser.
          if (!sameOrigin(req)) return bad("Not from this site.", 403);
          if (srv.upgrade(req, { data: { deviceId: url.searchParams.get("device"), local, pairedId: (device ?? loopbackCredential)?.id ?? device?.id ?? null, agent: !seesAll } as any })) return undefined as any;
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
          return await idempotent(hub, req, path, () => api(hub, req, url, ip, device, hostWindow, !seesAll));
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
      } finally {
        // An MCP call keeps its payload until its stream ends (the tool runs after the response starts): the charge moves to the response.
        if (!holdsBudget) release();
      }
    };

  const server = Bun.serve<WsData, any>({
    port,
    hostname: "0.0.0.0",
    ...(tls ? { tls } : {}),
    idleTimeout: 255,
    maxRequestBodySize: 64 * 1024 * 1024,
    // Every request is counted from the moment it is admitted until its response has been fully sent, here once, for every route.
    async fetch(incoming, srv) {
      // Counted as work only once accepted for dispatch (see route): a stranger trickling a body is never in the count.
      const release = () => waiting.get(incoming)?.();
      let res: Response | undefined;
      try {
        res = await route(incoming, srv);
      } catch (e) {
        release();
        throw e;
      }
      // An upgrade has no response; a body is released when its last byte has gone (or the client left).
      const budget = res ? budgetHeld.get(res) : undefined;
      const live = liveCalls.get(incoming);
      if (!res || !res.body) {
        release();
        budget?.();
        live?.drop(); // nothing was sent: what it would have carried stays unread
        live?.gone();
        return res;
      }
      const reader = res.body.getReader();
      const out = new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            try {
              const { done, value } = await reader.read();
              if (done) (c.close(), release(), budget?.(), live?.sent(), live?.gone());
              else c.enqueue(value);
            } catch (e) {
              release();
              budget?.();
              live?.drop();
              live?.gone();
              c.error(e);
            }
          },
          cancel(reason) {
            release();
            // The client left, but a tool it started may still hold the payload: the charge goes when the tools have settled.
            if (budget) void hub.mcp.whenQuiet().then(budget);
            live?.drop();
            live?.gone();
            return reader.cancel(reason);
          },
        }),
        res,
      );
      return out;
    },
    websocket: {
      idleTimeout: 120,
      open(ws: ServerWebSocket<WsData>) {
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
        if (ws.data.collab != null) {
          const up = ws.data.upstream;
          if (up?.readyState === WebSocket.OPEN) up.send(raw as any);
          else (ws.data.queue ??= []).push(raw);
          return;
        }
        try {
          const m = JSON.parse(String(raw));
          if (m.type === "level" && ws.data.deviceId) {
            bus.send({ type: "level", deviceId: ws.data.deviceId, level: m.level });
          } else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t, now: Date.now() }));
          else if (m.type === "rtc" && ws.data.deviceId && typeof m.to === "string") {
            const msg = JSON.stringify({ type: "rtc", from: ws.data.deviceId, to: m.to, data: m.data });
            for (const peer of sockets.get(m.to) ?? []) peer.send(msg);
          }
        } catch {}
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.collab != null) {
          (ws as any).off?.();
          return void ws.data.upstream?.close();
        }
        hub.peopleOnline = Math.max(0, hub.peopleOnline - 1);
        (ws as any).off?.();
        if (ws.data.deviceId) {
          sockets.get(ws.data.deviceId)?.delete(ws);
          if (!sockets.get(ws.data.deviceId)?.size) {
            sockets.delete(ws.data.deviceId);
            s.touchDevice(ws.data.deviceId, { micOn: false, level: 0 });
            for (const sh of s.shares()) if (sh.deviceId === ws.data.deviceId && sh.status === "live") s.endShare(sh.id);
          }
        }
      },
    },
  });
  if (server.port) hub.devproxy.reserve(server.port);
  return server;
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
  const raw = await readBytes(req, BODY_LIMITS.json, 15_000);
  if (!raw || raw === "timeout") return bad("That request is too large.", 413);
  let body: any = {};
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) ?? {};
  } catch {}
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
  // Pairing makes a credential and keeps it: not while the final save is under way.
  if (hub.closing) return md("# Closing\n\nThis session is saving and closing. Ask your person for the next one.", 503);
  const r = hub.auth.pair({ code, kind: "agent", label: url.searchParams.get("name") ?? "Agent", ip });
  if (!r.ok) return md(`# Couldn't pair\n\n${r.error}\n\nAsk your person for the code on the JamSesh screen right now, then fetch ${origin}/agent?c=<code> again.`, 403);
  return md(agentGuide(origin, r.token));
}

async function api(hub: Hub, req: Request, url: URL, ip: string, paired: PairedDevice | null, hostWindow = false, redact = paired?.kind === "agent"): Promise<Response> {
  const s = hub.session;
  const path = url.pathname.slice("/api".length);
  // A file upload is read with a byte cap before it is parsed, so a body that gives no length can't run past it.
  const upload = path === "/attachments" && req.method === "POST";
  const body = upload ? (paired?.kind === "agent" ? null : await readCapped(req, MAX_UPLOAD_BYTES)) : req.method === "POST" || req.method === "PATCH" || req.method === "DELETE" ? await readBody(req) : null;
  // A request that was let in before the final save began and stalled while sending its body is turned away here, after the body.
  if (hub.closing && req.method !== "GET") return bad("The session is saving and closing.", 503);

  /** Who is calling, for what only one window may do: its pairing, or "host" for the host's own windows. */
  const caller = hostWindow ? "host" : paired?.kind === "browser" ? paired.id : null;

  if (path === "/state") return json(forCaller(s.state(), redact));
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
    return json(s.touchDevice(String(body.deviceId), { label: body.label, personId: body.personId, kind: isLocal(ip) && body.kind === "host" ? "host" : "client", micOn: body.micOn, location, pairedId: owner }));
  }

  if (path === "/audio" && req.method === "POST") {
    const q = url.searchParams;
    const deviceId = q.get("deviceId");
    if (!deviceId) return bad("deviceId is required");
    // A timed-out upload is retried; the same segment from the same device only counts once.
    const segKey = `${deviceId}:${q.get("t0")}`;
    if (recentSegments.has(segKey) || segmentsInFlight.has(segKey)) return json({ ok: true, duplicate: true, lag: Math.round(hub.audio.deviceLag(deviceId)) });
    // Only a segment that was ingested counts as received: a failed or cut-off upload is retried.
    segmentsInFlight.add(segKey);
    try {
      const got = body?.__raw ?? (await readBytes(req, BODY_LIMITS.media));
      const bytes: Uint8Array | null = got === "timeout" ? null : got;
      if (!bytes) return bad("That recording is too large.", 413);
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
  if (m && req.method === "DELETE") return (s.removePerson(m[1]), json({ ok: true }));
  if (m && req.method === "PATCH") {
    const p = s.person(m[1]);
    if (!p) return bad("no such person", 404);
    return json(s.upsertPerson({ id: p.id, name: body?.name ?? p.name, role: body?.role, weight: body?.weight != null ? Number(body.weight) : undefined }));
  }
  m = path.match(/^\/people\/([\w-]+)\/voiceprint$/);
  if (m && req.method === "DELETE") return (hub.audio.voiceprints.clear(m[1]), s.store.put("people", s.person(m[1])!), json({ ok: true }));

  m = path.match(/^\/utterances\/([\w-]+)\/assign$/);
  if (m && req.method === "POST") {
    let personId = body?.personId;
    if (!personId && body?.name) personId = s.upsertPerson({ name: body.name, role: body.role }).id;
    if (!personId) return bad("personId or name is required");
    const { utterance, learning } = hub.audio.assign(m[1], personId);
    const person = s.person(personId)!;
    s.store.put("people", person);
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
    // A file is read by a paired device, an agent of the session, or the host's own window; another process on the host's loopback is none of them.
    if (!paired && !hostWindow) return bad("This device isn't paired with this JamSesh host.", 401);
    // A credential in the address ends up in histories and logs: this route takes it in a header or cookie only.
    if (url.searchParams.has("token")) return bad("Send the credential in the Authorization header or the jam_token cookie, not in the address.", 400);
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
        // Never kept: a device whose pairing is revoked can't read a copy it fetched earlier.
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/settings" && req.method === "POST") {
    if (!isLocal(ip) && HOST_ONLY_SETTINGS.some((k) => body?.[k] !== undefined)) return bad("Change the gateway key, models, host control and the brain's on/off switch on the host itself.", 403);
    s.updateSettings(body ?? {});
    hub.brain.refreshStatus();
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
    const p = s.person(body.personId);
    return json(s.createDirective({ text: body.text.trim(), mode: body.mode ?? "explore", targets, requestedBy: p?.name ?? "Someone in the room", rationale: body.rationale ?? "Sent directly from the room." }));
  }

  m = path.match(/^\/directives\/([\w-]+)$/);
  if (m && req.method === "POST") return json(s.setDirective(m[1], { status: body?.status }));
  m = path.match(/^\/directives\/([\w-]+)\/reassign$/);
  if (m && req.method === "POST") {
    const moved = s.reassignDirective(m[1], s.person(body?.personId)?.name ?? "Someone in the room", typeof body?.to === "string" ? body.to : undefined, typeof body?.agentId === "string" ? body.agentId : undefined);
    return moved ? json(moved) : bad("Nobody else is free to take it, or it's already done");
  }


  // A link to a dev server for this device: carries a code that works once, for about a minute (devlinks.ts).
  if (path === "/devserver/link" && req.method === "POST") {
    const device = paired?.kind === "browser" ? paired.id : null;
    if (!device && !hostWindow) return bad("Only a paired device asks for a dev-server link.", 403);
    const target = String(body?.url ?? "");
    const known = s.devservers().find((d) => d.url === target || (target.startsWith(d.url) && /^[/?#]/.test(target.slice(d.url.length))));
    if (!known) return bad("That isn't one of this session's dev servers.", 404);
    // The host's own window needs no sign-in on its own Mac: the plain address.
    if (!device) return json({ url: target, expiresInSeconds: null });
    const u = new URL(target);
    u.searchParams.set(DEV_CODE_PARAM, hub.auth.devLinks.mint(device!));
    return json({ url: u.toString(), expiresInSeconds: 60 });
  }

  // The Tasks board (4.1): proposals wait here until a person acts. Only people act on them: an agent's credential is refused
  // (HUMAN_ONLY), and a window must know who is using it so the record says who sent or dismissed what.
  if (path === "/triage" && req.method === "GET") {
    // Agents don't see proposals nobody has accepted; they read the knowledge, the inbox and the changelog.
    if (redact) return bad("That's for people; agents use their jam_ tools.", 403);
    return json({ cards: s.board.shown(), stats: s.board.stats() });
  }
  if (path === "/changelog" && req.method === "GET") return json(s.changelog(Math.min(200, Number(url.searchParams.get("limit")) || 50)).map(publicEvent));
  m = path.match(/^\/triage\/([\w-]+)(?:\/(send|add|merge|replace|dismiss))?$/);
  if (m && req.method !== "GET") {
    const who = actor();
    if (!who.id && !hostWindow) return bad("Pick who you are in this window first.", 403);
    const edit = { text: body?.text, mode: body?.mode, targets: body?.targets, workstream: body?.workstream, kind: body?.kind };
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
    // The agent is the credential's, never just the form's word: an upload for an agent comes from that agent's own machine
    // credential (or the host's own agents on loopback); a named agent that isn't theirs is refused, not replaced by a guess.
    const named = String(form!.get("agent") ?? "");
    const agent = named ? (s.agent(named) ?? null) : null;
    // An agent's credential uploads for one of its own agents: leaving the name out would pass as the host's (and replace its work).
    if (paired?.kind === "agent" && !named) return bad("Name the agent this is for (field 'agent').", 403);
    if (named) {
      const machine = paired ? hub.auth.machineOf(paired.id) : isLocal(ip) ? "host" : null;
      if (!agent || (paired && paired.kind !== "agent") || !machine || agent.machine !== machine) return bad("That agent isn't yours to upload for.", 403);
    }
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
    if (hook === "joined") return json({ joined: hub.chatJoined(b, machine) });
    // What the hook script passed on to the agent since its last call (see Hub.offer).
    const promptId = req.headers.get("x-jam-prompt-id") ?? "";
    if (/^[\w-]{1,80}$/.test(promptId)) b.jamPromptId = promptId;
    b.jamAcks = (req.headers.get("x-jam-ack") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 50);
    // A chat that isn't (or is no longer) in the room: the script stops sending for it.
    const joined = !!hub.hookAgent(b, ip, machine);
    const headers: Record<string, string> = { "cache-control": "no-store", "x-jam-joined": joined ? "1" : "0" };
    if (hook === "listen") {
      // Held open until the room has something for the idle agent: waiting, not work.
      markWaiting(req);
      // Held open until the room has something for the idle agent (or it gives up); plain text so the hook script can print it.
      const r = joined ? await hub.listen(b, ip, machine) : { text: "", delivery: null };
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
  if (path === "/engines") return json({ transcription: hub.transcriber.engineList(), voiceprints: { ...voiceprintStatus(), enrolled: hub.audio.voiceprints.enrolled }, problem: hub.transcriber.problem() });

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
    const share = s.startShare(String(body.deviceId), body.kind === "camera" ? "camera" : "screen", typeof body.shareId === "string" ? body.shareId : undefined, body.label);
    hub.brain.placeShare(share);
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
    if (sh.status === "live" || sh.status === "requested") s.endShare(sh.id, decline ? "declined" : "ended");
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
  // A user-less big-screen window closed: it stops being a place to put things (main always stays).
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
function originOf(req: Request, url: URL) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** A multipart upload (its body already read and bounded by the front door), parsed once; `{ __tooBig }` when its files pass `max`. */
export async function readCapped(req: Request, max: number): Promise<{ __form: FormData } | { __tooBig: true } | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data") || !req.body) return null;
  // The front door set the exact length: past the cap, nothing is parsed.
  if (Number(req.headers.get("content-length")) > max) return { __tooBig: true };
  try {
    const form = await req.formData();
    let size = 0;
    for (const v of form.values()) if (typeof v !== "string") size += (v as Blob).size;
    return size > max ? { __tooBig: true } : { __form: form };
  } catch {
    return null;
  }
}

/** The parsed body of a request the front door already read (bounded): JSON, or the raw bytes or form of a file. */
async function readBody(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return JSON.parse(await req.text());
    } catch {
      return {};
    }
  }
  if (type.includes("multipart/form-data")) return { __form: await req.formData().catch(() => new FormData()) };
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

