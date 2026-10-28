// Wires the session to the brain, audio, canvas, dev servers, MCP and host control.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AudioPipeline } from "./audio/pipeline";
import { Transcriber } from "./audio/transcribe";
import { Brain } from "./brain/brain";
import { Canvas } from "./canvas/canvas";
import { config } from "./config";
import { DevProxy } from "./devproxy";
import { HostControl } from "./hostctl";
import { McpEndpoint } from "./mcp";
import { Session } from "./session";
import { newId, Store } from "./store";
import type { Agent, Artifact, Platform, Utterance } from "./types";

export interface HubOptions {
  canvas?: boolean;
  whisper?: boolean;
  dataDir?: string;
}

export class Hub {
  store: Store;
  session: Session;
  host: HostControl;
  brain: Brain;
  transcriber: Transcriber;
  audio: AudioPipeline;
  canvas: Canvas;
  devproxy: DevProxy;
  mcp: McpEndpoint;
  uploadsDir: string;

  constructor(private opts: HubOptions = {}) {
    const dir = opts.dataDir ?? config.dataDir;
    mkdirSync(dir, { recursive: true });
    this.store = new Store(dir);
    this.session = new Session(this.store);
    this.host = new HostControl(this.session);
    this.brain = new Brain(this.session, this.host);
    this.transcriber = new Transcriber(this.session);
    this.audio = new AudioPipeline(this.session, this.transcriber);
    this.canvas = new Canvas(this.session);
    this.devproxy = new DevProxy(this.session);
    this.mcp = new McpEndpoint(this);
    this.uploadsDir = join(this.canvas.rendersDir, "uploads");
    mkdirSync(this.uploadsDir, { recursive: true });

    this.audio.onLine = (u, isNew) => this.roomLine(u, isNew);
    this.canvas.onRendered = (ids) => this.brain.artifactsLanded(ids.map((id) => this.session.store.get("artifacts", id)!).filter(Boolean));
    this.session.onUpdate = (agent, kind, text) => this.brain.agentUpdated(agent, kind, text);
  }

  async start() {
    const tasks: Promise<unknown>[] = [];
    if (this.opts.whisper !== false) tasks.push(this.transcriber.startLocal().then((ok) => console.log(ok ? "whisper: local whisper.cpp ready" : "whisper: no local model, using the gateway")));
    if (this.opts.canvas !== false) tasks.push(this.canvas.start().then(() => this.mcp.loadCanvasTools()));
    this.devproxy.restore();
    setInterval(() => this.devproxy.refresh(), 30_000);
    await Promise.all(tasks);
  }

  stop() {
    this.brain.stop();
    this.canvas.stop();
    this.transcriber.stop();
    this.devproxy.stop();
  }

  /** A transcribed line from the room (new, or updated after a late copy or a label). */
  private roomLine(u: Utterance, isNew: boolean) {
    const s = this.session;
    if (isNew) {
      const ev = s.store.addEvent({
        kind: "speech",
        authorType: "person",
        authorId: u.personId,
        authorName: u.speakerName,
        text: u.text,
        ts: u.t0,
        data: { utteranceId: u.id, confidence: u.confidence, method: u.method, deviceId: u.deviceId, embedding: this.audio.embeddingFor(u.id) },
      });
      s.store.put("utterances", { ...u, eventId: ev.id });
      this.brain.hear(ev);
      return;
    }
    if (u.eventId) s.store.updateEvent(u.eventId, { text: u.text, authorId: u.personId, authorName: u.speakerName, data: { confidence: u.confidence, method: u.method } });
  }

  /** Typed into the room (the client view's box, or the host's). Treated like speech. */
  typed(personId: string | null, text: string) {
    const p = this.session.person(personId);
    const ev = this.session.store.addEvent({
      kind: "speech",
      authorType: "person",
      authorId: p?.id ?? null,
      authorName: p?.name ?? "Someone",
      text: text.trim(),
      data: { typed: true },
    });
    this.brain.hear(ev);
    return ev;
  }

