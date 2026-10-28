// The MCP endpoint every agent connects to (Streamable HTTP at /mcp). It carries the
// session tools (jam_*) and the FigCraft canvas tools (canvas_*), which the hub runs
// for the agent on the host.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config";
import type { Hub } from "./hub";
import { shortRepo, type UpdateKind } from "./session";
import type { Agent, Directive, JamEvent } from "./types";
import { skillMarkdown } from "./skill";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolOut = { content: Content[]; isError?: boolean };

interface Ctx {
  agentId: string | null;
  ip: string;
}

const PLATFORMS = ["desktop", "mobile", "web", "design", "backend", "other"];

const JAM_TOOLS = [
  {
    name: "jam_join",
    description:
      "Join the JamSesh session. Call this first, once per agent session. Returns your agent id, the session brief, who is here, your open directives, and how to work here. Calling it again with the same cwd resumes the same agent.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Your person's first name (who you work for), as they're known in the room" },
        harness: { type: "string", enum: ["claude-code", "codex", "other"] },
        repo: { type: "string", description: "Repository name or remote URL" },
        branch: { type: "string" },
        cwd: { type: "string", description: "Absolute path of your working directory" },
        platform: { type: "string", enum: PLATFORMS, description: "What this repository builds" },
        focus: { type: "string", description: "One line: what you're working on today" },
        name: { type: "string", description: "Optional display name; default is \"<Owner>'s Claude\" or \"<Owner>'s Codex\"" },
      },
      required: ["owner", "harness", "repo", "cwd", "platform"],
    },
  },
  {
    name: "jam_context",
    description:
      "Refresh yourself on the session: the running brief, your workstream's brief, decisions, open directives, recent room conversation, and other agents' recent updates. Call at the start of every new leg of work.",
    inputSchema: {
      type: "object",
      properties: {
        workstream: { type: "string", description: "Workstream title to include its brief" },
        minutes: { type: "number", description: "How many minutes of room conversation to include (default 10)" },
      },
    },
  },
  {
    name: "jam_search",
    description: "Search everything said, typed, decided, and posted in the session (full text).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "jam_update",
    description:
      "Tell the room and the other agents what you're doing. kind: progress, done, shipped (implemented in the repo and verified), question (you need a person), blocked, handoff, decision. Keep text to one or two sentences with specifics.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["progress", "done", "shipped", "question", "blocked", "handoff", "decision"] },
        text: { type: "string" },
        workstream: { type: "string" },
        directiveId: { type: "string", description: "The directive this update answers, if any" },
      },
      required: ["kind", "text"],
    },
  },
  {
    name: "jam_claim",
    description: "Claim a workstream before starting it, so nobody duplicates it. Returns a conflict if another active agent owns it.",
    inputSchema: { type: "object", properties: { workstream: { type: "string" }, force: { type: "boolean" } }, required: ["workstream"] },
  },
  {
    name: "jam_inbox",
    description: "Directives for you and messages from other agents that you haven't seen. Check between steps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "jam_wait",
    description: "When you have nothing to do, wait here for the next directive or message (returns as soon as one arrives, or after the timeout with nothing).",
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "Up to 540; default 240" } } },
  },
  {
    name: "jam_ack",
    description: "Mark a directive acked (you started), done (with a result), or cancelled (with the reason).",
    inputSchema: {
      type: "object",
      properties: { directiveId: { type: "string" }, status: { type: "string", enum: ["acked", "done", "cancelled"] }, result: { type: "string" } },
      required: ["directiveId", "status"],
    },
  },
  {
    name: "jam_message",
    description: "Message another agent directly (by name or id), or 'all'. Use it to align on shared changes, hand work off, or ask who owns something.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] },
  },
  {
    name: "jam_agents",
    description: "Who is in the session: agents (owner, repo, platform, focus, status, workstreams) and people (name, role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "jam_devserver",
    description:
      "Put your running dev server on the host so the room can open it. Bind it to 0.0.0.0 first (for example `vite --host 0.0.0.0`, `next dev -H 0.0.0.0`, `expo start --lan`). Give its local URL; the host forwards a port to it and returns the shared URL.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "What it is, for example 'Mobile app (Expo web)'" }, url: { type: "string", description: "For example http://localhost:5173" }, platform: { type: "string", enum: PLATFORMS } },
      required: ["name", "url"],
    },
  },
  {
    name: "jam_post_image",
    description:
      "Post a screenshot to the big screen and the session (for example your running build, to compare with its mockup). Prefer the HTTP upload in the skill for large files; base64 PNG or JPEG here is fine under 3 MB.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Name it like the mockup it matches, for example 'Mobile nav / B: bottom tabs (built)'" },
        imageBase64: { type: "string" },
        stage: { type: "string", enum: ["built", "mockup"] },
        note: { type: "string" },
        platform: { type: "string", enum: PLATFORMS },
      },
      required: ["title", "imageBase64"],
    },
  },
  {
    name: "jam_show",
    description:
      "Ask the big screen to show your work: spotlight one artifact, compare variants, or a parity view with columns (for example desktop beside mobile). People can override it.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["spotlight", "compare", "parity"] },
        title: { type: "string" },
        caption: { type: "string" },
        artifactIds: { type: "array", items: { type: "string" } },
        columns: { type: "array", items: { type: "object", properties: { label: { type: "string" }, artifactIds: { type: "array", items: { type: "string" } } } } },
      },
      required: ["mode"],
    },
  },
  {
    name: "jam_artifacts",
    description: "List artifacts in the session (canvas frames, screenshots, dev servers) with ids, newest first. Filter by words.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "jam_ask_room",
    description: "Ask the people in the room a question. It shows on the big screen. Their answer comes back as an 'answer' directive.",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "canvas_frames",
    description: "List the frames on the shared canvas: id, name, size, section, and which agent made it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "canvas_render",
    description: "Render one canvas frame to an image, to check it against the design system or against your build.",
    inputSchema: { type: "object", properties: { frameId: { type: "string" }, maxSize: { type: "number" } }, required: ["frameId"] },
  },
];

