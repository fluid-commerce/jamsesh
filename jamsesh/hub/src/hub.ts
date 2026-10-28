// Wires the session to the brain, audio, canvas, dev servers, MCP and host control.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AudioPipeline } from "./audio/pipeline";
import { Transcriber } from "./audio/transcribe";
import { embed } from "./audio/voiceprint";
import { decodeWav, resample, speechLevelDb } from "./audio/wav";
import { Brain } from "./brain/brain";
import { Canvas } from "./canvas/canvas";
import { config } from "./config";
import { DevProxy } from "./devproxy";
import { HostControl } from "./hostctl";
import { McpEndpoint } from "./mcp";
import { Autosave } from "./autosave";
import { Auth } from "./auth";
import { KeepAwake } from "./awake";
import { Network } from "./net";
import { Session } from "./session";
import { newId, Store } from "./store";
import type { Agent, Annotation, Artifact, Platform, Utterance } from "./types";

/** One distilled pointer moment from a recorded prompt (after CursorCap's dwell/click model). */
export interface PointerMark {
  t: number;
  kind: "dwell" | "click" | "drag" | "move";
  x: number;
  y: number;
  dur?: number;
  target: Annotation["target"];
  word?: string;
}

function where(x: number, y: number) {
  const v = y < 0.33 ? "top" : y > 0.66 ? "bottom" : "middle";
  const h = x < 0.33 ? "left" : x > 0.66 ? "right" : "center";
  return v === "middle" && h === "center" ? "the center" : `${v} ${h}`;
}

/** Ties each pointer moment to the word being said at that time (words spread evenly over a line). */
export function describePointer(marks: PointerMark[], lines: Utterance[]): string[] {
  return marks
    .filter((m) => m.kind !== "move")
    .map((m) => {
      const u = lines.find((l) => m.t >= l.t0 - 300 && m.t <= l.t1 + 300);
      if (u) {
        const words = u.text.split(/\s+/);
        const i = Math.max(0, Math.min(words.length - 1, Math.floor(((m.t - u.t0) / Math.max(1, u.t1 - u.t0)) * words.length)));
        m.word = words.slice(Math.max(0, i - 2), i + 3).join(" ");
      }
      const what = `${m.target.kind} "${m.target.label}"${m.target.nodeId ? ` (node ${m.target.nodeId})` : ""}`;
      const action = m.kind === "click" ? "clicked" : m.kind === "drag" ? "dragged across" : `held on${m.dur ? ` for ${(m.dur / 1000).toFixed(1)}s` : ""}`;
      return `${action} ${what} at ${where(m.x, m.y)}${m.word ? ` while saying “…${m.word}…”` : ""}`;
    });
}

export interface HubOptions {
  canvas?: boolean;
  whisper?: boolean;
  dataDir?: string;
  /** Defaults to <dataDir>/team when dataDir is given (tests), else ~/.jamsesh/team. */
  teamDir?: string;
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
  autosave: Autosave;
  auth: Auth;
  awake: KeepAwake;
  /** Reachability from anywhere (DuckDNS, certificates, router); team-level, so it survives sessions. */
  net: Network;
  /** Open WebSocket connections from people's devices (not the host's own screen). */
  peopleOnline = 0;
  uploadsDir: string;

  constructor(private opts: HubOptions = {}) {
    const dir = opts.dataDir ?? config.dataDir;
    mkdirSync(dir, { recursive: true });
    const teamDir = opts.teamDir ?? (opts.dataDir ? join(opts.dataDir, "team") : config.teamDir);
    mkdirSync(teamDir, { recursive: true });
    this.store = new Store(dir);
    this.store.team = new Store(teamDir, "team.db");
    this.auth = new Auth(this.store);
    this.net = new Network(teamDir);
    // Awake while anyone's window is open or an agent was active in the last ten minutes.
    this.awake = new KeepAwake(() => this.peopleOnline + this.session.agents().filter((a) => a.status !== "offline" && Date.now() - a.lastSeen < 10 * 60_000).length);
    this.session = new Session(this.store);
    this.host = new HostControl(this.session);
    this.brain = new Brain(this.session, this.host);
    this.transcriber = new Transcriber(this.session);
    this.audio = new AudioPipeline(this.session, this.transcriber);
    this.canvas = new Canvas(this.session);
    this.devproxy = new DevProxy(this.session);
    this.mcp = new McpEndpoint(this);
    this.session.extraAddresses = () => {
      const st = this.net.status();
      return st.enabled && st.publicUrl && st.cert.state === "ok" ? [{ label: "Anywhere", url: st.publicUrl }] : [];
    };

    this.autosave = new Autosave(this, dir);
    this.brain.autosave = this.autosave;
    this.brain.pages = () => this.canvas.pageCache;
    this.uploadsDir = join(this.canvas.rendersDir, "uploads");
    mkdirSync(this.uploadsDir, { recursive: true });

    this.audio.onLine = (u, isNew) => this.roomLine(u, isNew);
    this.canvas.onRendered = (ids) => this.brain.artifactsLanded(ids.map((id) => this.session.store.get("artifacts", id)!).filter(Boolean));
    this.session.onUpdate = (agent, kind, text) => this.brain.agentUpdated(agent, kind, text);
    this.session.onClaim = (agentId, title) => void this.canvas.focusAgentPage(agentId, title).catch(() => {});
    this.brain.relabel = (eventId, name) => {
      const ev = this.store.event(eventId);
      const person = this.session.personByName(name) ?? this.session.upsertPerson({ name });
      if (!ev?.data.utteranceId) return "That line wasn't spoken, so there's no voice to learn.";
      this.audio.assign(ev.data.utteranceId, person.id);
      return `Line ${eventId} is now ${person.name}'s.`;
    };
  }

