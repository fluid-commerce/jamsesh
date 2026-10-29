// The MCP endpoint every agent connects to (Streamable HTTP at /mcp). It carries the
// session tools (jam_*) and the FigCraft canvas tools (canvas_*), which the hub runs
// for the agent on the host.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bus } from "./bus";
import { config } from "./config";
import { ownTarget } from "./devproxy";
import type { Hub } from "./hub";
import { shortRepo, type UpdateKind } from "./session";
import type { Agent, Directive, JamEvent } from "./types";
import { JOIN_RULE, skillMarkdown } from "./skill";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolOut = { content: Content[]; isError?: boolean };

interface Ctx {
  agentId: string | null;
  ip: string;
  /** The paired device this agent connected with ("host" for agents on the host). */
  device: string | null;
  /** The address the agent reached the hub through (the app's relay on the host Mac, or the LAN address). */
  origin?: string;
  /** This MCP connection: one per chat, so it tells chats apart when the harness has no hooks (Codex). */
  sessionId?: string;
  /** The skill text has been handed over in this connection (a new conversation starts a new one). */
  skillSent?: boolean;
  /** Who opened this session (see McpEndpoint.owner): every later request must come from the same. */
  owner?: string;
}

/** A remote URL without the credentials some people have embedded in it. */
export function cleanRepo(repo: string) {
  return repo.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

const PLATFORMS = ["desktop", "mobile", "web", "design", "backend", "other"];

const JAM_TOOLS = [
  {
    name: "jam_join",
    description:
      "Join the JamSesh session, only because your person told you to (\"connect to jamsesh\"). Call this first, once per chat. Returns your agent id, the session brief, who is here, your open directives, and how to work here. Calling it again from the same chat resumes the same agent.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Your person's first name (who you work for), as they're known in the room. Leave it out when you joined through the JamSesh app; the room already knows whose Mac this is." },
        harness: { type: "string", enum: ["claude-code", "codex", "other"] },
        repo: { type: "string", description: "Repository name or remote URL" },
        branch: { type: "string" },
        cwd: { type: "string", description: "Absolute path of your working directory" },
        chat: { type: "string", description: "Claude Code only: the chat id from the JamSesh note at the start of your conversation. Leave it out if you didn't get one." },
        platform: { type: "string", enum: PLATFORMS, description: "What this repository builds" },
        focus: { type: "string", description: "One line: what you're working on today" },
        name: { type: "string", description: "Optional display name; default is \"<Owner>'s Claude\" or \"<Owner>'s Codex\"" },
        role: { type: "string", enum: ["worker", "observer"], description: "worker (default) does the room's product work and needs repo and platform. observer only watches: no repository, never given product tasks." },
        broadcasts: { type: "boolean", description: "Observers only: false opts out of room-wide messages (to everyone). Default true." },
      },
      required: ["harness", "cwd"],
    },
  },
  {
    name: "jam_rename",
    description:
      "Set your own display name (what the room and other agents call you, for example \"Pixel\") and/or your person's name and title, so names stay clear. Use it when your person tells you what to call you or corrects their own name or title.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Your new display name" },
        owner: { type: "string", description: "Your person's name as the room knows them" },
        ownerTitle: { type: "string", description: "Your person's position or title, for example CPO or Senior designer" },
      },
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
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, offset: { type: "number", description: "Skip this many hits to see more" } }, required: ["query"] },
  },
  {
    name: "jam_update",
    description:
      "Tell the room and the other agents what you're doing. kind: progress, done, shipped (implemented in the repo and verified), question (you need a person), blocked, handoff, decision (proposed to the room brain, which makes it a room decision if it binds others). Keep text to one or two sentences with specifics.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["progress", "done", "shipped", "question", "blocked", "handoff", "decision"] },
        text: { type: "string" },
        workstream: { type: "string" },
        directiveId: { type: "string", description: "The directive this update answers, if any" },
        platformSpecific: { type: "boolean", description: "With shipped: the change is deliberately for your platform only, so other platforms aren't asked to match it" },
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
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "Up to 230; default 200. Call it again right away when it returns nothing." } } },
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
    description: "Message another agent directly (by name or id), or 'all'. Message the room brain by its name to ask it something or have it route or note something. Use it to align on shared changes, hand work off, or ask who owns something.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] },
  },
  {
    name: "jam_ask",
    description:
      "Ask another agent a question and wait for its answer (it is told to answer right away). Use it whenever another agent's knowledge would save you guessing: how their repo does something, what their mockup's spacing is, whether they already built a component, what they decided. Returns the answer, or tells you it's still pending.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "Agent name or id" }, question: { type: "string" }, waitSeconds: { type: "number", description: "Up to 230; default 120" } },
      required: ["to", "question"],
    },
  },
  {
    name: "jam_answer",
    description: "Answer a question another agent (or the room brain) asked you. Do this as soon as a QUESTION shows up in your inbox, before continuing your own work. Be concrete: file paths, values, names.",
    inputSchema: { type: "object", properties: { askId: { type: "string" }, text: { type: "string" } }, required: ["askId", "text"] },
  },
  {
    name: "jam_repo_card",
    description:
      "Describe your repository for the room and the other agents, right after joining and whenever it changes meaningfully: the stack, where the design system lives (token files, theme, component library paths), key components, your branch, and recent changes. The room brain uses it to route work and to spot what should match across platforms.",
    inputSchema: {
      type: "object",
      properties: {
        stack: { type: "string", description: "For example 'Expo SDK 52, React Native, TypeScript, Zustand'" },
        designSystem: { type: "string", description: "Where tokens, theme and shared components live, with the key values (accent, type scale, radii)" },
        components: { type: "string", description: "Notable components and screens relevant to today's work" },
        branch: { type: "string" },
        recentChanges: { type: "string", description: "What changed recently, including uncommitted work" },
        notes: { type: "string" },
        repo: { type: "string", description: "Repository name or remote URL, when you moved to a different one" },
        platform: { type: "string", enum: PLATFORMS, description: "What this repository builds, when it changed" },
        focus: { type: "string", description: "One line: what you're working on now" },
      },
      required: ["stack", "designSystem"],
    },
  },
  {
    name: "jam_agents",
    description: "Who is in the session: agents (owner, repo, platform, focus, status, workstreams) and people (name, role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "jam_devserver",
    description:
      "Put your running dev server on the host so the room can open it. Bind it to 0.0.0.0 first (for example `vite --host 0.0.0.0`, `next dev -H 0.0.0.0`; for Expo use `expo start --web`, since `--lan` only serves the app manifest). Give its local URL on your own machine; the host forwards a port to it, open only to people in the session, and returns the shared URL.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "What it is, for example 'Mobile app (Expo web)'" }, url: { type: "string", description: "For example http://localhost:5173" }, platform: { type: "string", enum: PLATFORMS } },
      required: ["name", "url"],
    },
  },
  {
    name: "jam_host_preview",
    description:
      "Ask the room to build your pushed branch on the host Mac and open it there: a desktop app, or an iPhone build in the Simulator. Nothing runs until a person in the room approves (they say \"approve\" or press Approve); you get a message with the answer. Push your branch first: the host clones your repository's remote. Use jam_devserver instead for anything that runs in a browser.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The build command, run in the repository root on the host, for example 'npm ci && npm run tauri build -- --debug'" },
        open: { type: "string", description: "What to open when it finishes: a path in the repository (for example 'src-tauri/target/debug/bundle/macos/App.app'), or 'simulator:<path to .app>' for an iPhone build" },
        branch: { type: "string", description: "Defaults to the branch you joined with" },
      },
      required: ["command"],
    },
  },
  {
    name: "jam_devserver_remove",
    description: "Take one of your dev servers off the host when you've stopped it. Give its name, or leave it out to remove all of yours.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
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
    description: "List artifacts in the session (canvas frames, screenshots, dev servers) with ids, newest first. Filter by words. Long sessions have more than one page: it says how many more there are; pass offset to page on. Pass id (for example doc_… from a pointer in your inbox) to read a long document someone shared, in full.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A document id from a pointer, to read it in full" }, query: { type: "string" }, limit: { type: "number" }, offset: { type: "number", description: "Skip this many (from the newest) to see older ones" } } },
  },
  {
    name: "jam_directives",
    description: "List the session's directives (what the room asked agents to do), newest first, with their status, so you can see older ones the context leaves out. Filter by words or status. It says how many more there are; pass offset to page on.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, status: { type: "string", description: "open, done or cancelled" }, limit: { type: "number" }, offset: { type: "number" } },
    },
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

