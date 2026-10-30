// The shared canvas. The hub runs figcraft-server, keeps one host participant in
// the session file, renders frames to PNG as they settle, and gives each agent its
// own headless FigCraft participant on the host (so agents install nothing).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import type { Session } from "../session";
import type { Agent, Platform } from "../types";
import { HelperRegistry, stopHelper, withParentWatch } from "../children";
import { FigcraftMcp, type ToolResult } from "./figcraft-mcp";

interface FrameInfo {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  section: string | null;
  page: string;
  hash: string;
  subtree: Set<string>;
}

interface Tracked {
  hash: string;
  changedAt: number;
  rendered: string | null;
}

interface AgentCanvas {
  mcp: FigcraftMcp;
  ready: Promise<void>;
  lastUsed: number;
  dir: string;
}

const POLL_MS = 2000;
const SETTLE_MS = 2500;

export class Canvas {
  /** Health checks (150 ms apart) a new canvas server gets before it counts as failed to start. */
  static START_TRIES = 40;
  private serverProc: ReturnType<typeof Bun.spawn> | null = null;
  host: FigcraftMcp | null = null;
  private agents = new Map<string, AgentCanvas>();
  private tracked = new Map<string, Tracked>();
  private touched = new Map<string, { agentId: string; at: number }>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private recovering = false;
  private polling = false;
  private serverDir: string;
  rendersDir: string;
  filesDir: string;
  /** Called when new or changed frames have been rendered. */
  onRendered: ((artifactIds: string[]) => void) | null = null;
  /** Pages from the last poll: the brain and the views list them. */
  pageCache: { id: string; name: string; frames: number }[] = [];
  /** Top-level frames from the last poll, plus frames placed since, for finding open space. */
  private occupied: { x: number; y: number; w: number; h: number; at: number; page: string }[] = [];
  private placed: { x: number; y: number; w: number; h: number; at: number; page: string }[] = [];
  /** Which page each agent's participant is on. */
  private agentPage = new Map<string, string>();
  private activity = new Map<string, { created: number; edited: number; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private session: Session,
    /** Every helper this canvas starts goes in here, so stopping the hub finds them all. */
    private helpers: HelperRegistry = new HelperRegistry(),
  ) {
    this.serverDir = join(config.dataDir, "figcraft-server");
    this.rendersDir = join(config.dataDir, "renders");
    this.filesDir = join(config.dataDir, "canvas-files");
    for (const d of [this.serverDir, this.rendersDir, this.filesDir]) mkdirSync(d, { recursive: true });
  }

  /** The canvas server's port: the configured one, or the first free one after it (remembered). */
  port = config.figcraftPort;

  private get serverUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  private async choosePort() {
    const saved = this.session.store.setting<number>("figcraftPort", 0);
    const candidates = [...new Set([saved, config.figcraftPort, ...Array.from({ length: 30 }, (_, i) => config.figcraftPort + 1 + i)])].filter(Boolean);
    for (const p of candidates) {
      if (await healthy(`http://127.0.0.1:${p}`) && p === saved) return p; // our server from before
      if (portFree(p)) return p;
    }
    throw new Error(`no free port for the canvas server near ${config.figcraftPort}`);
  }

  /** Failed starts so far, and the next try (a failed first start is tried again, backing off, a few times). */
  private startFailures = 0;
  private startRetry: ReturnType<typeof setTimeout> | null = null;
  static START_RETRIES = 6;
  static START_RETRY_MS = 5_000;