  async start() {
    const tasks: Promise<unknown>[] = [this.net.start().catch((e) => console.error("net:", e))];
    if (this.opts.whisper !== false) tasks.push(this.transcriber.startLocal().then((ok) => console.log(ok ? "whisper: local whisper.cpp ready" : "whisper: no local model, using the gateway")));
    if (this.opts.canvas !== false) tasks.push(this.canvas.start().then(() => this.mcp.loadCanvasTools()));
    this.devproxy.restore();
    this.autosave.start();
    setInterval(() => this.devproxy.refresh(), 30_000);
    await Promise.all(tasks);
  }

  /** Stops, saving a final snapshot first when there is a canvas to save. */
  async shutdown() {
    await Promise.race([this.autosave.save("end of session", { onlyIfChanged: true }).catch(() => null), Bun.sleep(8000)]);
    await Promise.race([this.net.stop().catch(() => null), Bun.sleep(3000)]);
    this.stop();
  }

  stop() {
    this.awake.stop();
    this.autosave.stop();
    this.brain.stop();
    this.canvas.stop();
    this.transcriber.stop();
    this.devproxy.stop();
  }

  /** Devices recording a prompt for the brain right now, with when they started. */
  private promptMode = new Map<string, number>();

  promptStart(deviceId: string, t0: number) {
    this.promptMode.set(deviceId, t0);
  }

  private inPrompt(u: Utterance) {
    for (const [deviceId, t0] of this.promptMode) if (u.t1 >= t0 - 500 && u.devices.some((d) => d.deviceId === deviceId)) return true;
    return false;
  }

