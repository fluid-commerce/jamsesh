// Wires the session to the brain, audio, canvas, dev servers, MCP and host control.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AudioPipeline } from "./audio/pipeline";
import { Transcriber } from "./audio/transcribe";
import { embed, learningNote, voiceprintStatus } from "./audio/voiceprint";
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
import type { Agent, Annotation, Artifact, BuildRequest, Platform, Utterance } from "./types";
import { speak } from "./brain/speech";
import { bus } from "./bus";

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

const HARNESS_TEXT = /^\s*<(task-notification|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|system-reminder)>/;

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
    this.session.buildRequests = () => this.host.buildRequests();
    this.host.onRequest = (r) => this.onBuildRequest(r);
    // Simulator and host screenshots become artifacts the room and the brain can see.
    this.host.onImage = (path, title) => {
      void Bun.file(path)
        .bytes()
        .then((bytes) => this.saveUpload(null, bytes, { title, stage: "built", note: "Captured on the host" }))
        .catch((e) => console.warn(`[host] couldn't keep the screenshot: ${e?.message ?? e}`));
    };
    // A finished preview build lands in the feed for the room and the brain's context, but isn't
    // room speech: running it through hear() would let the rules router turn it into a directive.
    this.host.onBuilt = (label, ok, text) => {
      this.session.store.addEvent({ kind: "system", authorType: "system", authorId: null, authorName: "JamSesh", text: ok ? `Preview build finished: ${label}. ${text}`.trim() : `Preview build failed: ${label}. ${text}`.trim() });
    };
    this.brain = new Brain(this.session, this.host);
    this.transcriber = new Transcriber(this.session);
    this.audio = new AudioPipeline(this.session, this.transcriber);
    this.canvas = new Canvas(this.session);
    // A person's rename carries to their agents' default names, and so to their cursors.
    this.session.onAgentRenamed = (a) => void this.canvas.renameAgent(a.id, a.name);
    this.devproxy = new DevProxy(this.session);
    this.mcp = new McpEndpoint(this);
    // A disconnected device's agents stop hearing the room now, not when their open wait ends: every
    // wait of an agent on that machine wakes and checks its credential before handing anything over.
    this.offRevoked = bus.on((m) => {
      const id = (m as any).type === "revoked" ? ((m as any).deviceId as string | undefined) : undefined;
      if (!id) return;
      const machine = this.auth.machineOf(id);
      for (const a of this.session.agents())
        if (a.machine === machine || a.machine === id) {
          this.session.wake(a.id);
          this.session.cancelAsks(a.id);
        }
    });
    this.session.extraAddresses = () => {
      const st = this.net.status();
      return st.enabled && st.publicUrl && st.cert.state === "ok" ? [{ label: "Anywhere", url: st.publicUrl, reachable: st.reachable }] : [];
    };

    this.autosave = new Autosave(this, dir);
    this.brain.autosave = this.autosave;
    this.brain.pages = () => this.canvas.pageCache;
    this.uploadsDir = join(this.canvas.rendersDir, "uploads");
    mkdirSync(this.uploadsDir, { recursive: true });

    this.audio.onLine = (u, isNew) => this.roomLine(u, isNew);
    this.session.voiceprints = () => ({ ...voiceprintStatus(), enrolled: this.audio.voiceprints.enrolled });
    this.canvas.onRendered = (ids) => this.brain.artifactsLanded(ids.map((id) => this.session.store.get("artifacts", id)!).filter(Boolean));
    this.session.onUpdate = (agent, kind, text, ev) => this.brain.agentUpdated(agent, kind, text, ev.data);
    this.session.onBrainMessage = (ev) => this.brain.agentMessage(ev);
    this.session.onClaim = (agentId, title) => void this.canvas.focusAgentPage(agentId, title).catch(() => {});
    this.brain.relabel = (eventId, name) => {
      const ev = this.store.event(eventId);
      const person = this.session.personByName(name) ?? this.session.upsertPerson({ name });
      if (!ev?.data.utteranceId) return "That line wasn't spoken, so there's no voice to learn.";
      const { learning } = this.audio.assign(ev.data.utteranceId, person.id);
      return `Line ${eventId} is now ${person.name}'s. ${learningNote(person.name, learning)}`;
    };
  }

  async start() {
    const tasks: Promise<unknown>[] = [this.net.start().catch((e) => console.error("net:", e))];
    if (this.opts.whisper !== false) tasks.push(this.transcriber.startLocal().then((ok) => console.log(ok ? "whisper: local whisper.cpp ready" : "whisper: no local model, using the gateway")));
    if (this.opts.canvas !== false) tasks.push(this.canvas.start().then(() => this.mcp.loadCanvasTools()));
    this.devproxy.restore();
    this.autosave.start();
    setInterval(() => this.devproxy.refresh(), 30_000);
    setInterval(() => this.session.tick(), 60_000).unref?.();
    await Promise.all(tasks);
    // Without an engine the room is deaf and nothing says so; say so on the first screen.
    if (this.opts.whisper !== false) {
      const problem = this.transcriber.problem();
      if (problem) this.transcriber.warn(problem);
    }
  }

  /** Stops, saving a final snapshot first when there is a canvas to save. */
  async shutdown() {
    await Promise.race([this.autosave.save("end of session", { onlyIfChanged: true }).catch(() => null), Bun.sleep(8000)]);
    await Promise.race([this.net.stop().catch(() => null), Bun.sleep(3000)]);
    this.stop();
  }

  private offRevoked: () => void;

  stop() {
    this.offRevoked();
    this.awake.stop();
    this.autosave.stop();
    this.brain.stop();
    this.canvas.stop();
    this.transcriber.stop();
    this.devproxy.stop();
    for (const w of this.promptMode.values()) clearTimeout(w.timer);
  }

  /** Devices recording a prompt for the brain right now, with when they started. */
  /** Recording laptops: when they started, and (once Stop is pressed) when they stopped. */
  private promptMode = new Map<string, { t0: number; t1?: number; timer?: ReturnType<typeof setTimeout> }>();
  /** A prompt window stays open this long at most (SPEC 11.3). */
  static PROMPT_MAX_MS = 2 * 60_000;

  promptStart(deviceId: string, t0: number) {
    // A new recording on a laptop whose last one never got its Stop: that one's held words go to the room.
    this.releasePrompt(deviceId);
    const w: { t0: number; t1?: number; timer?: ReturnType<typeof setTimeout> } = { t0 };
    // The window ends on its own (SPEC 11.3) if Stop never arrives; nothing said in it is lost.
    w.timer = setTimeout(() => this.releasePrompt(deviceId, w), Hub.PROMPT_MAX_MS + 1000);
    w.timer.unref?.();
    this.promptMode.set(deviceId, w);
  }

  /** Closes a window that never got Stop and hands what it held back to the room as ordinary speech. */
  private releasePrompt(deviceId: string, only?: { t0: number; t1?: number }) {
    const w = this.promptMode.get(deviceId);
    if (!w || (only && w !== only) || w.t1 !== undefined) return;
    clearTimeout(w.timer);
    this.promptMode.delete(deviceId);
    for (const u of this.session.store.all("utterances")) {
      if (u.eventId || u.t1 < w.t0 - 500 || u.t0 > w.t0 + Hub.PROMPT_MAX_MS || !this.fromRecorder(u, deviceId)) continue;
      this.roomLine(u, true);
    }
  }

  /**
   * Whether this line is the person recording's own. Every laptop in the room hears
   * everyone, so hearing it on the recording device is not enough: it must be their voice,
   * or (when the voice is unknown) loudest at their laptop. Everyone else keeps flowing
   * through normal triage while the window is open.
   */
  private fromRecorder(u: Utterance, deviceId: string, personId?: string | null) {
    if (!u.devices.some((d) => d.deviceId === deviceId)) return false;
    const owner = personId ?? this.session.store.get("devices", deviceId)?.personId ?? null;
    if (owner && u.personId === owner) return true;
    const loudest = [...u.devices].sort((a, b) => b.level - a.level)[0];
    if (loudest?.deviceId !== deviceId) return false;
    return !u.personId || !owner || u.personId === owner;
  }

  private inPrompt(u: Utterance) {
    // Inside the recording only: once Stop is pressed, or past the window's cap, what the person says is ordinary speech.
    for (const [deviceId, w] of this.promptMode) if (u.t1 >= w.t0 - 500 && u.t0 <= w.t0 + Hub.PROMPT_MAX_MS && (w.t1 === undefined || u.t0 <= w.t1 + 300) && this.fromRecorder(u, deviceId)) return true;
    return false;
  }

  /** A transcribed line from the room (new, or updated after a late copy or a label). */
  private roomLine(u: Utterance, isNew: boolean) {
    const s = this.session;
    // The recorder's own words belong to the prompt (promptWindow reads them from the store);
    // a feed line as well would show them twice.
    if (isNew && this.inPrompt(u)) return;
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
    if (!u.eventId) return;
    // A recorded prompt's text is the whole window's; a single line's update must not replace it,
    // but a relabel still changes who said it.
    if (s.store.event(u.eventId)?.data.recorded) {
      s.store.updateEvent(u.eventId, { authorId: u.personId, authorName: u.speakerName, data: { confidence: u.confidence, method: u.method } });
      return;
    }
    s.store.updateEvent(u.eventId, { text: u.text, authorId: u.personId, authorName: u.speakerName, data: { confidence: u.confidence, method: u.method } });
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
    // Lines still settling or being transcribed from this laptop count: the last sentence is
    // usually the one that is, because Stop lands right after it was said.
    // Stop was pressed: the window ends here, even while its last words are still being transcribed.
    const open = this.promptMode.get(w.deviceId);
    if (open) open.t1 = w.t1;
    // SPEC 11.3: answer within about 7 s, before the client gives up waiting.
    // Words still in transcription after that reach the feed as ordinary room speech (the window is closed by then).
    const deadline = Date.now() + 7000;
    const heard = () => s.store.all("utterances").filter((u) => u.t1 >= w.t0 - 500 && u.t0 <= w.t1 + 300 && u.t0 <= w.t0 + Hub.PROMPT_MAX_MS && this.fromRecorder(u, w.deviceId, w.personId));
    let lines: Utterance[] = [];
    let stable = 0;
    while (Date.now() < deadline) {
      const now = heard();
      stable = now.length === lines.length && Date.now() > w.t1 + 1500 && this.audio.pendingFor(w.deviceId) === 0 ? stable + 1 : 0;
      lines = now;
      if (stable >= 2) break;
      await Bun.sleep(400);
    }
    // Only this window's entry: a new recording may have started while this one waited.
    if (open && this.promptMode.get(w.deviceId) === open) {
      clearTimeout(open.timer);
      this.promptMode.delete(w.deviceId);
    }
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
      // The recording laptop gets the chime for its own prompt.
      data: { direct: true, recorded: true, saidAt: w.t1, pointer: marks, deviceId: w.deviceId, ...(lines.length === 1 ? { utteranceId: lines[0].id, embedding: this.audio.embeddingFor(lines[0].id) } : {}) },
    });
    // One spoken line: it can be relabelled from the prompt, like any line in the feed.
    if (lines.length === 1) s.store.put("utterances", { ...lines[0], eventId: ev.id });
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
      // Sent with a button, so the answer comes back as text, not a chime and a spoken reply.
      data: { direct: true, typed: true, annotations: open.map((a) => a.id) },
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

  // ---------- host build requests (approved by people, by voice or a button) ----------

  private onBuildRequest(r: BuildRequest) {
    const s = this.session;
    const what = `${r.repo.replace(/\.git$/, "").split(/[/:]/).pop()}${r.branch ? ` (${r.branch})` : ""}`;
    if (r.status === "pending") {
      const shell = r.kind === "shell";
      s.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: shell ? `${r.agentName} asks to run a command on the host: ${r.command}. Say "approve" or "deny".` : `${r.agentName} asks to build ${what} on the host: ${r.command}. Say "approve" or "deny".`, relevance: "work", data: { buildRequest: r.id } });
      // Said out loud: often nobody is at the host to click anything. A long command is on screen, not read out.
      const ask = shell
        ? `${r.agentName} wants to run ${r.command.length <= 40 ? `"${r.command}"` : "a command"} on the host. Approve or deny?`
        : `${r.agentName} wants to build ${what} on the host. Approve or deny?`;
      void speak(s, ask, { source: "voice", kind: "request" });
      // Once more after a minute if nobody answered (people may have been mid-conversation).
      setTimeout(() => r.status === "pending" && void speak(s, `Still waiting: ${ask}`, { source: "voice", kind: "request" }), 60_000).unref?.();
    } else {
      const outcome = r.status === "approved" ? `approved by ${r.decidedBy}; it's building on the host now and opens when it's done` : r.status === "denied" ? `denied by ${r.decidedBy}` : "not answered in 10 minutes, so it expired";
      if (r.status !== "approved") bus.send({ type: "toast", tone: "info", text: r.status === "denied" ? `Denied ${r.agentName}'s build` : `${r.agentName}'s build request expired`, detail: r.decidedBy ? `By ${r.decidedBy}` : undefined });
      s.store.addEvent({ kind: "message", authorType: "system", authorName: "JamSesh", text: `Your host build request for ${what} was ${outcome}.`, relevance: "work", data: { to: r.agentId, toName: r.agentName, buildRequest: r.id } });
      s.wake(r.agentId);
    }
    bus.changed("buildRequests");
  }

  // ---------- Claude Code hooks ----------

  /**
   * The agent a hook is for: the chat that joined, found by Claude Code's session id. A chat that never
   * called jam_join (another chat in the same folder included) is nobody here, and its hooks do nothing.
   */
  hookAgent(body: any, _ip: string, machine?: string | null): Agent | undefined {
    const chat = typeof body?.session_id === "string" ? body.session_id : "";
    // The machine is the hook's credential's (see the hook routes in http.ts): a chat that joined from
    // one Mac is nobody to a hook from another, whatever session id it names.
    if (!chat || !machine) return undefined;
    return this.session.agents().find((a) => a.chatId === chat && a.harness === "claude-code" && a.machine === machine);
  }

  /**
   * Whether this chat has joined (a hook asks before it sends anything), and, if it isn't in the room,
   * whether the room removed it from this machine (the hook then tells its person who can let it back in).
   * Asking changes nothing: only a person's Allow again clears a removal.
   */
  chatJoined(body: any, machine?: string | null): { joined: boolean; removed?: boolean } {
    if (this.hookAgent(body, "", machine)) return { joined: true };
    const chat = typeof body?.session_id === "string" ? body.session_id : "";
    const removed = !!chat && !!machine && this.session.removedChats().some((r) => r.chatId === chat && r.machine === machine && r.harness === "claude-code");
    return removed ? { joined: false, removed: true } : { joined: false };
  }

  /** UserPromptSubmit: the prompt goes into context; new room items come back as context. */
  onPrompt(body: any, ip: string, device?: string | null) {
    // The harness's own injected text (subagent reports, command output), which older hook scripts still forward.
    if (HARNESS_TEXT.test(String(body?.prompt ?? ""))) return {};
    const agent = this.hookAgent(body, ip, device);
    if (!agent) return {};
    this.ackDeliveries(agent.id, body.jamAcks);
    const prompt = String(body.prompt ?? "").trim();
    // The same prompt again (its answer was lost and the outbox replayed it) is recorded once.
    const again = this.promptSeen(body.jamPromptId);
    if (prompt && !prompt.startsWith("/") && !again) {
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
    this.cancelListen(agent.id); // the person is talking to it: it hears the room through this turn's hooks
    this.hookSeen.set(agent.id, Date.now());
    const first = prompt.split("\n")[0].slice(0, 100);
    this.session.touchAgent(agent.id, { status: "working", ...(first && !prompt.startsWith("/") ? { activity: `Working on: ${first}` } : {}) });
    return this.pendingContext(agent, "UserPromptSubmit", "Handle these alongside your person's prompt; jam_ack directives when you take them.");
  }

  /**
   * How long a prompt id is remembered: longer than hook.sh keeps a queued prompt (ten minutes), so a
   * replay of a prompt the room already has is always recognised, however many prompts came between.
   */
  static PROMPT_ID_MS = 20 * 60_000;

  /** Whether a prompt with this id (from hook.sh) has reached the room already; remembers it if not. */
  private promptSeen(id: unknown, now = Date.now()) {
    if (typeof id !== "string" || !id) return false;
    const fresh = this.store.setting<{ id: string; at: number }[]>("promptIdsSeen", []).filter((p) => now - p.at < Hub.PROMPT_ID_MS);
    const seen = fresh.some((p) => p.id === id);
    this.store.setSetting("promptIdsSeen", seen ? fresh : [...fresh, { id, at: now }]);
    return seen;
  }

  /**
   * What the room has for an agent that it hasn't acknowledged yet, as hook context, with the
   * delivery id (`jamDelivery`, sent as a header) the hook script records once it has passed the
   * context on. See offer().
   */
  private pendingContext(agent: Agent, event: "UserPromptSubmit" | "PostToolUse", closing: string) {
    const o = this.offer(agent);
    if (!o) return {};
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `JamSesh, new since your last turn:\n${o.lines.join("\n")}\n${closing}` }, jamDelivery: o.id };
  }

  /** How long a hook's handover waits for its acknowledgement before its items are offered again. */
  static DELIVERY_RETRY_MS = 60_000;

  private deliveries(agentId: string) {
    return this.store.setting<Delivery[]>(`deliveries:${agentId}`, []);
  }

  /**
   * Delivery is at least once. A hook's response can be lost (a timeout, a dropped connection), so
   * what a hook or the listener hands over only counts as delivered when the hook script sends its
   * delivery id back on the chat's next hook call (ackDeliveries). Until then nothing more is handed
   * over; after DELIVERY_RETRY_MS (or at once for `retry`: a listener whose last answer never came
   * back) everything still unacknowledged is offered again, under a new id. jam_inbox and jam_wait
   * answer the agent directly and mark what they return. Acknowledged items are never offered again.
   */
  private offer(agent: Agent, { via = "hook", retry = false, withDecisions = true }: { via?: Delivery["via"]; retry?: boolean; withDecisions?: boolean } = {}): { id: string; lines: string[] } | null {
    if (!this.session.agent(agent.id)) return null; // removed from the room
    const now = Date.now();
    const list = this.deliveries(agent.id).filter((d) => now - d.at < 30 * 60_000);
    const open = list[list.length - 1];
    if (open && now - open.at < Hub.DELIVERY_RETRY_MS && !(retry && open.via === "listen")) return null;
    const { directives, messages } = this.session.inbox(agent.id, false);
    const pending = directives.filter((d) => (d.progress?.[agent.id] ?? d.status) === "pending");
    const lastSeen = this.store.setting<number>(`decisionsSeen:${agent.id}`, 0);
    const decisions = withDecisions ? this.session.roomDecisions(agent.id, { afterId: lastSeen, limit: 10 }) : [];
    // With no decision for this agent, everything newer than its mark was for other workstreams: the mark moves on now.
    if (withDecisions && !decisions.length) {
      const newest = this.store.recentEvents({ kinds: ["decision"], limit: 1 })[0]?.id;
      if (newest && newest > lastSeen) this.store.setSetting(`decisionsSeen:${agent.id}`, newest);
    }
    if (!pending.length && !messages.length && !decisions.length) {
      if (list.length) this.store.setSetting(`deliveries:${agent.id}`, []);
      return null;
    }
    const d: Delivery = { id: newId("dl"), at: now, via, directives: pending.map((x) => x.id), msgUpTo: messages[messages.length - 1]?.id ?? 0, decisionUpTo: decisions[decisions.length - 1]?.id ?? 0 };
    this.store.setSetting(`deliveries:${agent.id}`, [...list, d].slice(-8));
    return {
      id: d.id,
      lines: [
        ...pending.map((x) => `Room directive ${x.id} [${x.mode}] (${x.requestedBy}): ${x.text}`),
        ...messages.map((m) => (m.data.askId ? `QUESTION ${m.data.askId} from ${m.authorName}: ${m.text} (answer with jam_answer first)` : `Message from ${m.authorName}: ${m.text}`)),
        ...decisions.map((x) => `Room decision: ${x.text}`),
      ],
    };
  }

  /** The delivery ids a hook script hands back: only now do those items count as delivered (late ones too). */
  ackDeliveries(agentId: string, ids: unknown) {
    if (!Array.isArray(ids) || !ids.length) return;
    const list = this.deliveries(agentId);
    const acked = list.filter((d) => ids.includes(d.id));
    if (!acked.length) return;
    for (const d of acked) {
      for (const id of d.directives) {
        const dir = this.store.get("directives", id);
        // Only what's still waiting: a directive the agent already acked or finished stays as it is.
        if (!dir || (dir.progress?.[agentId] ?? dir.status) !== "pending") continue;
        this.session.setDirectiveFor(id, agentId, "delivered");
        this.session.setDirective(id, { deliveredAt: dir.deliveredAt ?? Date.now() });
      }
      if (d.msgUpTo > this.store.setting<number>(`msgRead:${agentId}`, 0)) this.store.setSetting(`msgRead:${agentId}`, d.msgUpTo);
      if (d.decisionUpTo > this.store.setting<number>(`decisionsSeen:${agentId}`, 0)) this.store.setSetting(`decisionsSeen:${agentId}`, d.decisionUpTo);
    }
    this.store.setSetting(`deliveries:${agentId}`, list.filter((d) => !acked.includes(d)));
  }

  /** An agent whose machine has the newer hooks (PostToolUse, the listener) is woken by the listener; others still need the old "wait here" nudge at Stop. */
  private newHooks(agentId: string) {
    return this.store.setting<boolean>(`newHooks:${agentId}`, false);
  }

  private markNewHooks(agentId: string) {
    if (!this.newHooks(agentId)) this.store.setSetting(`newHooks:${agentId}`, true);
  }

  /** The last time a hook of each agent's reached us: tells a hooked Claude Code from a Codex that has none. */
  private hookSeen = new Map<string, number>();
  private listening = new Map<string, number>();

  /** Whether this agent's tool calls pass through our hooks (so a "you have mail" nudge in tool results would repeat them). */
  hooked(agentId: string) {
    return Date.now() - (this.hookSeen.get(agentId) ?? 0) < 5 * 60_000;
  }

  /**
   * PostToolUse: between two steps of a busy agent, new room items come back as context so it folds
   * them into the work it's doing. The agent's own inbox/wait calls already carry their items.
   */
  onTool(body: any, ip: string, device?: string | null) {
    const agent = this.hookAgent(body, ip, device);
    if (!agent) return {};
    this.ackDeliveries(agent.id, body.jamAcks);
    this.hookSeen.set(agent.id, Date.now());
    this.markNewHooks(agent.id);
    const done = typeof agent.activity === "string" && agent.activity.startsWith("Done:");
    // JamSesh's own tools (the jam_update that just said "Done", "blocked" or asked a question) aren't
    // new work, so what they reported stays; any other tool is the agent working again.
    const own = /(^|__)jam_\w+$/.test(String(body?.tool_name ?? ""));
    if (own && (done || agent.status === "blocked")) this.session.touchAgent(agent.id, {});
    else if (agent.status !== "working" || done) this.session.touchAgent(agent.id, { status: "working", ...(done ? { activity: "Working" } : {}) });
    else this.session.touchAgent(agent.id);
    if (/jam_(inbox|wait|ask)$/.test(String(body?.tool_name ?? ""))) return {};
    return this.pendingContext(agent, "PostToolUse", "Fold these into your current work; jam_ack directives when you take them, and answer questions with jam_answer.");
  }

  /**
   * An idle Claude Code agent has gone back to its person. Its Stop hook starts this call in the
   * background (asyncRewake): it holds until the room has something for the agent, then returns the
   * text that wakes it. A new prompt or a newer listen ends it empty; so does the time limit (the
   * server drops idle connections after about four minutes, so the hook script calls again). With
   * the delivery id of what it hands over (the hook route sends it as a header).
   */
  async listen(body: any, ip: string, device?: string | null, maxMs = 200_000, credentialLive: () => boolean = () => true): Promise<{ text: string; delivery: string | null }> {
    const none = { text: "", delivery: null };
    const agent = this.hookAgent(body, ip, device);
    if (!agent) return none;
    this.ackDeliveries(agent.id, body.jamAcks);
    // A listener that comes back without acknowledging the last one's answer never got it.
    let retry = true;
    this.hookSeen.set(agent.id, Date.now());
    this.markNewHooks(agent.id);
    const mine = (this.listening.get(agent.id) ?? 0) + 1;
    this.listening.set(agent.id, mine);
    this.session.wake(agent.id); // a listener this one replaces ends now
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      await this.session.wait(agent.id, Math.min(30_000, until - Date.now()));
      // Removed from the room, or its device disconnected, while it waited: it hears nothing more.
      if (!this.session.agent(agent.id) || !credentialLive()) {
        if (this.listening.get(agent.id) === mine) this.listening.delete(agent.id);
        return none;
      }
      if (this.listening.get(agent.id) !== mine) return none; // replaced, or its person started talking to it
      // In jam_wait (or jam_ask) the agent is already listening itself: it gets the items there.
      if (this.session.agent(agent.id)?.status === "waiting") {
        await Bun.sleep(1000);
        continue;
      }
      if (!this.session.hasInbox(agent.id)) continue;
      const o = this.offer(agent, { via: "listen", retry });
      retry = false;
      if (!o) {
        // Handed over a moment ago and not acknowledged yet: offered again once that times out.
        await Bun.sleep(1000);
        continue;
      }
      this.session.touchAgent(agent.id, { status: "working", activity: "Picking up work from the room" });
      return { text: `JamSesh has something for you from the room:\n${o.lines.join("\n")}\njam_ack directives as you take them, follow the JamSesh skill, and post a jam_update when done.`, delivery: o.id };
    }
    if (this.listening.get(agent.id) === mine) this.listening.delete(agent.id);
    return none;
  }

  private cancelListen(agentId: string) {
    if (!this.listening.has(agentId)) return;
    this.listening.set(agentId, (this.listening.get(agentId) ?? 0) + 1);
    this.session.wake(agentId);
  }

  /** Stop: if the room has work for this agent, keep it going instead of stopping. */
  onStop(body: any, ip: string, device?: string | null) {
    const agent = this.hookAgent(body, ip, device);
    if (!agent) return {};
    this.ackDeliveries(agent.id, body.jamAcks);
    this.hookSeen.set(agent.id, Date.now());
    const last = typeof body.last_assistant_message === "string" ? body.last_assistant_message.trim() : "";
    // An agent that reported it's blocked or asked the room a question stays that way when its turn
    // ends: it isn't done, and it isn't idle. Otherwise a finished turn reads "Done: ..." until the next task.
    const blocked = agent.status === "blocked";
    if (last && !blocked && !agent.activity.startsWith("Done:")) this.session.touchAgent(agent.id, { activity: `Done: ${last.split("\n")[0]}`.slice(0, 140) });
    // Decisions are news, not work: they wait for the next turn rather than keeping the agent going.
    const o = this.offer(agent, { withDecisions: false });
    if (!o) {
      // Idle: the agent goes back to its person. The listener hook (see listen) wakes it when the room has something.
      this.session.touchAgent(agent.id, blocked ? {} : { status: "idle" });
      // An install from before the listener existed can't be woken: keep it waiting in jam_wait, once per stop.
      if (!this.newHooks(agent.id) && !body.stop_hook_active && agent.harness === "claude-code" && agent.status !== "offline")
        return { decision: "block", reason: "You're in a JamSesh session: call jam_wait to wait for the room's next directive. If your person is typing to you, stop and help them instead." };
      return {};
    }
    const reason = ["JamSesh has new work for you:", ...o.lines.map((l) => `- ${l}`), "jam_ack each directive as you take it, follow the JamSesh skill, and post jam_update when done."].join("\n");
    this.session.touchAgent(agent.id, { status: "working" });
    return { decision: "block", reason, jamDelivery: o.id };
  }
}

/** One handover by a hook or the listener, waiting for the hook script to acknowledge it (Hub.offer). */
type Delivery = { id: string; at: number; via: "hook" | "listen"; directives: string[]; msgUpTo: number; decisionUpTo: number };

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