export class McpEndpoint {
  private sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; ctx: Ctx }>();
  private canvasTools: { name: string; description?: string; inputSchema?: any }[] = [];

  constructor(private hub: Hub) {}

  async loadCanvasTools() {
    if (this.hub.canvas.host?.tools.length) this.canvasTools = this.hub.canvas.host.tools;
  }

  private toolList() {
    const canvas = this.canvasTools
      .filter((t) => !["open_file", "save_file", "inspect_ui", "pointer", "key", "type_text"].includes(t.name))
      .map((t) => ({
        name: `canvas_${t.name}`,
        description: `[FigCraft canvas, live with the room] ${t.description ?? ""}`.slice(0, 1800),
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    return [...JAM_TOOLS, ...canvas];
  }

  async handle(req: Request, ip: string): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid && this.sessions.has(sid)) {
      const s = this.sessions.get(sid)!;
      s.ctx.ip = ip;
      return s.transport.handleRequest(req);
    }
    if (req.method !== "POST") return new Response("Unknown MCP session", { status: 404 });
    const ctx: Ctx = { agentId: null, ip };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => void this.sessions.set(id, { transport, ctx }),
      onsessionclosed: (id) => void this.sessions.delete(id),
    });
    const server = this.server(ctx);
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  private server(ctx: Ctx) {
    const server = new Server(
      { name: "jamsesh", version: "1.0.0" },
      {
        capabilities: { tools: {}, prompts: {} },
        instructions:
          "You are connected to a JamSesh room session. Call jam_join first. Then follow the JamSesh skill (prompt 'jamsesh' or GET /skill.md): claim before you start, report with jam_update, check jam_inbox between steps, jam_wait when idle, and verify mockups against the design system and builds against mockups.",
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.toolList() }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "jamsesh", description: "How to work in this JamSesh session" }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: "user", content: { type: "text", text: skillMarkdown(this.hub) } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as any;
      try {
        const out = await this.call(ctx, name, args, extra as any);
        return out as any;
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    });
    return server;
  }

  private requireAgent(ctx: Ctx): Agent {
    const a = this.hub.session.agent(ctx.agentId);
    if (!a) throw new Error("Call jam_join first.");
    this.hub.session.touchAgent(a.id);
    return a;
  }

  async call(ctx: Ctx, name: string, args: any, extra?: { sendNotification?: (n: any) => Promise<void>; _meta?: any }): Promise<ToolOut> {
    const s = this.hub.session;
    const text = (t: string): ToolOut => ({ content: [{ type: "text", text: t }] });
    const json = (v: unknown): ToolOut => text(JSON.stringify(v, null, 1));

    if (name.startsWith("canvas_") && name !== "canvas_frames" && name !== "canvas_render") {
      const agent = this.requireAgent(ctx);
      const r = await this.hub.canvas.call(agent, name.slice("canvas_".length), args);
      return r as ToolOut;
    }

    switch (name) {
      case "jam_join": {
        const machine = ctx.ip === "127.0.0.1" || ctx.ip === "::1" ? "host" : ctx.ip;
        const { agent, resumed } = s.registerAgent({
          ownerName: String(args.owner ?? ""),
          harness: args.harness ?? "other",
          repo: String(args.repo ?? ""),
          branch: args.branch,
          cwd: args.cwd,
          machine,
          platform: args.platform,
          focus: args.focus,
          name: args.name,
        });
        ctx.agentId = agent.id;
        return text(this.briefing(agent, resumed));
      }
      case "jam_context":
        return text(this.context(this.requireAgent(ctx), args.workstream, args.minutes ?? 10));
      case "jam_search": {
        this.requireAgent(ctx);
        const hits = s.store.searchEvents(String(args.query ?? ""), Math.min(60, args.limit ?? 20));
        return text(hits.map(fmtEvent).join("\n") || "Nothing found.");
      }
      case "jam_update": {
        const agent = this.requireAgent(ctx);
        const ev = s.postUpdate(agent.id, args.kind as UpdateKind, String(args.text ?? ""), { workstream: args.workstream, data: { directiveId: args.directiveId } });
        if (args.directiveId && (args.kind === "done" || args.kind === "shipped")) s.setDirective(args.directiveId, { status: "done", result: args.text });
        const inbox = s.hasInbox(agent.id) ? "\n\nYou have new items: call jam_inbox." : "";
        return text(`Posted (#${ev.id}).${inbox}`);
      }
      case "jam_claim": {
        const agent = this.requireAgent(ctx);
        const { workstream, conflict } = s.claim(agent.id, String(args.workstream), { force: !!args.force });
        if (conflict) return text(`"${workstream.title}" belongs to ${conflict.name} (${conflict.status}, ${conflict.activity}). Message them with jam_message to split the work, or pass force:true if the room reassigned it.`);
        return text(`You own "${workstream.title}".${workstream.brief ? `\n\nBrief so far:\n${workstream.brief}` : ""}`);
      }
      case "jam_inbox":
        return text(this.inboxText(this.requireAgent(ctx)));
      case "jam_wait": {
        const agent = this.requireAgent(ctx);
        const secs = Math.max(5, Math.min(540, Number(args.seconds ?? 240)));
        s.touchAgent(agent.id, { status: "waiting", activity: "Waiting for work" });
        const token = extra?._meta?.progressToken;
        const keepAlive = token != null && extra?.sendNotification
          ? setInterval(() => extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: 0, message: "waiting" } }).catch(() => {}), 20_000)
          : null;
        await s.wait(agent.id, secs * 1000);
        if (keepAlive) clearInterval(keepAlive);
        const out = this.inboxText(agent, true);
        s.touchAgent(agent.id, { status: out.startsWith("Nothing") ? "waiting" : "working" });
        return text(out);
      }
      case "jam_ack": {
        const agent = this.requireAgent(ctx);
        const d = s.store.get("directives", String(args.directiveId));
        if (!d) throw new Error("No directive with that id.");
        s.setDirective(d.id, { status: args.status, result: args.result ?? d.result });
        if (args.status === "acked") s.touchAgent(agent.id, { status: "working", activity: d.text.slice(0, 140) });
        if (args.status !== "acked")
          s.store.addEvent({ kind: "update", authorType: "agent", authorId: agent.id, authorName: agent.name, text: `${args.status === "done" ? "Done" : "Dropped"}: ${d.text.slice(0, 120)}${args.result ? `. ${args.result}` : ""}`, relevance: "work", data: { directiveId: d.id, updateKind: args.status } });
        return text("OK.");
      }
      case "jam_message": {
        const agent = this.requireAgent(ctx);
        s.sendMessage(agent.id, String(args.to), String(args.text));
        return text("Sent.");
      }
      case "jam_agents": {
        this.requireAgent(ctx);
        return text(this.roster());
      }
      case "jam_devserver": {
        const agent = this.requireAgent(ctx);
        let url = String(args.url);
        const remote = agent.machine !== "host" ? agent.machine : "127.0.0.1";
        url = url.replace(/\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?=[:/])/, `//${remote}`);
        if (!/^[a-z]+:\/\//.test(url)) url = url.replace(/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(?=:)/, remote);
        const d = await this.hub.devproxy.register({ agentId: agent.id, name: String(args.name), target: url, platform: args.platform });
        return text(
          d.up
            ? `Live for the room at ${d.url} (forwards to ${d.target}).`
            : `Registered at ${d.url}, but ${d.target} isn't answering from the host. Make sure the dev server listens on 0.0.0.0 (not localhost) and that your firewall allows it, then call jam_devserver again.`,
        );
      }
      case "jam_post_image": {
        const agent = this.requireAgent(ctx);
        const art = await this.hub.saveUpload(agent, Buffer.from(String(args.imageBase64), "base64"), {
          title: String(args.title),
          stage: args.stage ?? "built",
          note: args.note ?? "",
          platform: args.platform,
        });
        return text(`Posted as ${art.id}. Open: ${s.hubUrl}${art.image}`);
      }
      case "jam_show": {
        const agent = this.requireAgent(ctx);
        const known = new Set(s.artifacts().map((a) => a.id));
        const items = (args.artifactIds ?? []).filter((i: string) => known.has(i));
        const columns = (args.columns ?? []).map((c: any) => ({ label: String(c.label ?? ""), items: (c.artifactIds ?? []).filter((i: string) => known.has(i)) }));
        if (!items.length && !columns.some((c: any) => c.items.length)) throw new Error("No known artifact ids. Use jam_artifacts.");
        if (s.stage().pinned) return text("A person pinned the screen; your request is queued as a toast instead.");
        s.setStage({ mode: args.mode, title: args.title ?? "", caption: args.caption ?? "", items, columns: columns.length ? columns : undefined }, agent.name);
        return text("On the big screen.");
      }
      case "jam_artifacts": {
        this.requireAgent(ctx);
        const q = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const list = s
          .artifacts()
          .filter((a) => !q.length || q.every((w) => `${a.title} ${a.note} ${a.agentName} ${a.platform}`.toLowerCase().includes(w)))
          .slice(0, Math.min(80, args.limit ?? 30));
        return text(list.map((a) => `${a.id}: [${a.stage}/${a.kind}] ${a.title}${a.agentName ? ` by ${a.agentName}` : ""}${a.nodeId ? ` (frame ${a.nodeId})` : ""}${a.url ? ` ${a.url}` : ""}`).join("\n") || "No artifacts yet.");
      }
      case "jam_ask_room": {
        const agent = this.requireAgent(ctx);
        s.postUpdate(agent.id, "question", String(args.question));
        return text("Asked. The answer arrives as a directive; call jam_wait.");
      }
      case "canvas_frames": {
        this.requireAgent(ctx);
        return json(await this.hub.canvas.frames());
      }
      case "canvas_render": {
        this.requireAgent(ctx);
        return (await this.hub.canvas.renderNode(String(args.frameId), args.maxSize ?? 1600)) as ToolOut;
      }
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // ---------- text the agents read ----------

  briefing(agent: Agent, resumed: boolean) {
    const s = this.hub.session;
    const inbox = this.inboxText(agent, false);
    return [
      `${resumed ? "Welcome back" : "Welcome"} to "${s.settings().sessionName}". You are ${agent.name} (agent id ${agent.id}).`,
      `Canvas: ${s.canvas.status}. Use the canvas_* tools; they act on the shared FigCraft file as you, live with everyone.`,
      `Upload screenshots: curl -s -F file=@shot.png -F title="<title>" -F stage=built -F agent=${agent.id} "${s.hubUrl}/api/upload?code=${s.code}"`,
      "",
      this.roster(),
      "",
      this.context(agent, undefined, 10),
      "",
      inbox,
      "",
      "Read the JamSesh skill now if you haven't (MCP prompt 'jamsesh', or " + `${s.hubUrl}/skill.md). Next: jam_claim your workstream, then work, posting jam_update as you go.`,
    ].join("\n");
  }

  roster() {
    const s = this.hub.session;
    const ws = s.store.all("workstreams").filter((w) => w.status === "active");
    const agents = s.agents().filter((a) => a.status !== "offline");
    return [
      "People:",
      ...s.people().map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ""}`),
      "Agents:",
      ...agents.map(
        (a) =>
          `- ${a.name} (${a.id}): ${a.platform}, ${shortRepo(a.repo)}${a.branch ? `@${a.branch}` : ""}, ${a.status}${a.focus ? `, focus: ${a.focus}` : ""}${ws.filter((w) => w.ownerAgentId === a.id).length ? `, owns: ${ws.filter((w) => w.ownerAgentId === a.id).map((w) => w.title).join("; ")}` : ""}`,
      ),
    ].join("\n");
  }

  context(agent: Agent, workstream?: string, minutes = 10) {
    const s = this.hub.session;
    const brief = s.store.digest("session")?.text;
    const ws = workstream
      ? s.store.all("workstreams").find((w) => w.title.toLowerCase() === workstream.toLowerCase())
      : s.store.all("workstreams").find((w) => w.ownerAgentId === agent.id && w.status === "active");
    const decisions = s.store.recentEvents({ kinds: ["decision"], limit: 12 });
    const room = s.store
      .recentEvents({ kinds: ["speech", "prompt"], since: Date.now() - minutes * 60_000, limit: 80 })
      .filter((e) => e.relevance !== "banter" && e.relevance !== "chatter");
    const updates = s.store.recentEvents({ kinds: ["update", "artifact", "message"], limit: 20 }).filter((e) => e.authorId !== agent.id);
    const open = s.directives().filter((d) => d.status !== "done" && d.status !== "cancelled").slice(0, 16);
    const mine = open.filter((d) => d.targets.includes(agent.id));
    const others = open.filter((d) => !d.targets.includes(agent.id)).slice(0, 8);
    return [
      `## Session brief\n${brief || "(no brief yet; the session just started)"}`,
      ws ? `## Workstream: ${ws.title}\n${ws.brief || "(no brief yet)"}` : "",
      `## Decisions\n${decisions.map(fmtEvent).join("\n") || "(none yet)"}`,
      `## Open directives for you\n${mine.map((d) => fmtDirective(d, s.agent.bind(s))).join("\n") || "(none: check jam_inbox for new ones)"}`,
      `## Other agents' open directives (context only, not yours to do)\n${others.map((d) => fmtDirective(d, s.agent.bind(s))).join("\n") || "(none)"}`,
      `## Room, last ${minutes} min (banter filtered)\n${room.map(fmtEvent).join("\n") || "(quiet)"}`,
      `## Other agents, recent\n${updates.map(fmtEvent).join("\n") || "(nothing yet)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  inboxText(agent: Agent, mark = true) {
    const s = this.hub.session;
    const { directives, messages } = s.inbox(agent.id, mark);
    if (!directives.length && !messages.length) return "Nothing new.";
    const out: string[] = [];
    for (const d of directives) {
      out.push(
        `DIRECTIVE ${d.id} [${d.mode}] from the room (${d.requestedBy}): ${d.text}${d.rationale ? `\n  why you: ${d.rationale}` : ""}\n  → ${modeHint(d.mode)} Then jam_ack ${d.id} done with what you did.`,
      );
    }
    for (const m of messages) out.push(`MESSAGE from ${m.authorName}: ${m.text}`);
    return out.join("\n\n");
  }
}

function modeHint(mode: Directive["mode"]) {
  switch (mode) {
    case "explore":
      return "Make variants on the canvas, named '<Workstream> / <Letter>: <idea>', built from the real design system. Render each and check it before posting.";
    case "implement":
      return "Implement in your repository. Run the dev server (jam_devserver), screenshot the build at the mockup's size, compare with canvas_render of the mockup, fix differences, then post the screenshot and jam_update shipped.";
    case "coordinate":
      return "Align with the named agents through jam_message. Agree on the behavior, implement your side, post renders, and compare side by side with jam_show parity.";
    case "answer":
      return "This answers your question. Continue with it.";
    case "present":
      return "Put the requested work on the big screen with jam_show.";
  }
}

export function fmtEvent(e: JamEvent) {
  const t = new Date(e.ts).toTimeString().slice(0, 5);
  const label = e.kind === "speech" ? "said" : e.kind === "prompt" ? "typed" : e.kind;
  return `[${t}] ${e.authorName} ${label}: ${e.text}`;
}

function fmtDirective(d: Directive, agent: (id: string) => Agent | undefined) {
  return `- ${d.id} [${d.mode}, ${d.status}] → ${d.targets.map((t) => agent(t)?.name ?? t).join(", ")}: ${d.text}`;
}

void config;