const machineIsHost = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

export class McpEndpoint {
  private sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; ctx: Ctx }>();
  private canvasTools: { name: string; description?: string; inputSchema?: any }[] = [];
  /** When each agent last changed the canvas and last rendered a frame: to nudge unchecked work. */
  private canvasState = new Map<string, { edit: number; render: number }>();

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

  /**
   * Who may use an MCP session: the kind of credential and the machine it stands for, so the Mac app
   * re-issuing its agents credential on a relaunch keeps the session, and nobody else can use it.
   * The host's loopback is the host's agents (the app's relay hands any process there that credential).
   */
  private owner(device: string | null) {
    if (!device || device === "host") return "agent:host";
    const d = this.hub.auth.get(device);
    return d ? `${d.kind}:${this.hub.auth.machineOf(device)}` : `?:${device}`;
  }

  async handle(req: Request, ip: string, device: string | null = null, origin?: string): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid && this.sessions.has(sid)) {
      const s = this.sessions.get(sid)!;
      // A session id is only good from the credential's own machine: another paired device that
      // learned it gets "not found", the same as a session that never existed.
      if (s.ctx.owner !== this.owner(device)) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
      s.ctx.device = device;
      s.ctx.ip = ip;
      if (origin) s.ctx.origin = origin;
      return s.transport.handleRequest(req);
    }
    // An unknown session (the hub restarted): 404 tells the client to start a new one.
    if (sid || req.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
    const ctx: Ctx = { agentId: null, ip, device, origin, owner: this.owner(device) };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        ctx.sessionId = id;
        this.sessions.set(id, { transport, ctx });
      },
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
          `These tools connect this chat to a live JamSesh room session with jam_join. ${JOIN_RULE} Until your person asks, don't call any JamSesh tool. Once you've joined, follow the JamSesh skill (prompt 'jamsesh' or GET /skill.md): claim before you start, report with jam_update, check jam_inbox between steps, when idle: Claude Code stops (JamSesh wakes it when the room has something), Codex calls jam_wait (it returns after a few minutes with nothing; call it again), and verify mockups against the design system and builds against mockups.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.toolList() }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "jamsesh", description: "How to work in this JamSesh session" }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: "user", content: { type: "text", text: skillMarkdown(this.hub, ctx.origin) } }],
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

  /** After a wait: a device disconnected meanwhile gets nothing more. */
  private requireCredential(ctx: Ctx) {
    if (ctx.device && ctx.device !== "host" && !this.hub.auth.get(ctx.device)) throw new Error("This device was disconnected from the JamSesh session.");
  }

  private requireAgent(ctx: Ctx): Agent {
    const a = this.hub.session.agent(ctx.agentId);
    if (!a && ctx.agentId && this.hub.session.removedAgents.has(ctx.agentId)) throw new Error("The room removed you from this session. Don't join again unless your person asks you to.");
    if (!a) throw new Error("Call jam_join first. (If you were already in the session, the hub restarted: call jam_join again with the same details to pick up where you left off.)");
    this.hub.session.touchAgent(a.id);
    return a;
  }

  async call(ctx: Ctx, name: string, args: any, extra?: { sendNotification?: (n: any) => Promise<void>; _meta?: any }): Promise<ToolOut> {
    const out = await this.callTool(ctx, name, args, extra);
    // An agent with no hooks (Codex) hears the room only when it asks, so every JamSesh call it makes
    // says if something is waiting. Claude Code's hooks hand the items over themselves.
    const id = ctx.agentId;
    if (id && !out.isError && !/^jam_(join|inbox|wait|ask)$/.test(name) && !name.startsWith("canvas_") && !this.hub.hooked(id) && this.hub.session.hasInbox(id) && !out.content.some((c: any) => /call jam_inbox/.test(c.text ?? "")))
      return { ...out, content: [...out.content, { type: "text", text: "You have new items from the room: call jam_inbox." }] };
    return out;
  }

  private async callTool(ctx: Ctx, name: string, args: any, extra?: { sendNotification?: (n: any) => Promise<void>; _meta?: any }): Promise<ToolOut> {
    const s = this.hub.session;
    const text = (t: string): ToolOut => ({ content: [{ type: "text", text: t }] });
    const json = (v: unknown): ToolOut => text(JSON.stringify(v, null, 1));

    if (name.startsWith("canvas_") && name !== "canvas_frames" && name !== "canvas_render") {
      const agent = this.requireAgent(ctx);
      const r = await this.hub.canvas.call(agent, name.slice("canvas_".length), args);
      if (!r.isError && /^canvas_(create_node|set_properties|batch|run_command|delete_nodes?|import_svg)$/.test(name)) this.canvasNote(agent.id).edit = Date.now();
      return r as ToolOut;
    }

    switch (name) {
      case "jam_join": {
        // The paired device identifies the machine (an address can change between networks).
        // An agents credential stands for its owner window, so a relaunch (a new credential) is the same machine.
        const machine = this.hub.auth.machineOf(ctx.device) ?? (ctx.ip === "127.0.0.1" || ctx.ip === "::1" ? "host" : ctx.ip);
        // Through the Mac app, the paired device already belongs to a person.
        const onHost = ctx.device === "host" || (!ctx.device && machineIsHost(ctx.ip));
        const ownerId = onHost ? s.store.setting<string>("hostPersonId", "") : ctx.device ? this.hub.auth.list().find((d) => d.id === ctx.device)?.personId : undefined;
        const pairedOwner = ownerId ? s.person(ownerId)?.name : undefined;
        // A credential that belongs to a person speaks for that person only: `owner` can't name someone else.
        const ownerName = String(pairedOwner || args.owner || "");
        if (!ownerName) throw new Error("Ask your person for their first name, then call jam_join again with owner.");
        // Which chat this is. Claude Code's hooks hand it its session id (passed as chat). A harness without
        // hooks (Codex) has no chat id of its own, and its MCP session changes on every reconnect or hub
        // restart, so its chat is its folder on its machine: a reconnect resumes it and a removal sticks.
        // (Two Codex chats open in one folder at once are one agent.) Without even a folder, the session.
        const where = String(args.cwd ?? "").trim() || String(args.repo ?? "").trim();
        const harness = String(args.harness ?? "other");
        const chatId =
          typeof args.chat === "string" && args.chat.trim()
            ? args.chat.trim().slice(0, 80)
            : harness !== "claude-code" && where
              ? `${harness}:${machine}:${where}`.slice(0, 300)
              : ctx.sessionId
                ? `mcp:${ctx.sessionId}`
                : undefined;
        // A chat the room removed stays out until a person lets it back in.
        if (s.rejoinBlocked(chatId, ctx.agentId))
          throw new Error('The room removed this chat from the session, so it can\'t join again by itself. Your person can say "connect to jamsesh" in this chat to bring it back, or someone in the room can choose Allow again in Settings.');
        // Rejoining keeps the stored role unless the caller names one (the session settles it).
        const role = args.role === "observer" || args.role === "worker" ? (args.role as "observer" | "worker") : undefined;
        const { agent, resumed, quietMs } = s.registerAgent({
          ownerName,
          harness: args.harness ?? "other",
          repo: cleanRepo(String(args.repo ?? "")),
          role,
          broadcasts: typeof args.broadcasts === "boolean" ? args.broadcasts : undefined,
          branch: args.branch,
          cwd: args.cwd,
          machine,
          chatId, // see above
          platform: args.platform,
          focus: args.focus,
          name: args.name,
          // A record from an earlier credential of this same Mac (its owner window) can be taken over.
          sameMachine: (old) => this.hub.auth.machineOf(old) === machine,
        });
        ctx.agentId = agent.id;
        const first = !ctx.skillSent;
        ctx.skillSent = true;
        // Back within half an hour is a reconnect (the app or the host restarted): the agent still
        // has the skill and the context in its conversation, so don't send it all again.
        if (resumed && quietMs !== null && quietMs < 30 * 60_000) return text(this.rejoinBriefing(agent, ctx.origin));
        return text(this.briefing(agent, resumed, first, ctx.origin));
      }
      case "jam_rename": {
        const agent = this.requireAgent(ctx);
        const fields: Partial<Agent> = {};
        if (args.owner || args.ownerTitle) {
          const cur = s.person(agent.ownerId);
          const p = cur
            ? s.upsertPerson({ id: cur.id, name: args.owner ?? cur.name, role: args.ownerTitle ?? cur.role })
            : s.upsertPerson({ name: args.owner ?? agent.ownerName, role: args.ownerTitle });
          fields.ownerId = p.id;
          fields.ownerName = p.name;
        }
        if (args.name?.trim()) {
          const taken = s.agents().find((a) => a.id !== agent.id && a.name.toLowerCase() === String(args.name).trim().toLowerCase());
          if (taken) throw new Error(`${taken.name} is already taken by ${taken.ownerName}'s agent; pick another name.`);
          fields.name = String(args.name).trim().slice(0, 40);
        }
        const before = agent.name;
        s.touchAgent(agent.id, fields);
        s.store.put("agents", { ...s.agent(agent.id)! });
        const now = s.agent(agent.id)!;
        if (before !== now.name) void this.hub.canvas.renameAgent(agent.id, now.name);
        s.store.addEvent({ kind: "system", authorType: "agent", authorId: agent.id, authorName: now.name, text: `${before !== now.name ? `${before} is now ${now.name}` : now.name} (${now.ownerName}${s.person(now.ownerId)?.role ? `, ${s.person(now.ownerId)!.role}` : ""}'s agent).` });
        return text(`You are ${now.name}, working for ${now.ownerName}${s.person(now.ownerId)?.role ? ` (${s.person(now.ownerId)!.role})` : ""}.`);
      }
      case "jam_context":
        return text(this.context(this.requireAgent(ctx), args.workstream, args.minutes ?? 10));
      case "jam_search": {
        this.requireAgent(ctx);
        const limit = Math.min(60, Math.max(1, Number(args.limit) || 20));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        // One extra hit tells whether there are more without counting them all.
        const hits = s.store.searchEvents(String(args.query ?? ""), limit + 1, offset);
        const shown = hits.slice(0, limit);
        return text(shown.length ? `${shown.map(fmtEvent).join("\n")}${hits.length > limit ? `\n\nThere are more matches: call again with offset ${offset + limit}.` : ""}` : "Nothing found.");
      }
      case "jam_update": {
        const agent = this.requireAgent(ctx);
        const ev = s.postUpdate(agent.id, args.kind as UpdateKind, String(args.text ?? ""), { workstream: args.workstream, data: { directiveId: args.directiveId, ...(args.platformSpecific === true ? { platformSpecific: true } : {}) } });
        if (args.directiveId && (args.kind === "done" || args.kind === "shipped")) s.setDirectiveFor(args.directiveId, agent.id, "done", args.text);
        const inbox = s.hasInbox(agent.id) ? "\n\nYou have new items: call jam_inbox." : "";
        return text(`Posted (#${ev.id}).${inbox}${this.checkWarning(agent, args.kind, args.directiveId)}${s.shareNudge(agent.id, String(args.text ?? ""))}`);
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
        const secs = Math.max(5, Math.min(230, Number(args.seconds ?? 200)));
        s.touchAgent(agent.id, { status: "waiting", activity: "Waiting for work" });
        const token = extra?._meta?.progressToken;
        const keepAlive = token != null && extra?.sendNotification
          ? setInterval(() => extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: 0, message: "waiting" } }).catch(() => {}), 20_000)
          : null;
        await s.wait(agent.id, secs * 1000);
        if (keepAlive) clearInterval(keepAlive);
        this.requireAgent(ctx); // removed while it waited: says so instead of handing it anything
        this.requireCredential(ctx);
        const out = this.inboxText(agent, true);
        const idle = out.startsWith("Nothing new.");
        s.touchAgent(agent.id, { status: idle ? "waiting" : "working", activity: idle ? "Waiting for work" : out.replace(/^(DIRECTIVE \S+ \[\w+\][^:]*: |MESSAGE from |Nothing new, but you haven't finished: )/, "").slice(0, 140) });
        return text(out);
      }
      case "jam_ack": {
        const agent = this.requireAgent(ctx);
        const d = s.store.get("directives", String(args.directiveId));
        if (!d) throw new Error("No directive with that id.");
        s.setDirectiveFor(d.id, agent.id, args.status, args.result);
        if (args.status === "acked") s.touchAgent(agent.id, { status: "working", activity: d.text.slice(0, 140) });
        if (args.status !== "acked")
          s.store.addEvent({ kind: "update", authorType: "agent", authorId: agent.id, authorName: agent.name, text: `${args.status === "done" ? "Done" : "Dropped"}: ${d.text.slice(0, 120)}${args.result ? `. ${args.result}` : ""}`, relevance: "work", data: { directiveId: d.id, updateKind: args.status } });
        return text("OK.");
      }
      case "jam_message": {
        const agent = this.requireAgent(ctx);
        s.sendMessage(agent.id, String(args.to), String(args.text));
        return text(`Sent.${s.shareNudge(agent.id, String(args.text ?? ""))}`);
      }
      case "jam_ask": {
        const agent = this.requireAgent(ctx);
        const secs = Math.max(5, Math.min(230, Number(args.waitSeconds ?? 120)));
        const { askId, answer } = s.ask(agent.id, String(args.to), String(args.question), secs * 1000);
        s.touchAgent(agent.id, { status: "waiting", activity: `Asked ${String(args.to)}: ${String(args.question).slice(0, 100)}` });
        const a = await answer;
        // Removed, or its device disconnected, while it waited: nothing more for it.
        this.requireAgent(ctx);
        this.requireCredential(ctx);
        s.touchAgent(agent.id, { status: "working" });
        return text(a ? `Answer: ${a}` : `No answer yet (question ${askId}). It will arrive in your inbox; carry on and check jam_inbox.`);
      }
      case "jam_answer": {
        const agent = this.requireAgent(ctx);
        s.answer(agent.id, String(args.askId), String(args.text));
        return text("Answered.");
      }
      case "jam_repo_card": {
        const agent = this.requireAgent(ctx);
        const card = {
          stack: String(args.stack ?? ""),
          designSystem: String(args.designSystem ?? ""),
          components: String(args.components ?? ""),
          branch: String(args.branch ?? agent.branch ?? ""),
          recentChanges: String(args.recentChanges ?? ""),
          notes: String(args.notes ?? ""),
          updatedAt: Date.now(),
        };
        // The card is the agent's word on where it is now: the tile follows it.
        const repo = typeof args.repo === "string" && args.repo.trim() ? cleanRepo(args.repo) : agent.repo;
        const platform = PLATFORMS.includes(args.platform) ? args.platform : agent.platform;
        const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim().slice(0, 200) : agent.focus;
        s.touchAgent(agent.id, { card, branch: card.branch || agent.branch, repo, platform, focus });
        s.store.put("agents", s.agent(agent.id)!);
        if (repo !== agent.repo) s.store.addEvent({ kind: "system", authorType: "agent", authorId: agent.id, authorName: agent.name, text: `${agent.name} moved to ${shortRepo(repo)}${focus ? `: ${focus}` : ""}.` });
        return text("Repo card saved. Other agents and the room brain can see it.");
      }
      case "jam_agents": {
        this.requireAgent(ctx);
        return text(this.roster());
      }
      case "jam_host_preview": {
        const agent = this.requireAgent(ctx);
        if (!s.settings().hostControl) return text("Host control is turned off on the host, so it can't build previews. Use jam_devserver for a web build, or ask the room to turn host control on.");
        const r = this.hub.host.request({
          agentId: agent.id,
          agentName: agent.name,
          ownerName: agent.ownerName,
          repo: agent.repo,
          branch: String(args.branch ?? agent.branch ?? ""),
          command: String(args.command ?? ""),
          open: args.open ? String(args.open) : undefined,
        });
        if (typeof r === "string") return text(r);
        return text(`Asked the room (request ${r.id}). The host announces it and waits for a person to approve. You'll get a message with the answer; carry on meanwhile.`);
      }
      case "jam_devserver": {
        const agent = this.requireAgent(ctx);
        // The dev server has to be on the agent's own machine: its address as the hub sees it.
        let from = ctx.ip;
        if (from === "relayed") {
          // Through the Mac app's relay the hub only sees loopback: that is the host Mac only for its own agents.
          const own = ctx.device === "host" || this.hub.auth.machineOf(ctx.device) === "host";
          if (!own) throw new Error("The hub can't tell where your machine is from here (you're behind a tunnel or proxy), so it can't reach a dev server on it. Share a screenshot with jam_post_image instead.");
          from = "127.0.0.1";
        }
        const target = ownTarget(String(args.url ?? ""), from);
        const d = await this.hub.devproxy.register({ agentId: agent.id, name: String(args.name ?? "Dev server").slice(0, 80), target, platform: args.platform });
        return text(
          d.up
            ? `Live for the room at ${d.url} (forwards to ${d.target}). Only people in the session can open it. Hot reload works through it. Call jam_devserver_remove when you stop it.`
            : `Registered at ${d.url}, but ${d.target} isn't answering from the host. Make sure the dev server listens on 0.0.0.0 (not localhost) and that your firewall allows it, then call jam_devserver again.`,
        );
      }
      case "jam_devserver_remove": {
        const agent = this.requireAgent(ctx);
        const mine = s.devservers().filter((d) => d.agentId === agent.id && (!args.name || d.name.toLowerCase() === String(args.name).toLowerCase()));
        if (!mine.length) return text(args.name ? `You have no dev server called "${args.name}".` : "You have no dev servers on the host.");
        for (const d of mine) this.hub.devproxy.remove(d.id);
        return text(`Removed ${mine.map((d) => d.name).join(", ")}.`);
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
        const cur = s.stage();
        const peopleChose = !s.agents().some((a) => a.name === cur.by) && cur.mode !== "board" && cur.mode !== "welcome";
        if (cur.pinned || (peopleChose && Date.now() - cur.since < 90_000)) {
          const why = cur.pinned ? "A person pinned the screen" : `${cur.by} just put something on the screen`;
          bus.send({ type: "toast", tone: "info", text: `${agent.name} would like to show ${args.title || "their work"}`, detail: `${why}, so it wasn't swapped in.` });
          return text(`${why}, so I didn't replace it. The room got a note that you'd like to show this; try again in a minute or ask them.`);
        }
        s.setStage({ mode: args.mode, title: args.title ?? "", caption: args.caption ?? "", items, columns: columns.length ? columns : undefined }, agent.name);
        return text("On the big screen.");
      }
      case "jam_artifacts": {
        this.requireAgent(ctx);
        if (args.id) {
          const doc = s.store.get("documents", String(args.id));
          if (!doc) throw new Error("No document with that id.");
          return text(`${doc.authorName}, ${new Date(doc.ts).toTimeString().slice(0, 5)}:\n\n${doc.text}`);
        }
        const q = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = s.artifacts().filter((a) => !q.length || q.every((w) => `${a.title} ${a.note} ${a.agentName} ${a.platform}`.toLowerCase().includes(w)));
        const { shown, more } = pageOf(all, args);
        return text(shown.map((a) => `${a.id}: [${a.stage}/${a.kind}] ${a.title}${a.agentName ? ` by ${a.agentName}` : ""}${a.nodeId ? ` (frame ${a.nodeId})` : ""}${a.url ? ` ${a.url}` : ""}`).join("\n") + more || "No artifacts yet.");
      }
      case "jam_directives": {
        this.requireAgent(ctx);
        const q = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const want = String(args.status ?? "").toLowerCase();
        const all = s.directives().filter((d) => (!q.length || q.every((w) => `${d.text} ${d.result ?? ""}`.toLowerCase().includes(w))) && (!want || (want === "open" ? d.status !== "done" && d.status !== "cancelled" : d.status === want)));
        const { shown, more } = pageOf(all, args);
        return text(shown.map((d) => fmtDirective(d, (id) => s.agent(id))).join("\n") + more || "No directives yet.");
      }
      case "jam_ask_room": {
        const agent = this.requireAgent(ctx);
        s.postUpdate(agent.id, "question", String(args.question));
        return text(`Asked. The answer arrives as a directive; ${agent.harness === "claude-code" ? "carry on, or stop if you're done: JamSesh wakes you with it." : "call jam_wait."}`);
      }
      case "canvas_frames": {
        this.requireAgent(ctx);
        return json(await this.hub.canvas.frames());
      }
      case "canvas_render": {
        const agent = this.requireAgent(ctx);
        // Counts as a look at the canvas (for the "done" check) only once a picture came back, and as
        // of when it was asked for, so an edit made while it rendered still needs another look.
        const asked = Date.now();
        const looked = (r: ToolOut) => (!r.isError && (this.canvasNote(agent.id).render = Math.max(this.canvasNote(agent.id).render, asked)), r);
        // The agent's own copy of the file has its latest edits; the host's can be a moment behind,
        // and a render that misses the edit just made would tell the agent its fix didn't land.
        const own = await this.hub.canvas.call(agent, "screenshot", { ids: [Number(args.frameId)], maxSize: args.maxSize ?? 1600 }).catch(() => null);
        if (own && !own.isError) return looked(own as ToolOut);
        return looked((await this.hub.canvas.renderNode(String(args.frameId), args.maxSize ?? 1600)) as ToolOut);
      }
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // ---------- text the agents read ----------

  private canvasNote(agentId: string) {
    let c = this.canvasState.get(agentId);
    if (!c) this.canvasState.set(agentId, (c = { edit: 0, render: 0 }));
    return c;
  }

  /** A reminder appended to jam_update when "done" or "shipped" skips the checks the skill asks for. */
  private checkWarning(agent: Agent, kind: string, directiveId?: string): string {
    const s = this.hub.session;
    // A note has no build or canvas work to check.
    if (directiveId && s.store.get("directives", directiveId)?.mode === "note") return "";
    const now = Date.now();
    if (kind === "done") {
      const c = this.canvasState.get(agent.id);
      if (c && c.edit > c.render && now - c.edit < 2 * 3600_000)
        return "\n\nHeads-up: you changed the canvas after your last canvas_render. Render your frames, look at them next to the product's real screens, and fix differences before calling this finished. Post a corrected update if something was off.";
    }
    if (kind === "shipped") {
      const built = s.artifacts().some((a) => a.agentId === agent.id && a.stage === "built" && a.kind !== "devserver" && now - Math.max(a.ts, a.updatedAt ?? 0) < 3 * 3600_000);
      if (!built)
        return "\n\nHeads-up: there's no \"(built)\" screenshot from you yet. Screenshot your running build at the mockup's size, compare it with canvas_render of the mockup, and post it with jam_post_image so the room sees both. Then say what still differs.";
    }
    return "";
  }

  /**
   * What `jam_join` returns: who is here, your workstream, what is asked of you, a short session brief and the
   * tools that fetch more. A busy session's full context is thousands of tokens; `jam_context` has it on demand.
   */
  briefing(agent: Agent, resumed: boolean, fullSkill = true, origin = this.hub.session.hubUrl) {
    const s = this.hub.session;
    const role = s.person(agent.ownerId)?.role;
    const ws = s.store.all("workstreams").find((w) => w.ownerAgentId === agent.id && w.status === "active");
    const settled = s.facts().filter((f) => f.status === "active").length;
    const mine = s.directives().filter((d) => d.status !== "done" && d.status !== "cancelled" && d.targets.includes(agent.id));
    const brief = s.store.digest("session")?.text.trim();
    return [
      `${resumed ? "Welcome back" : "Welcome"} to "${s.settings().sessionName}". You are ${agent.name} (agent id ${agent.id}), working for ${agent.ownerName}${role ? ` (${role})` : ""}. The room brain is called "${s.settings().brainName}".`,
      role ? "" : `Your person has no title in the room yet. Ask them their position (for example designer, engineer, CPO) and call jam_rename with ownerTitle; titles decide whose call wins when people disagree. If they give you a name to go by, jam_rename with name too.`,
      `Canvas: ${s.canvas.status}. Use the canvas_* tools; they act on the shared FigCraft file as you, live with everyone.`,
      `Upload screenshots: curl -s -F file=@shot.png -F title="<title>" -F stage=built -F agent=${agent.id} -H @"$HOME/.jamsesh/auth.header" "${origin}/api/upload"`,
      "",
      this.roster(true),
      "",
      `## Session brief\n${brief ? clip(brief, 600) : "(no brief yet; the session just started)"}${settled ? `\n${settled} settled point${settled === 1 ? "" : "s"} (decisions, requirements, constraints) are in jam_context.` : ""}`,
      ws ? `## Your workstream: ${ws.title}\n${clip(ws.brief || "(no brief yet)", 500)}` : "",
      `## Open directives for you\n${mine.length ? `${mine.slice(0, 5).map((d) => clip(fmtDirective(d, s.agent.bind(s)), 300)).join("\n")}${mine.length > 5 ? `\n${mine.length - 5} more: jam_directives.` : ""}` : "(none yet)"}`,
      this.unreadLine(agent),
      "",
      "## Fetch more when you need it",
      "- jam_context: the full picture (settled points, decisions, room conversation, other agents' updates). Call it at the start of each new leg of work.",
      "- jam_search: full text of everything said, typed and decided.",
      "- jam_artifacts: frames, screenshots and dev servers; also opens a long document someone shared (give its id).",
      "- jam_directives: everything the room has asked, including older ones.",
      fullSkill
        ? `\n## How to work here\n${workingRules(agent)}\nThe full JamSesh skill: the MCP prompt 'jamsesh', or GET ${origin}/skill.md.`
        : `You already have the JamSesh skill from this conversation. Next: jam_inbox, then carry on. ${idleHint(agent)}`,
    ]
      .filter((x) => x !== "")
      .join("\n");
  }

  /** One line on what is waiting in the inbox (the items themselves are read with jam_inbox, which marks them delivered). */
  private unreadLine(agent: Agent) {
    const { directives, messages } = this.hub.session.inbox(agent.id, false);
    const n = directives.length + messages.length;
    return n ? `Waiting in your inbox: ${n} item${n === 1 ? "" : "s"}. Call jam_inbox next.` : "Your inbox is empty.";
  }

  /** A reconnect: who you are, where uploads go now, and what's new; the rest is already known. */
  rejoinBriefing(agent: Agent, origin = this.hub.session.hubUrl) {
    return [
      `Reconnected to "${this.hub.session.settings().sessionName}" as ${agent.name} (agent id ${agent.id}); your workstreams and directives are as you left them.`,
      `Upload screenshots: curl -s -F file=@shot.png -F title="<title>" -F stage=built -F agent=${agent.id} -H @"$HOME/.jamsesh/auth.header" "${origin}/api/upload"`,
      "",
      this.inboxText(agent, false),
      "",
      `Call jam_context if you need the room's latest; otherwise carry on. ${idleHint(agent)}`,
      "If this is a new conversation and you don't have the JamSesh skill yet, read it first: the MCP prompt 'jamsesh', or GET /skill.md.",
    ].join("\n");
  }

  roster(compact = false) {
    const s = this.hub.session;
    const ws = s.store.all("workstreams").filter((w) => w.status === "active");
    const agents = s.agents().filter((a) => a.status !== "offline");
    return [
      "People (name, title, whose call counts more when people disagree):",
      ...s.people().map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ", (no title yet)"}${p.weight > 1 ? ` (weight ${p.weight})` : ""}${s.agents().filter((a) => a.ownerId === p.id && a.status !== "offline").length ? `; agents: ${s.agents().filter((a) => a.ownerId === p.id && a.status !== "offline").map((a) => a.name).join(", ")}` : ""}`),
      "Room brain (jam_message it by name; it routes work and answers):",
      `- ${s.settings().brainName}`,
      "Agents:",
      ...agents.slice(0, compact ? 12 : agents.length).map(
        (a) =>
          `- ${a.name} (${a.id}): ${a.role === "observer" ? "observer (only watches)" : `${a.platform}, ${shortRepo(a.repo)}${a.branch ? `@${a.branch}` : ""}`}, ${a.status}${a.card && !compact ? `, stack: ${a.card.stack}; design system: ${a.card.designSystem.slice(0, 160)}` : ""}${a.focus ? `, focus: ${clip(a.focus, 100)}` : ""}${ws.filter((w) => w.ownerAgentId === a.id).length ? `, owns: ${ws.filter((w) => w.ownerAgentId === a.id).map((w) => w.title).join("; ")}` : ""}`,
      ),
      ...(compact && agents.length > 12 ? [`(${agents.length - 12} more: jam_agents)`] : []),
      ...(compact ? ["(jam_agents has each agent's stack and design system.)"] : []),
    ].join("\n");
  }

  context(agent: Agent, workstream?: string, minutes = 10) {
    const s = this.hub.session;
    const brief = s.store.digest("session")?.text;
    const ws = workstream
      ? s.store.all("workstreams").find((w) => w.title.toLowerCase() === workstream.toLowerCase())
      : s.store.all("workstreams").find((w) => w.ownerAgentId === agent.id && w.status === "active");
    const decisions = s.roomDecisions(agent.id, { limit: 12, workstreamId: ws?.id });
    const room = s.store
      .recentEvents({ kinds: ["speech", "prompt"], since: Date.now() - minutes * 60_000, limit: 80 })
      .filter((e) => e.relevance !== "banter" && e.relevance !== "chatter");
    const fromOthers = s.store.recentEvents({ kinds: ["update", "artifact", "message"], limit: 40 }).filter((e) => e.authorId !== agent.id);
    const isShip = (e: JamEvent) => e.kind === "update" && e.data.updateKind === "shipped";
    const updates = fromOthers.filter((e) => !isShip(e)).slice(-20);
    // Ships are information, not tasks: listed here, one line per agent and branch (earlier ones folded in).
    const shipped = new Map<string, { e: JamEvent; n: number }>();
    for (const e of fromOthers.filter(isShip)) {
      const a = s.agent(e.authorId ?? "");
      const k = `${e.authorId}@${a?.branch ?? ""}`;
      const prev = shipped.get(k);
      shipped.set(k, { e, n: (prev?.n ?? 0) + 1 });
    }
    const shippedLines = [...shipped.values()].slice(-8).map(({ e, n }) => `${fmtEvent(e)}${n > 1 ? ` (+${n - 1} earlier on this branch)` : ""}`);
    const open = s.directives().filter((d) => d.status !== "done" && d.status !== "cancelled").slice(0, 16);
    const mine = open.filter((d) => d.targets.includes(agent.id));
    const others = open.filter((d) => !d.targets.includes(agent.id)).slice(0, 8);
    return [
      `## Session brief\n${brief || "(no brief yet; the session just started)"}`,
      ws ? `## Workstream: ${ws.title}\n${ws.brief || "(no brief yet)"}` : "",
      knowledge(s, ws?.title),
      `## Decisions as said in the room\n${decisions.map(fmtEvent).join("\n") || "(none yet)"}`,
      `## Open directives for you\n${mine.map((d) => fmtDirective(d, s.agent.bind(s))).join("\n") || "(none: check jam_inbox for new ones)"}`,
      `## Other agents' open directives (context only, not yours to do)\n${others.map((d) => fmtDirective(d, s.agent.bind(s))).join("\n") || "(none)"}`,
      `## Room, last ${minutes} min (banter filtered)\n${room.map(fmtEvent).join("\n") || "(quiet)"}`,
      `## Recently shipped by other agents (information, nothing for you to do unless a directive says so)\n${shippedLines.join("\n") || "(nothing yet)"}`,
      `## Other agents, recent\n${updates.map(fmtEvent).join("\n") || "(nothing yet)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  inboxText(agent: Agent, mark = true) {
    const s = this.hub.session;
    const { directives, messages } = s.inbox(agent.id, mark);
    if (!directives.length && !messages.length) {
      const open = s.openFor(agent.id);
      if (!open.length) return "Nothing new.";
      return `Nothing new, but you haven't finished: ${open.map((d) => `${d.id} [${d.mode}] ${d.text.slice(0, 160)}`).join("; ")}. Finish it now (don't wait for others to reply first), then jam_ack it done.`;
    }
    const out: string[] = [];
    for (const d of directives) {
      out.push(
        `DIRECTIVE ${d.id} [${d.mode}] from the room (${d.requestedBy}): ${d.text}${d.rationale ? `\n  why you: ${d.rationale}` : ""}\n  → ${modeHint(d.mode)} Then jam_ack ${d.id} done with what you did.`,
      );
    }
    for (const m of messages) {
      if (m.data.askId) out.push(`QUESTION ${m.data.askId} from ${m.authorName}: ${m.text}\n  → Answer it now with jam_answer (askId ${m.data.askId}), then continue.`);
      else if (m.data.answerTo) out.push(`ANSWER from ${m.authorName} (to your question ${m.data.answerTo}): ${m.text}`);
      else out.push(`MESSAGE from ${m.authorName}: ${m.text}`);
    }
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
      return "Compare with the named agents through jam_message: what each of you has, and what should match. Change code only for a gap you both confirm, then post renders and compare side by side with jam_show parity.";
    case "note":
      return "Write it down where the room said (or a notes file in your repo if it didn't). No code changes beyond that, no canvas, no dev server.";
    case "answer":
      return "This answers your question. Continue with it.";
    case "present":
      return "Put the requested work on the big screen with jam_show.";
  }
}

/** What to do when idle: Claude Code's hooks wake it, Codex has none and keeps waiting. */
const idleHint = (agent: Agent) =>
  agent.harness === "claude-code"
    ? "When you're idle, just stop and tell your person; JamSesh wakes you when the room has something."
    : "When idle, call jam_wait (it returns after a few minutes with nothing: call it again) and don't end your turn while the session is live.";

/** The few rules of working here that can't wait for the full skill. */
const workingRules = (agent: Agent) => [
  "- Claim your workstream (jam_claim) before you start; report with jam_update; check jam_inbox between steps.",
  `- ${idleHint(agent)}`,
  "- Share any dev server you start with jam_devserver, bound to 0.0.0.0, so the room can open it; jam_devserver_remove when you stop it.",
  "- Check mockups against the design system and builds against mockups before you call work done.",
  "- Long write-ups: send the gist, the rest is stored once and others fetch it by id.",
].join("\n");

/** The curated knowledge an agent should work from, its own workstream first. */
function knowledge(s: Hub["session"], workstream?: string) {
  const active = s.facts().filter((f) => f.status === "active");
  if (!active.length) return "";
  const mine = active.filter((f) => workstream && f.workstream.toLowerCase() === workstream.toLowerCase());
  const general = active.filter((f) => !f.workstream);
  const other = active.filter((f) => f.workstream && !mine.includes(f));
  const fmt = (f: (typeof active)[number]) => `- [${f.kind}] ${f.text}${f.by ? ` (${f.by})` : ""}`;
  return [
    "## What the session has settled (curated; follow these)",
    mine.length ? `For ${workstream}:\n${mine.map(fmt).join("\n")}` : "",
    general.length ? `Session-wide:\n${general.map(fmt).join("\n")}` : "",
    other.length ? `Other workstreams:\n${other.slice(0, 15).map((f) => `- [${f.kind}, ${f.workstream}] ${f.text}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One page of a newest-first list (limit, offset), and the line telling the agent how to get the rest. */
function pageOf<T>(all: T[], args: { limit?: unknown; offset?: unknown }, max = 80, def = 30): { shown: T[]; more: string } {
  const limit = Math.min(max, Math.max(1, Math.floor(Number(args.limit)) || def));
  const offset = Math.max(0, Math.floor(Number(args.offset)) || 0);
  const shown = all.slice(offset, offset + limit);
  const left = all.length - offset - shown.length;
  return { shown, more: left > 0 ? `\n\n${all.length} in all; ${left} more: call again with offset ${offset + shown.length}.` : shown.length && offset ? `\n\n(${all.length} in all; that is the last page.)` : "" };
}

export function fmtEvent(e: JamEvent) {
  const t = new Date(e.ts).toTimeString().slice(0, 5);
  const label = e.kind === "speech" ? "said" : e.kind === "prompt" ? "typed" : e.kind;
  return `[${t}] ${e.authorName} ${label}: ${e.text}`;
}

export function clip(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function fmtDirective(d: Directive, agent: (id: string) => Agent | undefined) {
  return `- ${d.id} [${d.mode}, ${d.status}] → ${d.targets.map((t) => agent(t)?.name ?? t).join(", ")}: ${d.text}`;
}

void config;
