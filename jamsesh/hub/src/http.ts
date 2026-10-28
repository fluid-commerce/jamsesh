// HTTP, WebSocket and MCP on one port.
import type { Server, ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { bus } from "./bus";
import { config } from "./config";
import type { Hub } from "./hub";
import { joinScript, hookScript } from "./install-scripts";
import { skillMarkdown } from "./skill";
import type { BusMessage, Stage } from "./types";

type WsData = { deviceId: string | null };

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function isLocal(ip: string) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function startHttp(hub: Hub, port = config.port): Server<WsData> {
  const s = hub.session;

  const authorized = (req: Request, url: URL, ip: string) => {
    if (isLocal(ip)) return true;
    const code = url.searchParams.get("code") ?? req.headers.get("x-jam-code") ?? cookie(req, "jam_code");
    return code?.toUpperCase() === s.code;
  };

  const server = Bun.serve<WsData, any>({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ip = srv.requestIP(req)?.address ?? "0.0.0.0";
      const path = url.pathname;
      try {
        if (path === "/healthz") return new Response("ok");
        if (path === "/join.sh") return new Response(joinScript(hub), { headers: { "content-type": "text/x-shellscript" } });
        if (path === "/" ) return Response.redirect(isLocal(ip) ? "/host" : `/client${url.search}`, 302);

        const ok = authorized(req, url, ip);
        if (!ok && (path.startsWith("/api") || path === "/mcp" || path === "/ws" || path === "/skill.md")) return bad("This needs the session code shown on the host screen.", 401);

        if (path === "/mcp") return hub.mcp.handle(req, ip);
        if (path === "/ws") {
          if (srv.upgrade(req, { data: { deviceId: url.searchParams.get("device") } })) return undefined as any;
          return bad("expected a WebSocket");
        }
        if (path === "/skill.md") return new Response(skillMarkdown(hub), { headers: { "content-type": "text/markdown; charset=utf-8" } });
        if (path === "/hook.sh") return new Response(hookScript(hub), { headers: { "content-type": "text/x-shellscript" } });
        if (path.startsWith("/api/")) return await api(hub, req, url, ip);
        if (path.startsWith("/renders/")) return file(join(hub.canvas.rendersDir, path.slice("/renders/".length)), hub.canvas.rendersDir);
        if (path === "/canvas" || path.startsWith("/canvas/")) {
          if (!config.canvasDist) return new Response("The canvas web build isn't installed. Run jamsesh/install.sh.", { status: 404 });
          const rel = path.replace(/^\/canvas\/?/, "") || "index.html";
          return file(join(config.canvasDist, rel), config.canvasDist, true);
        }
        // The web app (host, client, settings).
        if (!config.webDist) return new Response("The JamSesh web app isn't built. Run: cd jamsesh && bun run build:web", { status: 503 });
        const rel = path.replace(/^\//, "");
        const candidate = join(config.webDist, rel);
        if (rel && existsSync(candidate) && statSync(candidate).isFile()) return file(candidate, config.webDist, true);
        const res = file(join(config.webDist, "index.html"), config.webDist);
        const code = url.searchParams.get("code");
        if (code && code.toUpperCase() === s.code) res.headers.append("set-cookie", `jam_code=${s.code}; Path=/; SameSite=Lax; Max-Age=86400`);
        return res;
      } catch (e) {
        console.error("http:", path, e);
        return bad(e instanceof Error ? e.message : String(e), 500);
      }
    },
    websocket: {
      idleTimeout: 120,
      open(ws: ServerWebSocket<WsData>) {
        ws.send(JSON.stringify({ type: "state", state: s.state() } satisfies BusMessage));
        const off = bus.on((msg) => {
          if (msg.type === "event" && msg.event.data?.embedding) {
            const { embedding: _drop, ...data } = msg.event.data;
            msg = { ...msg, event: { ...msg.event, data } };
          }
          ws.send(JSON.stringify(msg));
        });
        (ws as any).off = off;
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        try {
          const m = JSON.parse(String(raw));
          if (m.type === "level" && ws.data.deviceId) {
            bus.send({ type: "level", deviceId: ws.data.deviceId, level: m.level });
          } else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t, now: Date.now() }));
        } catch {}
      },
      close(ws: ServerWebSocket<WsData>) {
        (ws as any).off?.();
        if (ws.data.deviceId) s.touchDevice(ws.data.deviceId, { micOn: false, level: 0 });
      },
    },
  });
  return server;
}

