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
import { ProjectKeeper } from "./projectkeeper";
import { Attachments, type AttachmentRef } from "./attachments";
import { readProjectContext, seedFromProject } from "./carryover";
import { projectsDir } from "./projects";
import { WikiService } from "./wiki/service";
import { Auth } from "./auth";
import { KeepAwake } from "./awake";
import { Network } from "./net";
import { Session } from "./session";
import { newId, Store } from "./store";
import type { Agent, Annotation, Artifact, BuildRequest, Platform, ShowRequest, Utterance } from "./types";
import { showRequestSpeech, speak } from "./brain/speech";
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
  /** The project wiki's folder; by default the project's own, or one inside the data directory. */
  wikiDir?: string;
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
  /** Records the project this session belongs to (people, last used, thumbnail); idle without a project. */
  keeper: ProjectKeeper;
  /** Images and files added to messages (SPEC 12.6). */
  attachments: Attachments;
  wiki: WikiService;
  auth: Auth;
  awake: KeepAwake;
  /** Reachability from anywhere (DuckDNS, certificates, router); team-level, so it survives sessions. */
  net: Network;
  /** Open WebSocket connections from people's devices (not the host's own screen). */
  peopleOnline = 0;
  /** The hub is saving its last state: nothing new is taken in (http.ts answers 503), so nothing arrives after the wiki's final capture. */
  closing = false;
  /** Work under way that may still add to the room: requests being answered, speech being transcribed, the brain's pass. Shutdown waits for it. */
  private inflight = new Set<Promise<void>>();
  /** How long shutdown waits for work in flight before sealing the store; anything later is refused. */
  static SHUTDOWN_WAIT_MS = 10_000;
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
    this.session.onShowRequest = (r) => this.onShowRequest(r);
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
    this.audio.track = (work) => this.track(work);
    this.canvas = new Canvas(this.session);
    // A person's rename carries to their agents' default names, and so to their cursors.
    this.session.onAgentRenamed = (a) => void this.canvas.renameAgent(a.id, a.name);
    this.devproxy = new DevProxy(this.session);
    this.mcp = new McpEndpoint(this);
    this.session.extraAddresses = () => {
      const st = this.net.status();
      return st.enabled && st.publicUrl && st.cert.state === "ok" ? [{ label: "Anywhere", url: st.publicUrl, reachable: st.reachable }] : [];
    };

    this.autosave = new Autosave(this, dir);
    this.brain.autosave = this.autosave;
    this.keeper = new ProjectKeeper(this, opts.dataDir ? undefined : config.home, opts.dataDir ? null : config.project);
    this.brain.pages = () => this.canvas.pageCache;
    this.attachments = new Attachments(join(dir, "attachments"));
    this.brain.attachments = this.attachments;
    // A new session of a project starts from what the last one settled (SPEC 12.7).
    if (!opts.dataDir && config.project) seedFromProject(config.home, config.project.slug, config.project.sessionId, this.session);
    // The project's wiki (SPEC 12.8): the fact list lives on as pages. The first session of a project folds its facts in.
    const wikiDir = opts.wikiDir ?? (!opts.dataDir && config.project ? join(projectsDir(config.home), config.project.slug) : join(dir, "project-wiki"));
    const projectWiki = !opts.dataDir && config.project && !opts.wikiDir;
    try {
      this.wiki = new WikiService(this.session, wikiDir, this.session.sessionId, !opts.dataDir ? (config.project?.slug ?? "") : "", projectWiki ? projectsDir(config.home) : undefined);
    } catch (e) {
      // A project folder that is a link: the wiki lives in this session's own folder instead, and nothing is written through the link.
      console.error("wiki:", e instanceof Error ? e.message : e);
      this.wiki = new WikiService(this.session, join(dir, "project-wiki"), this.session.sessionId, "");
    }
    this.wiki.attachmentBytes = (id) => {
      const rec = this.attachments.record(id);
      const bytes = rec ? this.attachments.bytes(id) : null;
      return rec && bytes ? { name: rec.name, type: rec.kind, bytes } : null;
    };
    this.session.wikiAccept = (c, pages, by) => this.wiki.accept(c, pages, by);
    this.session.wikiClosed = (c) => this.wiki.closed(c);
    this.session.wikiDismiss = (c, by) => this.wiki.dismissing(c, by);
    this.session.onFactSaved = (f) => void this.wiki.factSaved(f);
    try {
      // Raises the project's open proposals on this session's board, and closes any whose accept finished.
      this.wiki.restore();
    } catch (e) {
      console.error("wiki restore:", e instanceof Error ? e.message : e);
    }
    this.brain.curateInDigest = false;
    try {
      this.wiki.migrate(!opts.dataDir && config.project ? readProjectContext(config.home, config.project.slug) : null);
    } catch (e) {
      console.error("wiki migrate:", e instanceof Error ? e.message : e);
    }
    try {
      // Pages changed by hand in the vault while the hub was off are filed as people's edits.
      this.wiki.syncVault();
    } catch (e) {
      console.error("wiki sync:", e instanceof Error ? e.message : e);
    }
    this.uploadsDir = join(this.canvas.rendersDir, "uploads");
    mkdirSync(this.uploadsDir, { recursive: true });

    this.audio.onLine = (u, isNew) => this.roomLine(u, isNew);
    this.session.voiceprints = () => ({ ...voiceprintStatus(), enrolled: this.audio.voiceprints.enrolled });
    this.canvas.onRendered = (ids) => this.brain.artifactsLanded(ids.map((id) => this.session.store.get("artifacts", id)!).filter(Boolean));
    this.session.onUpdate = (agent, kind, text, ev) => {
      this.brain.agentUpdated(agent, kind, text, ev);
      try {
        this.wiki.agentUpdate();
      } catch (e) {
        console.error("wiki:", e instanceof Error ? e.message : e);
      }
    };
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
    this.keeper.start();
    this.wiki.start();
    setInterval(() => this.devproxy.refresh(), 30_000);
    setInterval(() => this.session.tick(), 60_000).unref?.();
    await Promise.all(tasks);
    // Without an engine the room is deaf and nothing says so; say so on the first screen.
    if (this.opts.whisper !== false) {
      const problem = this.transcriber.problem();
      if (problem) this.transcriber.warn(problem);
    }
  }

  /** Marks work as in flight until it settles (see `inflight`); returns an end to call when it is done. */
  begin(): () => void {
    let end!: () => void;
    const work = new Promise<void>((res) => (end = res));
    this.inflight.add(work);
    return () => {
      this.inflight.delete(work);
      end();
    };
  }

  track<T>(work: Promise<T>): Promise<T> {
    return work.finally(this.begin());
  }

  /** Waits until nothing is in flight, including work that starts while waiting, for at most `ms`. False if something still runs. */
  private async quiet(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (this.inflight.size) {
      const left = end - Date.now();
      if (left <= 0) return false;
      let timer!: ReturnType<typeof setTimeout>;
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((res) => (timer = setTimeout(res, left)))]);
      clearTimeout(timer);
    }
    return true;
  }

  /** Stops, saving a final snapshot first when there is a canvas to save. */
  async shutdown() {
    // First of all, close every way in: requests that would add something are refused, and the brain takes no new pass.
    this.closing = true;
    this.brain.stop();
    // Then what is already under way finishes, in this order: requests being answered (an upload still sending its body adds speech
    // when it lands), then the speech waiting to be transcribed (now, not on its timer) and the brain's pass. The local whisper
    // stops only after all of it. One deadline covers the lot.
    const until = Date.now() + Hub.SHUTDOWN_WAIT_MS;
    const admitted = await this.quiet(until - Date.now());
    void this.track(this.audio.flush()).catch((e) => console.error("audio:", e));
    void this.track(this.brain.idle());
    if (!(await this.quiet(until - Date.now())) || !admitted) console.warn("Still working at shutdown: anything it adds now is refused.");
    this.transcriber.stop();
    await Promise.race([this.autosave.save("end of session", { onlyIfChanged: true }).catch(() => null), Bun.sleep(8000)]);
    await Promise.race([this.keeper.save().catch(() => null), Bun.sleep(4000)]);
    // The conversation is sealed (a late event is refused, not missed), then its last stretch goes into the wiki's sources, on its own (it never
    // waits behind a slow ingest); it is read in if the model answers in time, or at the next start.
    this.store.seal("events");
    await Promise.race([Promise.resolve().then(() => this.wiki.captureFinal()).catch((e) => console.error("wiki:", e instanceof Error ? e.message : e)), Bun.sleep(5000)]);
    await Promise.race([this.wiki.flush().catch(() => null), Bun.sleep(15_000)]);
    await Promise.race([this.net.stop().catch(() => null), Bun.sleep(3000)]);
    this.stop();
    this.store.seal("all");
  }

  stop() {
    this.awake.stop();
    this.autosave.stop();
    this.keeper.stop();
    this.wiki.stop();
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

  /**
   * Typed into the room (the client view's box, or the host's). Treated like speech; direct goes
   * straight to the brain. Attached files ride on the event. A document sent with no words isn't a
   * request: it becomes proposed context instead of reaching the brain.
   */
  typed(personId: string | null, text: string, direct = false, attached: AttachmentRef[] = []) {
    const p = this.session.person(personId);
    const words = text.trim();
    const names = attached.map((a) => a.name).join(", ");
    const document = !words && attached.some((a) => a.kind !== "image");
    const ev = this.session.store.addEvent({
      kind: "speech",
      authorType: "person",
      authorId: p?.id ?? null,
      authorName: p?.name ?? "Someone",
      text: words || (attached.length ? `Shared ${names}` : ""),
      relevance: direct ? "work" : null,
      data: { typed: true, direct, ...(attached.length ? { attachments: attached, ...(words ? {} : { noWords: true }) } : {}), ...(document ? { proposedContext: true } : {}) },
    });
    if (document) this.session.proposeContext({ text: this.attachments.brainInput(attached).text.slice(0, 600) || `${names} (shared without a request)`, kind: "fact", by: ev.authorName, origin: "document", sourceEventIds: [ev.id], attachments: attached });
    else if (direct) this.brain.direct(ev);
    // Pictures with no words have nothing to triage; the feed shows them.
    else if (words) this.brain.hear(ev);
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

  async saveUpload(agent: Agent | null, bytes: Uint8Array, meta: { title: string; stage: "built" | "mockup"; note?: string; platform?: Platform; replaces?: string }): Promise<Artifact> {
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!isJpeg && !isPng) throw new Error("Upload a PNG or JPEG.");
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Images must be under 12 MB.");
    const file = `${newId("up")}.${isJpeg ? "jpg" : "png"}`;
    await Bun.write(join(this.uploadsDir, file), bytes);
    const size = imageSize(bytes);
    const art = this.session.upsertVersion(
      {
        kind: "screenshot",
        stage: meta.stage,
        title: meta.title,
        note: meta.note ?? "",
        image: `/renders/uploads/${file}`,
        agentId: agent?.id ?? null,
        platform: meta.platform,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      meta.replaces,
    );
    this.brain.artifactsLanded([art]);
    return art;
  }

  // ---------- an agent wants a screen someone locked (answered by the owner, by voice or a button) ----------

  private onShowRequest(r: ShowRequest) {
    const first = (n: string) => n.split(/\s+/)[0];
    const ask = showRequestSpeech(r);
    void speak(this.session, ask, { source: "voice", kind: "request" });
    // Once more after a minute if the owner hasn't answered.
    setTimeout(() => this.session.showRequests().find((x) => x.id === r.id)?.status === "pending" && void speak(this.session, `Still waiting, ${first(r.ownerName)}: ${ask}`, { source: "voice", kind: "request" }), 60_000).unref?.();
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
  hookAgent(body: any, _ip: string, _device?: string | null): Agent | undefined {
    if (body?.agentId) return this.session.agent(body.agentId);
    const chat = typeof body?.session_id === "string" ? body.session_id : "";
    return chat ? this.session.agents().find((a) => a.chatId === chat && a.harness === "claude-code") : undefined;
  }

  /** Whether this chat has joined (a hook asks before it sends anything). */
  chatJoined(body: any): boolean {
    return !!this.hookAgent(body, "");
  }

  /** UserPromptSubmit: the prompt goes into context; new room items come back as context. */
  onPrompt(body: any, ip: string, device?: string | null) {
    // The harness's own injected text (subagent reports, command output), which older hook scripts still forward.
    if (HARNESS_TEXT.test(String(body?.prompt ?? ""))) return {};
    const agent = this.hookAgent(body, ip, device);
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
    this.cancelListen(agent.id); // the person is talking to it: it hears the room through this turn's hooks
    this.hookSeen.set(agent.id, Date.now());
    const first = prompt.split("\n")[0].slice(0, 100);
    this.session.touchAgent(agent.id, { status: "working", ...(first && !prompt.startsWith("/") ? { activity: `Working on: ${first}` } : {}) });
    return this.pendingContext(agent, "UserPromptSubmit", "Handle these alongside your person's prompt; jam_ack directives when you take them.");
  }

  /**
   * What the room has for an agent that it hasn't been handed yet, as hook context. Everything
   * that reaches an agent (these hooks, jam_inbox, jam_wait, the idle listener) takes items out of
   * the same inbox and marks them delivered, so nothing is handed over twice.
   */
  private pendingContext(agent: Agent, event: "UserPromptSubmit" | "PostToolUse", closing: string) {
    const lines = this.pendingLines(agent);
    if (!lines.length) return {};
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `JamSesh, new since your last turn:\n${lines.join("\n")}\n${closing}` } };
  }

  private pendingLines(agent: Agent) {
    const { directives, messages } = this.session.inbox(agent.id, true);
    const lastSeen = this.store.setting<number>(`decisionsSeen:${agent.id}`, 0);
    const decisions = this.session.roomDecisions(agent.id, { afterId: lastSeen, limit: 10 });
    // Seen moves to the last decision this agent was handed. With none handed over, everything newer
    // than its mark was for other workstreams, so the mark moves to the newest decision in the log.
    const seen = decisions.length ? decisions[decisions.length - 1].id : this.store.recentEvents({ kinds: ["decision"], limit: 1 })[0]?.id;
    if (seen && seen > lastSeen) this.store.setSetting(`decisionsSeen:${agent.id}`, seen);
    return [
      ...directives.map((d) => `Room directive ${d.id} [${d.mode}] (${d.requestedBy}): ${d.text}`),
      ...messages.map((m) => (m.data.askId ? `QUESTION ${m.data.askId} from ${m.authorName}: ${m.text} (answer with jam_answer first)` : `Message from ${m.authorName}: ${m.text}`)),
      ...decisions.map((d) => `Room decision: ${d.text}`),
    ];
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
    this.hookSeen.set(agent.id, Date.now());
    this.markNewHooks(agent.id);
    const done = typeof agent.activity === "string" && agent.activity.startsWith("Done:");
    if (agent.status !== "working" || done) this.session.touchAgent(agent.id, { status: "working", ...(done ? { activity: "Working" } : {}) });
    else this.session.touchAgent(agent.id);
    if (/jam_(inbox|wait|ask)$/.test(String(body?.tool_name ?? ""))) return {};
    return this.pendingContext(agent, "PostToolUse", "Fold these into your current work; jam_ack directives when you take them, and answer questions with jam_answer.");
  }

  /**
   * An idle Claude Code agent has gone back to its person. Its Stop hook starts this call in the
   * background (asyncRewake): it holds until the room has something for the agent, then returns the
   * text that wakes it. A new prompt or a newer listen ends it empty; so does the time limit (the
   * server drops idle connections after about four minutes, so the hook script calls again).
   */
  async onListen(body: any, ip: string, device?: string | null, maxMs = 200_000): Promise<string> {
    const agent = this.hookAgent(body, ip, device);
    if (!agent) return "";
    this.hookSeen.set(agent.id, Date.now());
    this.markNewHooks(agent.id);
    const mine = (this.listening.get(agent.id) ?? 0) + 1;
    this.listening.set(agent.id, mine);
    this.session.wake(agent.id); // a listener this one replaces ends now
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      await this.session.wait(agent.id, Math.min(30_000, until - Date.now()));
      if (this.listening.get(agent.id) !== mine) return ""; // replaced, or its person started talking to it
      // In jam_wait (or jam_ask) the agent is already listening itself: it gets the items there.
      if (this.session.agent(agent.id)?.status === "waiting") {
        await Bun.sleep(1000);
        continue;
      }
      if (!this.session.hasInbox(agent.id)) continue;
      const lines = this.pendingLines(agent);
      if (!lines.length) continue;
      this.session.touchAgent(agent.id, { status: "working", activity: "Picking up work from the room" });
      return `JamSesh has something for you from the room:\n${lines.join("\n")}\njam_ack directives as you take them, follow the JamSesh skill, and post a jam_update when done.`;
    }
    if (this.listening.get(agent.id) === mine) this.listening.delete(agent.id);
    return "";
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
    this.hookSeen.set(agent.id, Date.now());
    const last = typeof body.last_assistant_message === "string" ? body.last_assistant_message.trim() : "";
    // A finished turn reads as "Done: ..." until the next task starts.
    if (last && !agent.activity.startsWith("Done:")) this.session.touchAgent(agent.id, { activity: `Done: ${last.split("\n")[0]}`.slice(0, 140) });
    const { directives, messages } = this.session.inbox(agent.id, true);
    if (!directives.length && !messages.length) {
      // Idle: the agent goes back to its person. The listener hook (see onListen) wakes it when the room has something.
      this.session.touchAgent(agent.id, { status: "idle" });
      // An install from before the listener existed can't be woken: keep it waiting in jam_wait, once per stop.
      if (!this.newHooks(agent.id) && !body.stop_hook_active && agent.harness === "claude-code" && agent.status !== "offline")
        return { decision: "block", reason: "You're in a JamSesh session: call jam_wait to wait for the room's next directive. If your person is typing to you, stop and help them instead." };
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