  async start() {
    this.startRetry = null;
    this.session.setCanvas({ status: "starting", reason: null });
    try {
      // A helper left over from a failed start must be confirmed gone before another is started.
      await this.reapLeftovers();
      this.checkRunning();
      await this.startServer();
      this.checkRunning();
      await this.startHost();
      this.checkRunning();
      this.startFailures = 0;
      this.poller = setInterval(() => this.poll(), POLL_MS);
      this.timers = [setInterval(() => this.reapIdleAgents(), 60_000), setInterval(() => this.watchdog().catch(() => {}), 30_000)];
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!this.stopped) console.error("canvas:", reason);
      // Nothing half-started stays behind: the host participant and the server this start spawned stop.
      // (Each is awaited to its observed exit before its reference is dropped; the registry still holds any that didn't.)
      const leftover = await this.reapLeftovers().then(() => false, () => true);
      if (this.stopped) return; // stopped mid-start: cleaned up, nothing to report or retry
      const stuck = leftover;
      if (stuck) console.warn("canvas: a helper from the failed start is still running; the retry first tries to stop it again");
      this.session.setCanvas({ status: "failed", reason: stuck ? `${reason} (a helper from that start is still running)` : reason });
      if (this.stopped || ++this.startFailures > Canvas.START_RETRIES) return;
      const wait = Math.min(5 * 60_000, Canvas.START_RETRY_MS * 2 ** (this.startFailures - 1));
      this.startRetry = setTimeout(() => void this.start(), wait);
      this.startRetry.unref?.();
    }
  }

  /**
   * Stops the host participant and the server a failed start left behind. A helper whose exit wasn't
   * observed stays referenced (and tracked), so the next start stops it again before spawning another.
   */
  private async reapLeftovers() {
    let stuck = "";
    if (this.host) {
      const gone = await Promise.resolve(this.host.close()).catch(() => false);
      if (gone !== false) this.host = null;
      else stuck = "host";
    }
    if (this.serverProc) {
      if (await stopHelper(this.serverProc).catch(() => false)) this.serverProc = null;
      else stuck ||= "server";
    }
    if (stuck) throw new Error(`the previous canvas ${stuck} process is still running`);
  }

  /** Stop can come while a start is waiting on something: after each wait, a stopped canvas goes no further. */
  private checkRunning() {
    if (this.stopped) throw new Error("the canvas was stopped");
  }

  /** Cancels timers and retries and refuses further starts; no process is touched (see stop). */
  halt() {
    this.stopped = true;
    if (this.startRetry) clearTimeout(this.startRetry);
    if (this.poller) clearInterval(this.poller);
    for (const t of this.timers.splice(0)) clearInterval(t);
  }

  /** Halts, then stops every helper in the registry. True when each one's exit was seen (a TERM-resistant one gets KILL). */
  stop(): Promise<boolean> {
    this.halt();
    return this.helpers.stopAll();
  }

  private async startServer() {
    this.port = await this.choosePort();
    this.checkRunning();
    const saved = this.session.store.setting<{ edit: string; view: string } | null>("canvasLinks", null);
    const before = this.session.store.setting<number>("figcraftPort", 0);
    if (saved && before && before !== this.port) {
      // The file is still in the server's data folder; only the address changed.
      const fix = (l: string) => l.replace(`:${before}&`, `:${this.port}&`);
      this.session.store.setSetting("canvasLinks", { edit: fix(saved.edit), view: fix(saved.view) });
      console.warn(`canvas: port ${before} is taken, using ${this.port}`);
    }
    this.session.store.setSetting("figcraftPort", this.port);
    if (await healthy(this.serverUrl)) return;
    this.checkRunning();
    if (!existsSync(config.figcraftServerBin) && config.figcraftServerBin.includes("/")) {
      throw new Error(`figcraft-server not found at ${config.figcraftServerBin}. Run jamsesh/install.sh.`);
    }
    this.helpers.assertOpen();
    this.serverProc = this.helpers.track(
      Bun.spawn(withParentWatch([config.figcraftServerBin, "--listen", `127.0.0.1:${this.port}`, "--data", this.serverDir]), {
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    // Read all it says while it runs (a full pipe would block it), keeping only the latest part.
    this.serverLog = "";
    void this.drainServerLog(this.serverProc.stderr as ReadableStream<Uint8Array>);
    for (let i = 0; i < Canvas.START_TRIES; i++) {
      if (await healthy(this.serverUrl)) return;
      await Bun.sleep(150);
      this.checkRunning();
    }
    // Stop it, and report the latest of what it said.
    const proc = this.serverProc;
    await Bun.sleep(100);
    const err = this.serverLog.slice(-300);
    if (await stopHelper(proc).catch(() => false)) this.serverProc = null; // else kept: the next start stops it again
    throw new Error(`figcraft-server didn't start${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`);
  }

  /** The latest of what the canvas server wrote to stderr, at most SERVER_LOG_MAX characters. */
  serverLog = "";
  static SERVER_LOG_MAX = 16_384;

  private async drainServerLog(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.serverLog = (this.serverLog + decoder.decode(chunk, { stream: true })).slice(-Canvas.SERVER_LOG_MAX);
      }
    } catch {}
  }

  /** How long `figcraft-server key` may take before the start counts as failed. */
  static KEY_TIMEOUT_MS = 10_000;

  private keyProc: { pid: number; exited: Promise<number>; kill(sig?: number | NodeJS.Signals): void } | null = null;

  private async serverKey(): Promise<string> {
    this.checkRunning();
    this.helpers.assertOpen();
    const p = this.helpers.track(Bun.spawn(withParentWatch([config.figcraftServerBin, "--data", this.serverDir, "key"]), { stdout: "pipe", stderr: "ignore" }));
    this.keyProc = p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), Canvas.KEY_TIMEOUT_MS)));
      const out = await Promise.race([new Response(p.stdout).text(), late]);
      if (out == null) throw new Error("figcraft-server key didn't answer");
      const m = out.match(/key=([\w-]+)/);
      if (!m) throw new Error("couldn't read the figcraft-server key");
      return m[1];
    } finally {
      clearTimeout(timer);
      // Never left running: killed if it's still going, and reaped either way.
      // Every wait is bounded (stopHelper's TERM then KILL grace); a helper whose exit still isn't seen stays in the registry, which reports it at shutdown.
      if (p.exitCode == null && !(await stopHelper(p, 500).catch(() => false))) console.warn("canvas: the key helper's exit wasn't observed");
      if (this.keyProc === p) this.keyProc = null;
    }
  }

  private spawnParticipant(dir: string) {
    mkdirSync(dir, { recursive: true });
    return new FigcraftMcp(config.figcraftBin, ["mcp", "--automation-read-root", dir, "--automation-write-root", dir], {}, this.helpers);
  }

  private async startHost() {
    const host = this.spawnParticipant(join(this.filesDir, "host"));
    this.host = host; // tracked from the moment it exists: a Stop during init closes it
    this.checkRunning();
    await host.init().catch((e) => {
      host.close(); // a process whose start failed doesn't linger
      throw e;
    });
    this.checkRunning();
    await host.command("pref.userName", { name: "JamSesh" });
    this.checkRunning();
    const saved = this.session.store.setting<{ edit: string; view: string } | null>("canvasLinks", null);
    if (saved) {
      // The saved links name the LAN address, but the server listens on loopback only (and the
      // address may have changed since): rejoin through loopback and announce today's address.
      await host.command("collab.join", { link: this.loopLink(saved.edit) });
      const ok = await waitLive(host, 15_000);
      this.checkRunning();
      if (ok) {
        const links = { edit: this.lanLink(this.loopLink(saved.edit)), view: this.lanLink(this.loopLink(saved.view)) };
        this.session.store.setSetting("canvasLinks", links);
        return this.announce(links.edit, links.view);
      }
      console.warn("canvas: saved file is gone, publishing a new one");
      await host.command("collab.leave", {}).catch(() => {});
    }
    const key = await this.serverKey();
    this.checkRunning();
    await host.command("collab.publish", { server: `ws://127.0.0.1:${this.port}/?key=${key}`, name: this.session.settings().sessionName });
    for (let i = 0; i < 80; i++) {
      const peers = await host.command("collab.peers");
      this.checkRunning();
      if (peers?.published?.edit) {
        const links = { edit: this.lanLink(peers.published.edit), view: this.lanLink(peers.published.view) };
        this.session.store.setSetting("canvasLinks", links);
        return this.announce(links.edit, links.view);
      }
      if (peers?.status === "failed") throw new Error(peers.reason ?? "publishing failed");
      await Bun.sleep(200);
    }
    throw new Error("publishing the session file timed out");
  }

  /** Links from a server on 127.0.0.1 name this machine's LAN address instead, so clients can use them. */
  private lanLink(link: string) {
    return link.replace(/host=(127\.0\.0\.1|localhost)(:\d+)/, `host=${config.publicHost}$2`);
  }

  /** The same link through loopback on the server's current port, the way the host reaches it. */
  loopLink(link: string) {
    return link.replace(/host=[^&:]+:\d+/, `host=127.0.0.1:${this.port}`);
  }

  private announce(edit: string, view: string) {
    this.session.setCanvas({ status: "live", editLink: edit, viewLink: view, wsEdit: toWs(edit), wsView: toWs(view), reason: null, generation: this.session.canvas.generation + 1 });
  }

  /** The link the host's own pages use (localhost works without the LAN). */
  localWs(kind: "edit" | "view") {
    const ws = kind === "edit" ? this.session.canvas.wsEdit : this.session.canvas.wsView;
    return ws?.replace(config.publicHost, "127.0.0.1") ?? null;
  }

  // ---------- watching frames ----------

  private async poll() {
    if (this.polling || !this.host?.alive) return;
    this.polling = true;
    try {
      const doc = await this.host.json("inspect_document", { depth: 64, allPages: true });
      const frames = collectFrames(doc);
      const now = Date.now();
      this.pageCache = (doc?.pages ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? ""), frames: (p.children ?? []).length }));
      this.occupied = frames.filter((f) => !f.section).map((f) => ({ x: f.x, y: f.y, w: f.width, h: f.height, at: now, page: f.page }));
      this.placed = this.placed.filter((r) => now - r.at < 15_000);
      const seen = new Set<string>();
      const ready: FrameInfo[] = [];
      for (const f of frames) {
        seen.add(f.id);
        const t = this.tracked.get(f.id);
        if (!t) {
          // Already rendered before a restart: don't bump it back to the top of the board.
          const prev = this.session.artifacts().find((a) => a.kind === "frame" && a.nodeId === f.id);
          const same = prev?.image?.includes(`${f.id}-${f.hash.slice(0, 10)}`);
          this.tracked.set(f.id, { hash: f.hash, changedAt: now, rendered: same ? f.hash : null });
        }
        else if (t.hash !== f.hash) ((t.hash = f.hash), (t.changedAt = now));
        const cur = this.tracked.get(f.id)!;
        if (cur.rendered !== cur.hash && now - cur.changedAt >= SETTLE_MS) ready.push(f);
      }
      for (const id of [...this.tracked.keys()]) {
        if (!seen.has(id)) {
          this.tracked.delete(id);
          const art = this.session.artifacts().find((a) => a.kind === "frame" && a.nodeId === id);
          if (art) this.session.store.remove("artifacts", art.id);
        }
      }
      const changed: string[] = [];
      for (const f of ready.slice(0, 6)) {
        const id = await this.render(f);
        if (id) changed.push(id);
      }
      if (changed.length) this.onRendered?.(changed);
    } catch (e) {
      console.error("canvas poll:", e instanceof Error ? e.message : e);
    } finally {
      this.polling = false;
    }
  }

  private async render(f: FrameInfo): Promise<string | null> {
    const t = this.tracked.get(f.id)!;
    const r = await this.host!.call("screenshot", { ids: [Number(f.id)], maxSize: 1600 });
    const img = r.content.find((c) => c.type === "image") as { data: string } | undefined;
    if (!img) return null;
    const file = `${f.id}-${t.hash.slice(0, 10)}.png`;
    await Bun.write(join(this.rendersDir, file), Buffer.from(img.data, "base64"));
    t.rendered = t.hash;
    const agentId = this.attribute(f);
    const agent = this.session.agent(agentId);
    const existing = this.session.artifacts().find((a) => a.kind === "frame" && a.nodeId === f.id);
    const title = f.section && !f.name.includes(" / ") ? `${f.section} / ${f.name}` : f.name;
    const art = this.session.upsertArtifact({
      id: existing?.id,
      kind: "frame",
      stage: "mockup",
      title,
      nodeId: f.id,
      image: `/renders/${file}`,
      width: f.width,
      height: f.height,
      agentId: agentId ?? existing?.agentId ?? null,
      platform: guessPlatform(f, agent),
      page: f.page,
    });
    return art.id;
  }

  private attribute(f: FrameInfo): string | null {
    let best: { agentId: string; at: number } | null = null;
    for (const id of f.subtree) {
      const t = this.touched.get(id);
      if (t && (!best || t.at > best.at)) best = t;
    }
    return best?.agentId ?? null;
  }

  /** The current render of one frame (for agents comparing against their build). */
  async renderNode(nodeId: string, maxSize = 1600, scale?: number): Promise<ToolResult> {
    if (!this.host) throw new Error("canvas isn't running");
    const shot = () => this.host!.call("screenshot", { ids: [Number(nodeId)], maxSize, ...(scale ? { scale } : {}) });
    let r = await shot();
    if (!r.isError) return r;
    // The host may be a moment behind the agent that just made the frame.
    await Bun.sleep(700);
    await this.host.command("collab.peers").catch(() => {});
    r = await shot();
    if (!r.isError || !this.touched.has(nodeId)) return r;
    await this.resync("a frame an agent made was missing");
    return shot();
  }

  /** The newest frame drawn small, for the project's thumbnail; null when there is no canvas or nothing on it. */
  async thumbnail(maxSize = 480): Promise<Uint8Array | null> {
    if (!this.host) return null;
    const art = this.session
      .artifacts()
      .filter((a) => a.kind === "frame" && a.nodeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!art?.nodeId) return null;
    const r = await this.host.call("screenshot", { ids: [Number(art.nodeId)], maxSize });
    const img = r.content.find((c) => c.type === "image") as { data: string } | undefined;
    return img && !r.isError ? new Uint8Array(Buffer.from(img.data, "base64")) : null;
  }

  async frames() {
    if (!this.host) return [];
    let doc = await this.host.json("inspect_document", { depth: 64, allPages: true });
    let frames = collectFrames(doc);
    const known = new Set(frames.flatMap((f) => [...f.subtree]));
    const recent = [...this.touched].filter(([, t]) => Date.now() - t.at < 60_000).map(([id]) => id);
    if (recent.some((id) => !known.has(id))) {
      await Bun.sleep(700);
      doc = await this.host.json("inspect_document", { depth: 64, allPages: true });
      frames = collectFrames(doc);
    }
    return frames.map((f) => ({
      id: f.id,
      name: f.name,
      section: f.section,
      width: f.width,
      height: f.height,
      by: this.session.agent(this.attribute(f))?.name ?? null,
    }));
  }

  // ---------- agents on the canvas ----------

  async forAgent(agent: Agent): Promise<FigcraftMcp> {
    if (this.stopped) throw new Error("The canvas was stopped.");
    const link = this.session.canvas.editLink;
    if (!link) throw new Error(`The canvas isn't live yet (${this.session.canvas.status}${this.session.canvas.reason ? `: ${this.session.canvas.reason}` : ""}).`);
    let a = this.agents.get(agent.id);
    if (a && !a.mcp.alive) (this.agents.delete(agent.id), (a = undefined));
    if (!a) {
      const dir = join(this.filesDir, agent.id);
      const mcp = this.spawnParticipant(dir);
      const ready = (async () => {
        this.session.touchAgent(agent.id, { canvas: "joining" });
        await mcp.init();
        await mcp.command("pref.userName", { name: agent.name });
        await mcp.command("collab.join", { link: this.localLink(link) });
        if (!(await waitLive(mcp, 20_000))) {
          this.session.touchAgent(agent.id, { canvas: "failed" });
          throw new Error("Couldn't join the canvas session.");
        }
        this.session.touchAgent(agent.id, { canvas: "live" });
        const ws = this.session.store.all("workstreams").find((w) => w.ownerAgentId === agent.id && w.status === "active");
        if (ws) await this.focusAgentPage(agent.id, ws.title).catch(() => {});
      })();
      a = { mcp, ready, lastUsed: Date.now(), dir };
      this.agents.set(agent.id, a);
      ready.catch(() => {
        // Don't leave the headless participant running once it can't be reached through the map.
        mcp.close();
        if (this.agents.get(agent.id)?.mcp === mcp) this.agents.delete(agent.id);
      });
    }
    await a.ready;
    a.lastUsed = Date.now();
    return a.mcp;
  }

  agentDir(agentId: string) {
    const dir = join(this.filesDir, agentId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private localLink(link: string) {
    return link.replace(`host=${config.publicHost}`, "host=127.0.0.1");
  }

  /** Forwards a FigCraft tool call for an agent and remembers which nodes it touched. */
  async call(agent: Agent, tool: string, args: any): Promise<ToolResult> {
    const blocked = forbiddenCommand(tool, args);
    if (blocked) return { content: [{ type: "text", text: `${blocked} is a file or collaboration command, and the shared file belongs to the room. Agents work in the file through nodes, styles and variables; ask a person to open, save or share files.` }], isError: true };
    const mcp = await this.forAgent(agent);
    args = this.place(tool, args ?? {}, this.agentPage.get(agent.id));
    const result = await mcp.call(tool, args, 120_000);
    const ids = new Set<string>();
    collectIds(args, ids);
    for (const c of result.content) if (c.type === "text") collectIdsFromText(c.text, ids);
    const now = Date.now();
    for (const id of ids) this.touched.set(id, { agentId: agent.id, at: now });
    this.noteActivity(agent, tool, args);
    return result;
  }

  /**
   * Agents often drop new frames at (0, 0) on top of others' work. New top-level frames
   * (alone, or a batch of them, which keep their spacing) move right of the existing work.
   */
  place(tool: string, args: any, page?: string): any {
    const isTop = (p: any) => p && !p.parent && /^(frame|section|component)$/i.test(String(p.type ?? ""));
    let targets: any[] = [];
    const creates = (c: any) => (c?.command === "node.create" && isTop(c.params)) || (c?.command === "frame.create" && c.params && !c.params.parent);
    if (tool === "create_node" && isTop(args)) targets = [args];
    else if (tool === "run_command" && creates(args)) targets = [args.params];
    else if (tool === "batch" && Array.isArray(args.commands)) targets = args.commands.filter(creates).map((c: any) => c.params);
    if (!targets.length) return args;
    const rect = (p: any) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0), w: Number(p.width ?? (p.preset ? 390 : 100)), h: Number(p.height ?? (p.preset ? 844 : 100)) });
    const rects = targets.map(rect);
    const onPage = (r: { page: string }) => !page || r.page === page;
    const taken = [...this.occupied, ...this.placed].filter(onPage);
    const hit = (r: { x: number; y: number; w: number; h: number }) => taken.some((t) => r.x < t.x + t.w + 40 && r.x + r.w + 40 > t.x && r.y < t.y + t.h + 40 && r.y + r.h + 40 > t.y);
    if (rects.some(hit)) {
      const minX = Math.min(...rects.map((r) => r.x));
      const right = Math.max(...taken.map((t) => t.x + t.w));
      const dx = right + 120 - minX;
      for (const p of targets) p.x = Number(p.x ?? 0) + dx;
    }
    for (const p of targets) this.placed.push({ ...rect(p), at: Date.now(), page: page ?? "" });
    return args;
  }

  private noteActivity(agent: Agent, tool: string, args: any) {
    const kinds: Record<string, "created" | "edited"> = { create_node: "created", set_properties: "edited", batch: "edited", run_command: "edited" };
    const k = kinds[tool];
    if (!k) return;
    let a = this.activity.get(agent.id);
    if (!a) ((a = { created: 0, edited: 0, timer: null }), this.activity.set(agent.id, a));
    if (tool === "batch" && Array.isArray(args?.commands)) {
      const made = args.commands.filter((s: any) => /^(node|frame|component)\.create/.test(String(s?.command ?? ""))).length;
      a.created += made;
      a.edited += args.commands.length - made;
    } else if (tool === "run_command" && /^(node|frame|component)\.create/.test(String(args?.command ?? ""))) a.created++;
    else a[k]++;
    this.session.touchAgent(agent.id, { status: "working", activity: "Designing on the canvas" });
    if (!a.timer) {
      a.timer = setTimeout(() => {
        const cur = this.activity.get(agent.id)!;
        this.activity.delete(agent.id);
        const parts = [cur.created && `${cur.created} new layer${cur.created > 1 ? "s" : ""}`, cur.edited && `${cur.edited} edit${cur.edited > 1 ? "s" : ""}`].filter(Boolean);
        if (parts.length) {
          this.session.store.addEvent({ kind: "canvas", authorType: "agent", authorId: agent.id, authorName: agent.name, text: `Canvas: ${parts.join(", ")}.`, relevance: "work" });
        }
      }, 12_000);
    }
  }

  private async pagesOf(mcp: FigcraftMcp): Promise<{ id: number; name: string; children: number; current: boolean }[]> {
    const r = await mcp.command("page.list");
    return Array.isArray(r) ? r : [];
  }

  /**
   * One page per workstream. The first workstream takes over the untouched starter
   * page instead of leaving an empty "Page 1" behind.
   */
  async ensurePage(name: string): Promise<void> {
    if (!this.host?.alive || !name.trim()) return;
    const pages = await this.pagesOf(this.host);
    if (pages.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
    const starter = pages.length === 1 && /^page \d+$/i.test(pages[0].name) && pages[0].children === 0 ? pages[0] : null;
    if (starter) await this.host.command("page.rename", { id: starter.id, name });
    else await this.host.command("page.add", { name });
  }

  /** An agent took a new name: its cursor on the canvas follows. */
  async renameAgent(agentId: string, name: string) {
    const a = this.agents.get(agentId);
    if (!a) return;
    await a.ready.catch(() => {});
    await a.mcp.command("pref.userName", { name }).catch(() => {});
  }

  /** Puts an agent's participant on its workstream's page, so its new frames land there. */
  async focusAgentPage(agentId: string, name: string) {
    const a = this.agents.get(agentId);
    if (!a?.mcp.alive || !name) return;
    await this.ensurePage(name);
    for (let i = 0; i < 10; i++) {
      const page = (await this.pagesOf(a.mcp)).find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (page) {
        await a.mcp.command("page.select", { id: page.id });
        this.agentPage.set(agentId, page.name);
        return;
      }
      await Bun.sleep(300); // the new page is still syncing to this participant
    }
  }

  /** Writes a copy of the live session file (as .figcraft) to `dest`. */
  async saveCopy(dest: string): Promise<boolean> {
    if (!this.host?.alive) return false;
    const tmp = join(this.filesDir, "host", `snapshot-${Date.now()}.figcraft`);
    const r = await this.host.call("save_file", { path: tmp }, 120_000);
    if (r.isError || !existsSync(tmp)) throw new Error((r.content[0] as any)?.text ?? "save failed");
    renameSync(tmp, dest);
    return true;
  }

  /** A pin on the canvas becomes a FigCraft comment, so agents see it in the file too. */
  async comment(a: import("../types").Annotation) {
    if (!this.host || a.target.canvasX == null || a.target.canvasY == null) return;
    await this.host.command("comment.add", { x: a.target.canvasX, y: a.target.canvasY, text: `${a.text || "📍"}`, anchor: a.target.nodeId ? Number(a.target.nodeId) : true, author: a.authorName });
  }

  /** Leaves and rejoins the session file, for when the host's copy fell behind. */
  async resync(why: string) {
    const link = this.session.canvas.editLink;
    if (!this.host || !link) return;
    await this.recover(async () => {
      console.warn(`canvas: resyncing the host (${why})`);
      await this.host!.command("collab.leave", {}).catch(() => {});
      await this.host!.command("collab.join", { link: this.localLink(link) });
      if (!(await waitLive(this.host!, 20_000))) throw new Error("The host lost the canvas session; restart JamSesh.");
      this.backLive();
    });
  }

  /** The host is in the session again: a canvas marked failed is live again, under a new generation so people's canvases rejoin. */
  private backLive() {
    const { status, editLink, viewLink } = this.session.canvas;
    if (status !== "live" && editLink && viewLink) this.announce(editLink, viewLink);
  }

  /**
   * One recovery at a time. One that fails marks the canvas failed (people's canvases stop rejoining
   * a dead link and say why); the watchdog tries again on its next round.
   */
  private async recover(fn: () => Promise<void>) {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      await fn();
    } catch (e) {
      if (this.stopped) return;
      const reason = e instanceof Error ? e.message : String(e);
      console.error("canvas:", reason);
      this.session.setCanvas({ status: "failed", reason });
    } finally {
      this.recovering = false;
    }
  }

  /** The canvas server stopped (it crashed, or something killed it): start it again on the same
   * data, rejoin the session file, and announce it again so people's canvases rejoin too. */
  private revive() {
    return this.recover(async () => {
      console.warn("canvas: the canvas server stopped; starting it again");
      // Wait for the old server to let go of its port, so the new one comes up on the same links.
      if (this.serverProc) {
        if (!(await stopHelper(this.serverProc).catch(() => false))) throw new Error("The old canvas server is still running; not starting a second one.");
        this.serverProc = null;
      }
      await this.startServer();
      const saved = this.session.store.setting<{ edit: string; view: string } | null>("canvasLinks", null);
      if (!this.host || !saved) throw new Error("The canvas server restarted but there is no session file to rejoin; restart JamSesh.");
      await this.host.command("collab.leave", {}).catch(() => {});
      await this.host.command("collab.join", { link: this.loopLink(saved.edit) });
      if (!(await waitLive(this.host, 15_000))) throw new Error("The canvas server restarted but the session file didn't come back; restart JamSesh.");
      this.announce(this.lanLink(this.loopLink(saved.edit)), this.lanLink(this.loopLink(saved.view)));
    });
  }

  /** The host should see every agent participant the hub runs; if it doesn't, it lost the session. */
  private async watchdog() {
    if (this.stopped || this.recovering || !this.host || this.polling) return;
    if (!this.host.alive) return this.restartHost();
    // Live, or failed by an earlier recovery: a server that doesn't answer is started again.
    const up = this.session.canvas.status === "live" || this.session.canvas.status === "failed";
    if (up && !(await healthy(this.serverUrl)) && !(await healthy(this.serverUrl))) return this.revive();
    const ready = [...this.agents.values()].filter((a) => a.mcp.alive);
    const peers = await this.host.command("collab.peers").catch(() => null);
    if (!peers) return;
    if (peers.status === "live" && this.session.canvas.status === "failed" && (await healthy(this.serverUrl))) this.backLive();
    if (peers.status !== "live" || (ready.length && (peers.peers?.length ?? 0) < ready.length)) await this.resync(`status ${peers.status}, ${peers.peers?.length ?? 0} peers for ${ready.length} agents`);
  }

  /** The host's own canvas process died: start a new one and rejoin the session file, or say the canvas failed. */
  private restartHost() {
    return this.recover(async () => {
      console.warn("canvas: the host's canvas process stopped; starting it again");
      // The dead one stays until a new one starts, so a failed restart is tried again next round.
      this.host?.close();
      try {
        await this.startHost();
      } catch (e) {
        throw new Error(`The host's canvas stopped and didn't come back: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  private reapIdleAgents() {
    for (const [id, a] of this.agents) {
      if (Date.now() - a.lastUsed > 45 * 60_000) {
        a.mcp.close();
        this.agents.delete(id);
        this.session.touchAgent(id, { canvas: "none" });
      }
    }
  }
}

// ---------- helpers ----------

/** True when nothing listens on the port on any interface (a test bind can succeed despite one). */
function portFree(port: number) {
  const r = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return r.stdout.toString().trim() === "";
}

async function healthy(url: string) {
  try {
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(600) })).ok;
  } catch {
    return false;
  }
}

async function waitLive(mcp: FigcraftMcp, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = await mcp.command("collab.peers").catch(() => null);
    if (p?.status === "live") return true;
    if (p?.status === "failed") return false;
    await Bun.sleep(200);
  }
  return false;
}

export function toWs(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/host=([^&]+)&file=([^&]+)&token=([^&]+)/);
  if (m) return `ws://${m[1]}/?file=${m[2]}&token=${m[3]}`;
  const s = link.match(/server=([^&]+)&file=([^&]+)&token=([^&]+)/);
  if (s) return `${decodeURIComponent(s[1]).replace(/\/?$/, "/")}?file=${s[2]}&token=${s[3]}`;
  return link.startsWith("ws") ? link : null;
}

/** Top-level frames (and frames directly inside sections), with a hash of each subtree. */
export function collectFrames(doc: any): FrameInfo[] {
  const out: FrameInfo[] = [];
  let pageName = "";
  const visit = (n: any, section: string | null) => {
    const type = String(n.type ?? "").toUpperCase();
    if (type === "SECTION") {
      for (const c of n.children ?? []) visit(c, n.name ?? null);
      return;
    }
    if (!["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(type)) return;
    const subtree = new Set<string>();
    const walk = (x: any) => {
      subtree.add(String(x.id));
      for (const c of x.children ?? []) walk(c);
    };
    walk(n);
    out.push({
      id: String(n.id),
      name: n.name ?? "Frame",
      type,
      x: Math.round(n.absoluteBounds?.x ?? n.x ?? 0),
      y: Math.round(n.absoluteBounds?.y ?? n.y ?? 0),
      width: Math.round(n.width ?? n.absoluteBounds?.width ?? 0),
      height: Math.round(n.height ?? n.absoluteBounds?.height ?? 0),
      section,
      page: pageName,
      hash: createHash("sha1").update(JSON.stringify(n)).digest("hex"),
      subtree,
    });
  };
  for (const page of doc?.pages ?? []) {
    pageName = page.name ?? "";
    for (const c of page.children ?? []) visit(c, null);
  }
  return out;
}

function collectIds(v: any, out: Set<string>, key = "") {
  if (v == null) return;
  if (Array.isArray(v)) return v.forEach((x) => collectIds(x, out, key));
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v)) collectIds(x, out, k);
    return;
  }
  if ((key === "id" || key === "ids" || key === "parent" || key === "node") && (typeof v === "number" || /^\d+$/.test(String(v)))) out.add(String(v));
}

function collectIdsFromText(text: string, out: Set<string>) {
  for (const m of text.matchAll(/"(?:id|parent)"\s*:\s*(\d+)/g)) out.add(m[1]);
}

function guessPlatform(f: FrameInfo, agent: Agent | undefined): Platform | null {
  const n = `${f.name} ${f.section ?? ""}`.toLowerCase();
  if (/\b(mobile|ios|android|iphone|phone)\b/.test(n) || (f.width > 0 && f.width <= 500 && f.height > f.width)) return "mobile";
  if (/\b(desktop|web|mac|windows)\b/.test(n) || f.width >= 1000) return "desktop";
  return agent?.platform ?? null;
}

/** Agents don't open, save or share the room's file: the name of the file or collab command in a call, if any. */
export function forbiddenCommand(tool: string, args: any): string | null {
  const bad = (c: unknown) => (typeof c === "string" && /^(file|collab)\./.test(c.trim()) ? c.trim() : null);
  if (tool === "run_command") return bad(args?.command);
  if (tool === "batch" && Array.isArray(args?.commands)) for (const c of args.commands) { const b = bad(c?.command); if (b) return b; }
  return null;
}