async function api(hub: Hub, req: Request, url: URL, ip: string): Promise<Response> {
  const s = hub.session;
  const path = url.pathname.slice("/api".length);
  const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : null;

  if (path === "/state") return json(s.state());
  if (path === "/clock") return json({ now: Date.now() });

  if (path === "/devices" && req.method === "POST") {
    if (!body?.deviceId) return bad("deviceId is required");
    return json(s.touchDevice(String(body.deviceId), { label: body.label, personId: body.personId, kind: isLocal(ip) && body.kind === "host" ? "host" : "client", micOn: body.micOn }));
  }

  if (path === "/audio" && req.method === "POST") {
    const q = url.searchParams;
    const deviceId = q.get("deviceId");
    if (!deviceId) return bad("deviceId is required");
    const bytes: Uint8Array = body?.__raw ?? new Uint8Array(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const seg = await hub.audio.ingest({
      deviceId,
      t0: Number(q.get("t0")),
      t1: Number(q.get("t1")),
      wav: bytes,
      levelDb: q.has("level") ? Number(q.get("level")) : undefined,
      noiseDb: q.has("noise") ? Number(q.get("noise")) : undefined,
    });
    return json({ ok: true, segment: seg.id, lag: Math.round(hub.audio.deviceLag(deviceId)) });
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
    const u = hub.audio.assign(m[1], personId);
    s.store.put("people", s.person(personId)!);
    return json(u);
  }

  if (path === "/say" && req.method === "POST") {
    if (!body?.text?.trim()) return bad("text is required");
    return json(hub.typed(body.personId ?? null, body.text));
  }

  if (path === "/settings" && req.method === "POST") {
    s.updateSettings(body ?? {});
    hub.brain.refreshStatus();
    return json(s.settings());
  }

  if (path === "/stage" && req.method === "POST") {
    const stage = body as Partial<Stage> & { mode: Stage["mode"] };
    if (!stage?.mode) return bad("mode is required");
    return json(s.setStage({ ...stage, pinned: stage.pinned ?? stage.mode !== "board" }, body.by ?? "Someone in the room"));
  }

  if (path === "/directives" && req.method === "POST") {
    const targets = (body?.targets ?? []).filter((t: string) => s.agent(t));
    if (!body?.text?.trim() || !targets.length) return bad("text and at least one agent id in targets are required");
    const p = s.person(body.personId);
    return json(s.createDirective({ text: body.text.trim(), mode: body.mode ?? "explore", targets, requestedBy: p?.name ?? "Someone in the room", rationale: body.rationale ?? "Sent directly from the room." }));
  }

  m = path.match(/^\/directives\/([\w-]+)$/);
  if (m && req.method === "POST") return json(s.setDirective(m[1], { status: body?.status }));

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
    });
    return json({ id: art.id, url: `${s.hubUrl}${art.image}` });
  }

  if (path === "/hooks/prompt" && req.method === "POST") return json(hub.onPrompt(body, ip));
  if (path === "/hooks/stop" && req.method === "POST") return json(hub.onStop(body, ip));

  if (path === "/workers" && req.method === "POST") {
    if (!body?.url || !body?.id) return bad("id and url are required");
    const workerUrl = String(body.url).replace(/\/\/(localhost|127\.0\.0\.1)/, `//${isLocal(ip) ? "127.0.0.1" : ip}`);
    hub.transcriber.addWorker(String(body.id), String(body.label ?? "worker"), workerUrl);
    return json({ ok: true, engines: hub.transcriber.engineList() });
  }
  if (path === "/engines") return json({ transcription: hub.transcriber.engineList(), voiceprints: hub.audio.voiceprints.enrolled });

  if (path === "/canvas-link") {
    const kind = url.searchParams.get("kind") === "view" ? "view" : "edit";
    const link = isLocal(ip) ? hub.canvas.localWs(kind) : kind === "view" ? s.canvas.wsView : s.canvas.wsEdit;
    return json({ link, status: s.canvas.status, reason: s.canvas.reason, desktop: kind === "view" ? s.canvas.viewLink : s.canvas.editLink });
  }

  if (path === "/debug/canvas" && isLocal(ip)) {
    const host = hub.canvas.host;
    return json({ peers: await host?.command("collab.peers"), doc: await host?.json("inspect_document", { depth: 2, allPages: true }) });
  }

  if (path === "/brain/digest" && req.method === "POST") return (await hub.brain.digest(true), json({ digest: s.store.digest("session")?.text ?? "" }));

  return bad("not found", 404);
}

async function readBody(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return req.json().catch(() => ({}));
  if (type.includes("multipart/form-data")) return { __form: await req.formData() };
  if (type.includes("audio/") || type.includes("octet-stream")) return { __raw: new Uint8Array(await req.arrayBuffer()) };
  return null;
}

function file(p: string, root: string, cache = false): Response {
  const full = normalize(p);
  if (!full.startsWith(normalize(root)) || !existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = {};
  if (cache && /\.(js|css|wasm|png|jpg|woff2?)$/.test(full) && /[-.][0-9a-f]{8,}\./.test(full)) headers["cache-control"] = "public, max-age=31536000, immutable";
  else headers["cache-control"] = "no-cache";
  return new Response(Bun.file(full), { headers });
}

function cookie(req: Request, name: string) {
  return req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] ?? null;
}