  async saveUpload(agent: Agent | null, bytes: Uint8Array, meta: { title: string; stage: "built" | "mockup"; note?: string; platform?: Platform }): Promise<Artifact> {
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!isJpeg && !isPng) throw new Error("Upload a PNG or JPEG.");
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Images must be under 12 MB.");
    const file = `${newId("up")}.${isJpeg ? "jpg" : "png"}`;
    await Bun.write(join(this.uploadsDir, file), bytes);
    const size = imageSize(bytes);
    const art = this.session.upsertArtifact({
      kind: "screenshot",
      stage: meta.stage,
      title: meta.title,
      note: meta.note ?? "",
      image: `/renders/uploads/${file}`,
      agentId: agent?.id ?? null,
      platform: meta.platform,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
    this.brain.artifactsLanded([art]);
    return art;
  }

  // ---------- Claude Code hooks ----------

  hookAgent(body: any, ip: string): Agent | undefined {
    const machine = ip === "127.0.0.1" || ip === "::1" ? "host" : ip;
    if (body?.agentId) return this.session.agent(body.agentId);
    if (typeof body?.cwd === "string") return this.session.findAgentByCwd(body.cwd, machine);
    return undefined;
  }

  /** UserPromptSubmit: the prompt goes into context; new room items come back as context. */
  onPrompt(body: any, ip: string) {
    const agent = this.hookAgent(body, ip);
    if (!agent) return {};
    const prompt = String(body.prompt ?? "").trim();
    if (prompt && !prompt.startsWith("/")) {
      const owner = this.session.person(agent.ownerId);
      const ev = this.session.store.addEvent({
        kind: "prompt",
        authorType: "person",
        authorId: owner?.id ?? null,
        authorName: owner?.name ?? agent.ownerName,
        text: prompt.slice(0, 4000),
        relevance: "work",
        data: { agentId: agent.id, agentName: agent.name },
      });
      this.brain.hear(ev);
    }
    this.session.touchAgent(agent.id, { status: "working" });
    const { directives, messages } = this.session.inbox(agent.id, true);
    const lastSeen = this.store.setting<number>(`decisionsSeen:${agent.id}`, 0);
    const decisions = this.store.recentEvents({ kinds: ["decision"], afterId: lastSeen, limit: 10 });
    if (decisions.length) this.store.setSetting(`decisionsSeen:${agent.id}`, decisions[decisions.length - 1].id);
    const lines = [
      ...directives.map((d) => `Room directive ${d.id} [${d.mode}] (${d.requestedBy}): ${d.text}`),
      ...messages.map((m) => `Message from ${m.authorName}: ${m.text}`),
      ...decisions.map((d) => `Room decision: ${d.text}`),
    ];
    if (!lines.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `JamSesh, new since your last turn:\n${lines.join("\n")}\nHandle these alongside your person's prompt; jam_ack directives when you take them.`,
      },
    };
  }

  /** Stop: if the room has work for this agent, keep it going instead of stopping. */
  onStop(body: any, ip: string) {
    const agent = this.hookAgent(body, ip);
    if (!agent) return {};
    const last = typeof body.last_assistant_message === "string" ? body.last_assistant_message.trim() : "";
    if (last) this.session.touchAgent(agent.id, { activity: last.split("\n")[0].slice(0, 140) });
    const { directives, messages } = this.session.inbox(agent.id, true);
    if (!directives.length && !messages.length) {
      this.session.touchAgent(agent.id, { status: "idle" });
      return {};
    }
    const reason = [
      "JamSesh has new work for you:",
      ...directives.map((d) => `- Directive ${d.id} [${d.mode}] from ${d.requestedBy}: ${d.text}`),
      ...messages.map((m) => `- Message from ${m.authorName}: ${m.text}`),
      "jam_ack each directive as you take it, follow the JamSesh skill, and post jam_update when done.",
    ].join("\n");
    this.session.touchAgent(agent.id, { status: "working" });
    return { decision: "block", reason };
  }
}

function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const v = new DataView(b.buffer, b.byteOffset);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xc3) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}