  /** A transcribed line from the room (new, or updated after a late copy or a label). */
  private roomLine(u: Utterance, isNew: boolean) {
    const s = this.session;
    if (isNew && this.inPrompt(u)) {
      // Part of a recorded prompt: the prompt goes to the brain whole when recording stops.
      const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: u.personId, authorName: u.speakerName, text: u.text, ts: u.t0, relevance: "work", data: { utteranceId: u.id, confidence: u.confidence, method: u.method, deviceId: u.deviceId, forBrain: true } });
      s.store.put("utterances", { ...u, eventId: ev.id });
      return;
    }
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

  /** Typed into the room (the client view's box, or the host's). Treated like speech; direct goes straight to the brain. */
  typed(personId: string | null, text: string, direct = false) {
    const p = this.session.person(personId);
    const ev = this.session.store.addEvent({
      kind: "speech",
      authorType: "person",
      authorId: p?.id ?? null,
      authorName: p?.name ?? "Someone",
      text: text.trim(),
      relevance: direct ? "work" : null,
      data: { typed: true, direct },
    });
    if (direct) this.brain.direct(ev);
    else this.brain.hear(ev);
    return ev;
  }

  /**
   * Record-to-prompt finished: everything this device heard in the window, plus where
   * the person pointed while talking, goes to the brain as one prompt.
   */
  async promptWindow(w: { deviceId: string; personId: string | null; t0: number; t1: number; pointer: PointerMark[]; typed?: string }) {
    const s = this.session;
    // Wait for the window's last words to come back from transcription.
    const deadline = Date.now() + 7000;
    let lines: Utterance[] = [];
    let stable = 0;
    while (Date.now() < deadline) {
      const now = s.store.all("utterances").filter((u) => u.t1 >= w.t0 - 500 && u.t0 <= w.t1 + 300 && u.devices.some((d) => d.deviceId === w.deviceId));
      stable = now.length === lines.length && Date.now() > w.t1 + 2500 ? stable + 1 : 0;
      lines = now;
      if (stable >= 2) break;
      await Bun.sleep(400);
    }
    this.promptMode.delete(w.deviceId);
    lines.sort((a, b) => a.t0 - b.t0);
    const person = s.person(w.personId) ?? s.person(lines[0]?.personId);
    const said = [w.typed?.trim(), ...lines.map((u) => u.text)].filter(Boolean).join(" ");
    const marks = describePointer(w.pointer, lines);
    if (!said && !marks.length) return { ok: false, reason: "Nothing was heard in that recording." };
    const pointed = w.pointer
      .filter((m) => m.kind !== "move")
      .map((m) => s.addAnnotation({ personId: person?.id ?? null, target: m.target, x: m.x, y: m.y, text: m.word ? `“${m.word}”` : "pointed here", source: "pointer" }));
    const ev = s.store.addEvent({
      kind: "speech",
      authorType: "person",
      authorId: person?.id ?? null,
      authorName: person?.name ?? "Someone",
      text: said || "(pointed without speaking)",
      relevance: "work",
      data: { direct: true, recorded: true, pointer: marks },
    });
    // Pointer marks already went out with this prompt; keep them visible, but don't send them again.
    for (const a of pointed) s.store.patch("annotations", a.id, { status: "sent", promptEventId: ev.id });
    this.brain.direct(ev, marks.length ? `While talking, ${person?.name ?? "they"} pointed at:\n${marks.map((m) => `- ${m}`).join("\n")}` : "");
    return { ok: true, eventId: ev.id, text: said, pointed: marks };
  }

  /** All open annotations (or the given ones) go to the brain as one prompt. */
  sendAnnotations(personId: string | null, ids?: string[], note = "") {
    const s = this.session;
    const open = s.annotations().filter((a) => a.status === "open" && (!ids?.length || ids.includes(a.id)));
    if (!open.length) return null;
    const p = s.person(personId);
    const lines = open.map((a, i) => `${i + 1}. ${a.authorName} on ${a.target.kind} "${a.target.label}"${a.target.nodeId ? ` (node ${a.target.nodeId})` : ""} at ${where(a.x, a.y)}: ${a.text || "(no note)"}`);
    const ev = s.store.addEvent({
      kind: "speech",
      authorType: "person",
      authorId: p?.id ?? null,
      authorName: p?.name ?? "Someone",
      text: `${note ? `${note}\n` : ""}Annotations from the room (${open.length}):\n${lines.join("\n")}`,
      relevance: "work",
      data: { direct: true, annotations: open.map((a) => a.id) },
    });
    for (const a of open) s.store.patch("annotations", a.id, { status: "sent", promptEventId: ev.id });
    this.brain.direct(ev, "These are pins people dropped on the canvas, builds and screens. Group them by what they're about and send each group to the agent that owns that work (one directive per agent), quoting each note with where it was placed.");
    return ev;
  }

  /** A deliberate voice sample: split into a few chunks so the voiceprint starts with variety. */
  enrollVoice(personId: string, bytes: Uint8Array) {
    const p = this.session.person(personId);
    if (!p) throw new Error("No such person.");
    const pcm = resample(decodeWav(bytes), 16000);
    const { levelDb, noiseDb } = speechLevelDb(pcm);
    if (levelDb - noiseDb < 8 || levelDb < -50) return { ok: false, reason: "That was too quiet. Hold the laptop closer and try again." };
    const chunk = 16000 * 3;
    let added = 0;
    for (let i = 0; i + chunk / 2 <= pcm.samples.length; i += chunk) {
      const e = embed({ sampleRate: 16000, samples: pcm.samples.subarray(i, Math.min(pcm.samples.length, i + chunk)) });
      if (e) (this.audio.voiceprints.add(personId, e), added++);
    }
    this.session.store.put("people", this.session.person(personId)!);
    return added ? { ok: true, samples: this.audio.voiceprints.count(personId) } : { ok: false, reason: "Couldn't hear enough speech. Try reading the whole sentence." };
  }

  async savePhoto(personId: string, bytes: Uint8Array) {
    const p = this.session.person(personId);
    if (!p) throw new Error("No such person.");
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!isJpeg && !isPng) throw new Error("Send a JPEG or PNG.");
    const file = `${personId}-${Date.now()}.${isJpeg ? "jpg" : "png"}`;
    await Bun.write(join(this.uploadsDir, file), bytes);
    return this.session.setPhoto(personId, `/renders/uploads/${file}`);
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
      ...messages.map((m) => (m.data.askId ? `QUESTION ${m.data.askId} from ${m.authorName}: ${m.text} (answer with jam_answer first)` : `Message from ${m.authorName}: ${m.text}`)),
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
      ...messages.map((m) => (m.data.askId ? `- QUESTION ${m.data.askId} from ${m.authorName}: ${m.text} (answer it with jam_answer before anything else)` : `- Message from ${m.authorName}: ${m.text}`)),
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
