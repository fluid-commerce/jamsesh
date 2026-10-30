// The session: people, devices, agents, workstreams, directives, artifacts and the
// stage. Every other part of the hub (brain, audio, canvas, MCP, HTTP) goes through it.
import { brainNames, cleanNames, MAX_ALIASES, MAX_NAME, normName, sameName } from "./names";
import { MAX_PER_MESSAGE, type AttachmentRef } from "./attachments";
import { bus } from "./bus";
import { config, hostAddresses } from "./config";
import { affinity } from "./brain/affinity";
import { Board, type ContextProposal, type TaskProposal } from "./board";
import { buildBrief, hasBrief } from "./brief";
import { newId, PALETTE, Store } from "./store";
import type {
  EventKind,
  Agent,
  Annotation,
  Artifact,
  ArtifactVersion,
  Fact,
  CanvasInfo,
  Device,
  DevServer,
  Directive,
  DirectiveMode,
  Document,
  HubState,
  JamEvent,
  Person,
  Platform,
  RemovedChat,
  Settings,
  Share,
  Stage,
  Workstream,
 TriageCard,
 BuildRequest, ReadyItem, ScreenInfo, ShowRequest, StageHistoryEntry, StageLock } from "./types";

/** A message or update longer than this is stored once and others get a pointer. */
export const LONG_TEXT = 1200;

/** An agent quiet this long shows as offline (and its record can be taken over by a rejoin). */
export const AGENT_OFFLINE_MS = 20 * 60_000;
/** An open task nobody has acked or reported on for this long gets a nudge to its agent; after the grace the room is offered a reassignment. */
export const TASK_STALE_MS = 20 * 60_000;
export const TASK_OFFER_MS = 10 * 60_000;
/** A person prompt this recent means the agent's own work was asked for. */
const ASKED_WINDOW_MS = 30 * 60_000;

export const DEFAULT_MODELS: Settings["models"] = {
  triage: "google/gemini-3.5-flash-lite",
  router: "anthropic/claude-sonnet-5.5",
  presenter: "anthropic/claude-sonnet-5.5",
  digest: "google/gemini-3.5-flash",
  speech: "microsoft/mai-voice-2.1",
  transcribe: "openai/gpt-transcribe",
};

/** The old default speech model is the one rooms were never asked about; they move to the current default with it. */
function withCurrentSpeech(models: Settings["models"]): Settings["models"] {
  return models.speech === "openai/tts-1" ? { ...models, speech: DEFAULT_MODELS.speech } : models;
}

export type UpdateKind = "progress" | "done" | "question" | "blocked" | "handoff" | "decision" | "shipped";

type Waiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> };

export class Session {
  store: Store;
  code: string;
  /** This session's id; the team store remembers every session. */
  sessionId: string;
  startedAt = Date.now();
  canvas: CanvasInfo = { status: "off", editLink: null, viewLink: null, wsEdit: null, wsView: null, reason: null, generation: 0 };
  brainStatus: HubState["brain"] = { status: "ready", lastError: null };
  private waiters = new Map<string, Set<Waiter>>();
  private stageRevert: ReturnType<typeof setTimeout> | null = null;
  private lockSweep: ReturnType<typeof setInterval> | null = null;
  /** Hooks for other modules (set by index.ts) so the session stays dependency-free. */
  /** A card landed on the Tasks board (4.1). */
  onTriage: ((c: TriageCard) => void) | null = null;
  /** The Tasks board's triage: proposals wait here until a person acts. */
  readonly board = new Board(this);
  onUpdate: ((agent: Agent, kind: UpdateKind, text: string, ev: JamEvent) => void) | null = null;
  /** An agent wrote to the room brain (jam_message by its name). */
  onBrainMessage: ((ev: JamEvent) => void) | null = null;
  onClaim: ((agentId: string, workstream: string) => void) | null = null;
  /** An agent took a new name because its owner was renamed (the canvas cursor follows). */
  onAgentRenamed: ((agent: Agent, oldName: string) => void) | null = null;

  constructor(store: Store) {
    this.store = store;
    this.code = store.setting("sessionCode", "") || makeCode();
    store.setSetting("sessionCode", this.code);
    this.sessionId = store.setting("sessionId", "") || newId("ses");
    store.setSetting("sessionId", this.sessionId);
    const sessions = store.setting<{ id: string; name: string; startedAt: number; lastActive: number }[]>("sessions", []);
    const me = sessions.find((x) => x.id === this.sessionId);
    if (me) me.lastActive = Date.now();
    else sessions.push({ id: this.sessionId, name: store.setting("sessionName", "Jam session"), startedAt: Date.now(), lastActive: Date.now() });
    store.setSetting("sessions", sessions.slice(-200));
    // Agents outlive a hub restart: they reconnect on their next call, and directives wait in their inbox.
    for (const a of store.all("agents")) if (a.status !== "offline") store.put("agents", { ...a, status: "idle", canvas: "none" }, false);
    for (const d of store.all("devices")) store.put("devices", { ...d, micOn: false, level: 0 }, false);
    // Nobody is still sharing after a restart: end the shares and take their tiles off the stage.
    for (const sh of store.all("shares")) if (sh.status === "live") this.endShare(sh.id);
    // The stage's timer died with the old process: a brought-up screen still returns to the board.
    const st = this.stage();
    if (this.revertsToBoard(st)) {
      this.stageRevert = setTimeout(() => this.setStage({ mode: "board" }, "JamSesh", "main", { override: true }), Math.max(1000, st.since + Session.STAGE_REVERT_MS - Date.now()));
      this.stageRevert.unref?.();
    }
    // A lock whose owner left lets go without anyone asking.
    this.lockSweep = setInterval(() => this.sweepLocks(), 30_000);
    this.lockSweep.unref?.();
    bus.resolver = (key) => this.resolve(key);
  }

  /** Every address people can join from: the room's LAN, Tailscale, and a public URL if one is set. */
  /** Set by the hub: addresses from the network setup (the public HTTPS address). */
  extraAddresses: () => { label: string; url: string; reachable?: "yes" | "no" | "unknown" }[] = () => [];

  addresses() {
    const list = [...this.extraAddresses(), ...hostAddresses().map((a) => ({ label: a.label, url: `http://${a.host}:${config.port}` }))];
    if (process.env.JAMSESH_PUBLIC_URL) list.push({ label: "Remote", url: process.env.JAMSESH_PUBLIC_URL.replace(/\/$/, "") });
    return list.length ? list : [{ label: "In the room", url: this.hubUrl }];
  }

  get hubUrl() {
    return `http://${config.publicHost}:${config.port}`;
  }

  // ---- settings ----

  settings(): Settings {
    const s = this.store;
    const keyInSettings = !!s.setting<string>("gatewayKey", "");
    return {
      sessionName: s.setting("sessionName", "Jam session"),
      brainName: s.setting("brainName", "JamSesh"),
      brainAliases: cleanNames(s.setting<unknown>("brainAliases", [])),
      brainNotes: s.setting<string[]>("brainNotes", []),
      brainEnabled: s.setting("brainEnabled", true),
      voiceReplies: s.setting("voiceReplies", true),
      voice: s.setting("voice", ""),
      models: withCurrentSpeech({ ...DEFAULT_MODELS, ...s.setting<Partial<Settings["models"]>>("models", {}) }),
      transcription: s.setting("transcription", "auto"),
      hostControl: s.setting("hostControl", true),
      language: s.setting("language", "en"),
      gatewayKeySet: keyInSettings || !!config.envGatewayKey,
      gatewayKeySource: keyInSettings ? "settings" : config.envGatewayKey ? "env" : "none",
    };
  }

  gatewayKey(): string | undefined {
    return this.store.setting<string>("gatewayKey", "") || config.envGatewayKey || undefined;
  }

  /** Adds a name the brain answers to (or makes it the display name, keeping the old one as an alias). */
  addBrainName(name: string, makeDisplay = false) {
    const { brainName, brainAliases } = this.settings();
    const names = [brainName, ...brainAliases];
    if (names.some((n) => sameName(n, name)) && !(makeDisplay && !sameName(brainName, name))) return;
    if (makeDisplay) this.updateSettings({ brainName: name, brainAliases: [brainName, ...brainAliases].filter((n) => !sameName(n, name)) });
    else this.updateSettings({ brainAliases: [...brainAliases.slice(1 - MAX_ALIASES), name] });
  }

  updateSettings(patch: Partial<Settings> & { gatewayKey?: string }) {
    const allowed = ["sessionName", "brainName", "brainAliases", "brainNotes", "brainEnabled", "voiceReplies", "voice", "transcription", "hostControl", "language"] as const;
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      // The API is the contract: a paired browser can post anything.
      if (k === "brainAliases") this.store.setSetting(k, cleanNames(patch[k]));
      else if (k === "brainName") {
        const n = typeof patch[k] === "string" ? patch[k].trim().slice(0, MAX_NAME) : "";
        if (n) this.store.setSetting(k, n);
      } else this.store.setSetting(k, patch[k]);
    }
    if (patch.models) this.store.setSetting("models", { ...this.store.setting("models", {}), ...patch.models });
    if (patch.gatewayKey !== undefined) this.store.setSetting("gatewayKey", patch.gatewayKey.trim());
    bus.changed("settings");
    bus.changed("session");
  }

  // ---- state for the views ----

  /** Host build requests waiting on (or just decided by) the room; HostControl owns them. */
  buildRequests: () => BuildRequest[] = () => [];
  /** Whether voice matching works on this host (the hub supplies it: the pipeline owns the voiceprints). */
  voiceprints: () => HubState["voiceprints"] = () => ({ available: false, reason: "", enrolled: 0 });

  state(): HubState {
    return {
      session: { name: this.settings().sessionName, code: this.code, startedAt: this.startedAt, hubUrl: this.hubUrl, canvas: this.canvas, addresses: this.addresses() },
      settings: this.settings(),
      people: this.people(),
      devices: this.store.all("devices"),
      agents: this.agents().map(publicAgent),
      workstreams: this.store.all("workstreams").sort((a, b) => b.updatedAt - a.updatedAt),
      directives: this.directives().slice(0, 60),
      artifacts: this.artifacts().slice(0, 120),
      devservers: this.store.all("devservers"),
      events: this.store.recentEvents({ limit: 250 }).map(publicEvent),
      utterances: this.store.all("utterances").sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : 1)).slice(-200),
      stage: this.stage(),
      shares: this.shares(),
      annotations: this.annotations(),
      facts: this.facts(),
      triage: this.board.shown(),
      buildRequests: this.buildRequests(),
      screens: this.screens(),
      readyToShow: this.readyToShow(),
      showRequests: this.showRequests().filter((r) => r.status === "pending"),
      stageHistory: this.stageHistory(),
      digest: hasBrief(this) ? this.brief().full : "",
      totals: this.totals(),
      brain: this.brainStatus,
      voiceprints: this.voiceprints(),
    };
  }

  totals(): HubState["totals"] {
    return { events: this.store.countEvents(), utterances: this.store.all("utterances").length, directives: this.store.all("directives").length, artifacts: this.store.all("artifacts").length };
  }

  /**
   * The part of a list that the live state leaves out: the page just older than `before` (the cursor
   * the previous page ended on: an event's id, or "<time>|<id>" of an utterance, directive or artifact),
   * plus how many are older still. Events and utterances come oldest first, the rest newest first.
   */
  history(what: string, o: { before?: number | string; limit?: number; kinds?: EventKind[] }): { items: any[]; more: number; total: number } | null {
    const asked = Number(o.limit ?? 50);
    const limit = Math.max(1, Math.min(200, Number.isFinite(asked) ? Math.floor(asked) : 50));
    // A cursor is "<time>|<id>" (the last item's), so items stamped the same millisecond aren't skipped.
    const [t, id = ""] = String(o.before ?? "").split("|");
    const beforeT = t !== "" && Number.isFinite(Number(t)) ? Number(t) : Infinity;
    const page = <T extends { id: string }>(all: T[], at: (x: T) => number, newestFirst: boolean) => {
      const key = (x: T) => at(x) * (newestFirst ? -1 : 1);
      const order = (a: T, b: T) => key(a) - key(b) || (a.id < b.id ? -1 : 1) * (newestFirst ? -1 : 1);
      const older = all.filter((x) => at(x) < beforeT || (at(x) === beforeT && id !== "" && x.id < id)).sort(order);
      const items = newestFirst ? older.slice(0, limit) : older.slice(-limit);
      return { items, more: older.length - items.length, total: all.length };
    };
    switch (what) {
      case "events": {
        const events = this.store.recentEvents({ limit, kinds: o.kinds, beforeId: beforeT === Infinity ? undefined : beforeT }).map(publicEvent);
        const oldest = events[0]?.id;
        return { items: events, more: oldest == null ? 0 : this.store.countEvents({ beforeId: oldest, kinds: o.kinds }), total: this.store.countEvents({ kinds: o.kinds }) };
      }
      case "utterances":
        return page(this.store.all("utterances"), (u) => u.t0, false);
      case "directives":
        return page(this.store.all("directives"), (d) => d.ts, true);
      case "artifacts":
        return page(this.store.all("artifacts"), (a) => a.updatedAt, true);
      default:
        return null;
    }
  }

  private resolve(key: string): { key: any; value: any } | null {
    switch (key) {
      case "people":
        return { key, value: this.people() };
      case "devices":
        return { key, value: this.store.all("devices") };
      case "agents":
        return { key, value: this.agents().map(publicAgent) };
      case "workstreams":
        return { key, value: this.store.all("workstreams").sort((a, b) => b.updatedAt - a.updatedAt) };
      case "directives":
        return { key, value: this.directives().slice(0, 60) };
      case "artifacts":
        return { key, value: this.artifacts().slice(0, 120) };
      case "devservers":
        return { key, value: this.store.all("devservers") };
      case "utterances":
        return { key, value: this.store.all("utterances").sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : 1)).slice(-200) };
      case "totals":
        return { key, value: this.totals() };
      case "digest":
        return { key, value: hasBrief(this) ? this.brief().full : "" };
      case "shares":
        return { key, value: this.shares() };
      case "annotations":
        return { key, value: this.annotations() };
      case "facts":
        return { key, value: this.facts() };
      case "triage":
        return { key, value: this.board.shown() };
      case "settings":
        return { key, value: this.settings() };
      case "session":
      case "canvas":
        return { key: "session", value: this.state().session };
      case "brain":
        return { key, value: this.brainStatus };
      case "screens":
        return { key, value: this.screens() };
      case "buildRequests":
        return { key, value: this.buildRequests() };
      case "readyToShow":
        return { key, value: this.readyToShow() };
      case "showRequests":
        return { key, value: this.showRequests().filter((r) => r.status === "pending") };
      case "stageHistory":
        return { key, value: this.stageHistory() };
      default:
        return null;
    }
  }

  setBrain(status: HubState["brain"]["status"], lastError: string | null = null) {
    this.brainStatus = { status, lastError: lastError ?? (status === "ready" ? null : this.brainStatus.lastError) };
    bus.changed("brain");
  }

  setCanvas(info: Partial<CanvasInfo>) {
    this.canvas = { ...this.canvas, ...info };
    bus.changed("canvas");
  }

  // ---- people and devices ----

  people(): Person[] {
    const samples = new Map<string, number>();
    for (const s of this.store.voiceSamples()) samples.set(s.personId, (samples.get(s.personId) ?? 0) + 1);
    return this.store
      .all("people")
      .map((p) => ({ ...p, voiceSamples: samples.get(p.id) ?? 0, hasVoiceprint: (samples.get(p.id) ?? 0) > 0 }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  person(id: string | null | undefined) {
    return id ? this.store.get("people", id) : undefined;
  }

  personByName(name: string): Person | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    const all = this.store.all("people");
    const exact = all.find((p) => p.name.trim().toLowerCase() === n);
    if (exact) return exact;
    // A first name or prefix only counts when it picks out one person: "Sam" with Sam Lee and Sam Cho is nobody.
    const only = (hits: Person[]) => (hits.length === 1 ? hits[0] : undefined);
    const first = n.split(/\s+/)[0];
    // "Sam" finds Sam Lee and "Sam Lee" finds a Sam with no surname yet, but Sam Cho is never Sam Lee.
    const oneWord = (x: string) => !/\s/.test(x.trim());
    const byFirst = all.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === first && (oneWord(n) || oneWord(p.name)));
    if (byFirst.length) return only(byFirst);
    // Too short a prefix ("Al") guesses rather than matches.
    return n.length >= 3 ? only(all.filter((p) => p.name.toLowerCase().startsWith(n))) : undefined;
  }

  /**
   * The title the project already has for someone (carried in when the session started), taken when they join, and remembered as the
   * version this session saw so it isn't saved back as a change of its own. One place, whenever a person appears.
   */
  adoptCarriedTitle(name: string): string | undefined {
    const carried = this.store.setting<Record<string, { role: string; version: number }>>("carriedTitles", {})[name.trim().toLowerCase()];
    if (!carried?.role) return undefined;
    const bases = { ...this.store.setting<Record<string, { v: number; sig: string }>>("carryBase", {}) };
    bases[`person:${name.trim().slice(0, 200)}`] = { v: carried.version, sig: carried.role };
    this.store.setSetting("carryBase", bases);
    return carried.role;
  }

  upsertPerson(fields: { id?: string; name: string; role?: string; weight?: number }): Person {
    const existing = fields.id ? this.store.get("people", fields.id) : this.personByName(fields.name);
    if (existing) {
      const incoming = fields.name.trim();
      // Matched by name, not id: "Sam" or "I'm Felipe" is a shorter way to say who someone is, not a rename.
      const shortened = !fields.id && !!incoming && existing.name.toLowerCase().startsWith(incoming.toLowerCase());
      const name = shortened ? existing.name : incoming || existing.name;
      if (name !== existing.name) this.renameOwned(existing, name);
      // Untitled when they come back: the project's title for them.
      const role = fields.role ?? (existing.role || this.adoptCarriedTitle(name) || existing.role);
      return this.store.put("people", {
        ...existing,
        name,
        role: role,
        // A new title brings its weight with it, unless someone set the weight by hand.
        weight: fields.weight ?? (role !== existing.role && existing.weight === weightForRole(existing.role) ? weightForRole(role) : existing.weight),
      });
    }
    const count = this.store.all("people").length;
    const role = fields.role ?? this.adoptCarriedTitle(fields.name) ?? "";
    const p: Person = {
      id: newId("p"),
      name: fields.name.trim(),
      role,
      weight: fields.weight ?? weightForRole(role),
      color: PALETTE[count % PALETTE.length],
      hasVoiceprint: false,
      voiceSamples: 0,
      createdAt: Date.now(),
    };
    this.store.put("people", p);
    this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: `${p.name}${p.role ? ` (${p.role})` : ""} joined the room.` });
    return p;
  }

  /** A renamed person's agents follow: their owner name, and a default "<name>'s Claude" name. */
  private renameOwned(person: Person, name: string) {
    const first = (n: string) => n.split(/\s+/)[0];
    const defaults = [...new Set([person.name, first(person.name)].map((n) => n.toLowerCase()))];
    for (const a of this.store.all("agents").filter((x) => x.ownerId === person.id)) {
      const m = a.name.match(/^(.+)'s (Claude|Codex|Agent)( \(.*\))?( \d+)?$/i);
      const isDefault = !!m && defaults.includes(m[1].toLowerCase());
      let next = a.name;
      if (isDefault) {
        const base = `${first(name)}'s ${m![2]}${m![3] ?? ""}`;
        const taken = new Set(this.store.all("agents").filter((x) => x.id !== a.id).map((x) => x.name.toLowerCase()));
        next = base;
        for (let i = 2; taken.has(next.toLowerCase()) && i < 100; i++) next = `${base} ${i}`;
      }
      const updated = this.store.put("agents", { ...a, ownerName: name, name: next });
      if (next !== a.name) this.onAgentRenamed?.(updated, a.name);
    }
    // Their windows too: a label made from the old name ("Felipe's laptop") takes the new one.
    for (const d of this.store.all("devices").filter((x) => x.personId === person.id)) {
      const m = d.label.match(/^(.+)'s (.+)$/);
      if (m && defaults.includes(m[1].toLowerCase())) this.store.put("devices", { ...d, label: `${first(name)}'s ${m[2]}` });
    }
  }

  removePerson(id: string) {
    this.store.clearVoiceprint(id);
    this.store.remove("people", id);
    for (const d of this.store.all("devices")) if (d.personId === id) this.store.patch("devices", d.id, { personId: null });
  }

  touchDevice(id: string, fields: Partial<Device> & { label?: string }): Device {
    const cur = this.store.get("devices", id);
    const d: Device = {
      id,
      label: fields.label ?? cur?.label ?? "Device",
      personId: fields.personId !== undefined ? fields.personId : cur?.personId ?? null,
      kind: fields.kind ?? cur?.kind ?? "client",
      location: fields.location ?? cur?.location ?? "room",
      micOn: fields.micOn ?? cur?.micOn ?? false,
      level: fields.level ?? cur?.level ?? 0,
      lastSeen: Date.now(),
      pairedId: fields.pairedId ?? cur?.pairedId,
    };
    const changed = !cur || cur.label !== d.label || cur.personId !== d.personId || cur.micOn !== d.micOn || cur.kind !== d.kind || cur.location !== d.location;
    this.store.put("devices", d, changed);
    return d;
  }

  // ---- agents ----

  agents(): Agent[] {
    const now = Date.now();
    return this.store
      .all("agents")
      .map((a) => (a.status !== "offline" && now - a.lastSeen > AGENT_OFFLINE_MS ? { ...a, status: "offline" as const } : a))
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** The agents that do the room's product work: observers only watch. */
  workers(): Agent[] {
    return this.agents().filter((a) => a.role !== "observer");
  }

  /** An observer that opted out of room-wide messages. */
  private skipsBroadcasts(a: Agent | undefined) {
    return a?.role === "observer" && a.broadcasts === false;
  }

  agent(id: string | null | undefined) {
    return id ? this.store.get("agents", id) : undefined;
  }

  registerAgent(info: {
    ownerName: string;
    harness: Agent["harness"];
    repo: string;
    branch?: string;
    cwd?: string;
    machine: string;
    platform?: Platform;
    focus?: string;
    name?: string;
    /** The chat joining (see Agent.chatId). */
    chatId?: string;
    role?: "worker" | "observer";
    broadcasts?: boolean;
    /** Whether an older record's `machine` is the caller's machine under an earlier credential. */
    sameMachine?: (machine: string) => boolean;
  }): { agent: Agent; resumed: boolean; quietMs: number | null } {
    const owner = this.personByName(info.ownerName) ?? (info.ownerName ? this.upsertPerson({ name: info.ownerName }) : undefined);
    const agents = this.store.all("agents");
    // The same agent coming back on a new credential takes over its own quiet record, name and
    // workstreams included, instead of joining as "… 2": when the old record's machine is this Mac
    // under an earlier credential, or the record has been gone long enough to show as offline.
    // The owner, harness and folder are the caller's word, so they alone never hand over a record
    // that may still be live (an agent busy for a minute is still live).
    const now = Date.now();
    // A chat is its own agent: one that names its chat resumes only that chat's record (or an older
    // record from before chats were told apart), and a chat that doesn't never takes a named chat's.
    const sameChat = (a: Agent) => (info.chatId ? !a.chatId || a.chatId === info.chatId : !a.chatId);
    const existing =
      // A chat id is only the caller's word: it resumes a record from the same machine, never another device's.
      (info.chatId ? agents.find((a) => a.chatId === info.chatId && a.harness === info.harness && (a.machine === info.machine || !!info.sameMachine?.(a.machine))) : undefined) ??
      agents.find((a) => sameChat(a) && a.machine === info.machine && (info.cwd ? a.cwd === info.cwd : a.repo === info.repo) && a.harness === info.harness) ??
      (info.cwd && owner
        ? agents
            .filter((a) => a.ownerId === owner.id && a.harness === info.harness && a.cwd === info.cwd && now - a.lastSeen > 60_000)
            .filter((a) => sameChat(a) || now - a.lastSeen > AGENT_OFFLINE_MS)
            .filter((a) => now - a.lastSeen > AGENT_OFFLINE_MS || !!info.sameMachine?.(a.machine))
            .sort((a, b) => b.lastSeen - a.lastSeen)[0]
        : undefined);
    const harnessLabel = info.harness === "codex" ? "Codex" : info.harness === "claude-code" ? "Claude" : "Agent";
    const ownerFirst = (owner?.name ?? info.ownerName ?? "Someone").split(/\s+/)[0];
    const sameOwner = this.store.all("agents").filter((a) => a.ownerId === owner?.id && a.id !== existing?.id && a.harness === info.harness);
    const baseName = info.name?.trim() || `${ownerFirst}'s ${harnessLabel}${sameOwner.length ? ` (${shortRepo(info.repo)})` : ""}`;
    // Two agents answering to the same name can't be told apart by voice or by jam_tell: number the newcomer.
    const taken = new Set(this.store.all("agents").filter((a) => a.id !== existing?.id).map((a) => a.name.toLowerCase()));
    let uniqueName = baseName;
    for (let i = 2; taken.has(uniqueName.toLowerCase()) && i < 100; i++) uniqueName = `${baseName} ${i}`;
    const agent: Agent = {
      id: existing?.id ?? newId("a"),
      name: existing && !info.name ? existing.name : uniqueName,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? info.ownerName,
      harness: info.harness,
      repo: (info.role ?? existing?.role) === "observer" ? "" : info.repo,
      branch: info.branch ?? existing?.branch ?? "",
      cwd: info.cwd ?? existing?.cwd ?? "",
      machine: info.machine,
      chatId: info.chatId ?? existing?.chatId,
      platform: info.platform ?? existing?.platform ?? "other",
      focus: info.focus ?? existing?.focus ?? "",
      status: "idle",
      activity: existing ? "Back in the session" : "Just joined",
      lastSeen: Date.now(),
      joinedAt: existing?.joinedAt ?? Date.now(),
      canvas: existing?.canvas ?? "none",
      ...(info.role || existing?.role ? { role: info.role ?? existing?.role } : {}),
      ...((info.role ?? existing?.role) === "observer" ? { broadcasts: info.broadcasts ?? existing?.broadcasts ?? true } : {}),
    };
    this.store.put("agents", agent);
    // The room is told who joined and from where, with a way to remove an agent that shouldn't be here.
    this.resumeWorkstreams(agent);
    this.store.addEvent({
      kind: "join",
      authorType: "agent",
      authorId: agent.id,
      authorName: agent.name,
      text:
        agent.role === "observer"
          ? `${agent.name} ${existing ? "rejoined" : "joined"} as an observer${agent.focus ? ` from ${tildePath(agent.cwd || agent.repo)}` : ""}`
          : `${agent.name} ${existing ? "rejoined" : "joined"} from ${tildePath(agent.cwd || agent.repo)}`,
      data: { agentId: agent.id, platform: agent.platform, harness: agent.harness, repo: shortRepo(agent.repo), branch: agent.branch, focus: agent.focus, resumed: !!existing, ...(agent.role === "observer" ? { observer: true } : {}) },
    });
    return { agent, resumed: !!existing, quietMs: existing ? Date.now() - existing.lastSeen : null };
  }

  /**
   * Takes an agent out of the room: it no longer exists to the hub (its tools and hooks stop working
   * until it joins again), its workstreams are free, and with `purge` what it authored goes too: its
   * events (updates, messages, join notices) and its long documents. Messages others sent it, prompts
   * its person wrote and its artifacts stay.
   */
  /** Agents the room took out, so a tool call from one says so instead of asking it to join again. */
  readonly removedAgents = new Set<string>();

  removeAgent(id: string, opts: { purge?: boolean } = {}): { removed: boolean; events: number } {
    const agent = this.agent(id);
    if (!agent) return { removed: false, events: 0 };
    for (const w of this.store.all("workstreams")) if (w.ownerAgentId === id) this.store.put("workstreams", { ...w, ownerAgentId: null, status: "paused", updatedAt: Date.now() });
    this.store.remove("agents", id);
    this.removedAgents.add(id);
    this.blockRejoin(agent);
    // Nothing waits on it any more: its share of each open task is cancelled (and the room told which),
    // what was being handed to it is dropped, and a listener or jam_wait of its ends now.
    const open = this.directives().filter((d) => d.targets.includes(id) && !["done", "cancelled"].includes(d.progress?.[id] ?? d.status));
    for (const d of open) this.setDirectiveFor(d.id, id, "cancelled", `${agent.name} was removed from the session`);
    if (open.length)
      this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: `${agent.name} was removed with ${open.length === 1 ? "an open task" : `${open.length} open tasks`}, now cancelled: ${open.map((d) => `"${d.text.slice(0, 80)}"`).join("; ")}. Ask the room to give ${open.length === 1 ? "it" : "them"} to another agent.`, data: { directiveIds: open.map((d) => d.id) } });
    this.store.setSetting(`deliveries:${id}`, []);
    this.wake(id);
    const ids = opts.purge ? this.store.deleteAgentEvents(id) : [];
    if (opts.purge) for (const d of this.store.all("documents")) if (d.authorId === id) this.store.remove("documents", d.id);
    if (ids.length) bus.send({ type: "events-removed", ids });
    if (!opts.purge) this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: `${agent.name} was removed from the session.` });
    return { removed: true, events: ids.length };
  }

  /**
   * Chats the room removed. Their jam_join is refused until a person lets them back in: "Allow again"
   * in Settings, or the person saying "connect to jamsesh" in that chat (its hook tells us, from the
   * same machine). Kept in the session, so a hub restart doesn't let them straight back.
   */
  removedChats(): RemovedChat[] {
    return this.store.setting<RemovedChat[]>("removedChats", []);
  }

  private blockRejoin(agent: Agent) {
    const rec: RemovedChat = { id: newId("rc"), agentId: agent.id, chatId: agent.chatId ?? null, machine: agent.machine, name: agent.name, ownerName: agent.ownerName, at: Date.now() };
    this.store.setSetting("removedChats", [...this.removedChats().filter((r) => r.agentId !== agent.id), rec].slice(-200));
  }

  /** The removal that keeps this chat out, if any (by its chat id, or the agent id its connection had). */
  rejoinBlocked(chatId: string | undefined, agentId: string | null): RemovedChat | undefined {
    return this.removedChats().find((r) => (!!chatId && r.chatId === chatId) || (!!agentId && r.agentId === agentId));
  }

  /** Lets a removed chat join again. By chat id, only a removal from the same machine (the chat's own hook asking). */
  allowRejoin(match: { id?: string; chatId?: string; machine?: string }): boolean {
    const all = this.removedChats();
    const gone = all.filter((r) => (match.id ? r.id === match.id : !!match.chatId && r.chatId === match.chatId && r.machine === match.machine));
    if (!gone.length) return false;
    for (const r of gone) this.removedAgents.delete(r.agentId);
    this.store.setSetting("removedChats", all.filter((r) => !gone.includes(r)));
    return true;
  }

  touchAgent(id: string, fields: Partial<Agent> = {}) {
    const a = this.store.get("agents", id);
    if (!a) return;
    const status = fields.status ?? (a.status === "offline" ? "idle" : a.status);
    const next = { ...a, ...fields, status, lastSeen: Date.now() };
    const visible = a.status !== next.status || a.activity !== next.activity || a.canvas !== next.canvas || a.focus !== next.focus;
    this.store.put("agents", next, visible);
    if (a.status === "offline" || Date.now() - a.lastSeen > AGENT_OFFLINE_MS) this.resumeWorkstreams(next);
  }

  findAgentByCwd(cwd: string, machine?: string, harness?: Agent["harness"]): Agent | undefined {
    const want = normalizePath(cwd);
    const agents = this.store.all("agents").filter((a) => a.cwd);
    let all = agents.filter((a) => {
      const have = normalizePath(a.cwd);
      return want === have || want.startsWith(have + "/");
    });
    if (machine && all.some((a) => a.machine === machine)) all = all.filter((a) => a.machine === machine);
    // The deepest folder is the closest match (/mono/ios over /mono); then the harness the hook came from.
    const depth = (a: Agent) => normalizePath(a.cwd).length;
    const exact = all.sort((a, b) => depth(b) - depth(a) || Number(b.harness === harness) - Number(a.harness === harness) || b.lastSeen - a.lastSeen)[0];
    if (exact) return exact;
    // Same folder name on the same machine (the agent may have reported its path another way).
    const base = want.split("/").pop();
    const byName = agents.filter((a) => a.machine === machine && normalizePath(a.cwd).split("/").pop() === base);
    return byName.length === 1 ? byName[0] : undefined;
  }

  /** A note from JamSesh itself to one agent; it arrives in the inbox and wakes a waiting `jam_wait`. */
  tellAgent(agentId: string, text: string) {
    const a = this.agent(agentId);
    if (!a) return;
    this.store.addEvent({ kind: "message", authorType: "system", authorId: null, authorName: "JamSesh", text, relevance: "work", data: { to: a.id, toName: a.name } });
    this.wake(a.id);
  }

  private nudged = new Set<string>();

  /**
   * A reply for an agent that mentioned a localhost address it hasn't shared: the exact step to share it.
   * Once per URL per agent; empty when there is nothing to say.
   */
  shareNudge(agentId: string, text: string): string {
    const shared = this.devservers().filter((d) => d.agentId === agentId).map((d) => d.target.replace(/^.*:/, ""));
    const out: string[] = [];
    for (const m of text.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b[^\s)>\]"']*/gi)) {
      const port = m[1];
      const url = `http://localhost:${port}`;
      const key = `${agentId}|${port}`;
      if (shared.includes(port) || this.nudged.has(key) || out.some((o) => o.includes(`"${url}"`))) continue;
      this.nudged.add(key);
      out.push(`You mentioned ${m[0]} but the room can't open it yet. To share it: make sure the server listens on 0.0.0.0 (for example vite --host 0.0.0.0), then call jam_devserver with url "${url}" and a name for the tile.`);
    }
    return out.length ? `\n\n${out.join("\n")}` : "";
  }

  /**
   * A long text is stored once as a document. Returns what the feed and other agents' inboxes carry
   * instead: its opening and where to fetch the rest.
   */
  shelve(from: { id: string; name: string }, text: string): { text: string; documentId?: string } {
    if (text.length <= LONG_TEXT) return { text };
    const doc: Document = { id: newId("doc"), ts: Date.now(), authorId: from.id, authorName: from.name, title: text.split("\n", 1)[0].slice(0, 80), text };
    this.store.put("documents", doc, false);
    const cut = text.slice(0, 240).replace(/\s+\S*$/, "");
    return { text: `${cut}… [long: ${text.length} chars, stored once. Read it all with jam_artifacts id ${doc.id}]`, documentId: doc.id };
  }

  postUpdate(agentId: string, kind: UpdateKind, text: string, extra: { workstream?: string; data?: Record<string, any> } = {}) {
    const agent = this.agent(agentId);
    if (!agent) throw new Error("Unknown agent; call jam_join first.");
    // A workstream another agent holds isn't this one's: the update stays untagged rather than land in its brief.
    const claimed = extra.workstream ? this.claim(agentId, extra.workstream, { quiet: true }) : undefined;
    const ws = claimed && !claimed.conflict ? claimed.workstream : undefined;
    const short = this.shelve(agent, text);
    const ev = this.store.addEvent({
      // An agent's decision is an update the brain can promote; only the brain makes room decisions.
      kind: "update",
      authorType: "agent",
      authorId: agentId,
      authorName: agent.name,
      text: short.text,
      workstreamId: ws?.id ?? null,
      relevance: "work",
      data: { updateKind: kind, ...(extra.data ?? {}), ...(short.documentId ? { documentId: short.documentId } : {}) },
    });
    const status = kind === "blocked" || kind === "question" ? "blocked" : kind === "done" || kind === "shipped" ? "idle" : "working";
    this.touchAgent(agentId, { status, activity: (kind === "done" || kind === "shipped" ? `Done: ${text}` : text).slice(0, 140) });
    if (kind === "question" || kind === "blocked") bus.send({ type: "toast", tone: "warn", text: `${agent.name} needs the room`, detail: text });
    const linked = typeof extra.data?.directiveId === "string" ? extra.data.directiveId : "";
    if (linked) this.noteProgress(linked, agentId);
    this.onUpdate?.(this.agent(agentId)!, kind, text, ev);
    return ev;
  }

  // ---- workstreams ----

  claim(agentId: string, title: string, opts: { quiet?: boolean; force?: boolean } = {}) {
    const agent = this.agent(agentId);
    const t = title.trim();
    const key = normalize(t);
    const existing = this.store.all("workstreams").find((w) => normalize(w.title) === key);
    if (existing && existing.ownerAgentId && existing.ownerAgentId !== agentId && !opts.force) {
      // An agent that went quiet shows as offline (derived, never stored): its workstream is free to take.
      const owner = this.agents().find((a) => a.id === existing.ownerAgentId);
      if (owner && owner.status !== "offline") {
        return { workstream: existing, conflict: owner };
      }
    }
    // The first claim right after joining is what the join prompt asked for (the chat's prompt was ignored before it joined).
    const firstAfterJoin = !!agent && Date.now() - agent.joinedAt < ASKED_WINDOW_MS && !this.store.all("workstreams").some((w) => w.ownerAgentId === agentId);
    const ws: Workstream = existing
      ? { ...existing, ownerAgentId: agentId, status: "active", updatedAt: Date.now() }
      : { id: newId("w"), title: t, ownerAgentId: agentId, status: "active", brief: "", updatedAt: Date.now() };
    this.store.put("workstreams", ws);
    // What this agent already posted without a workstream belongs to the one it just took.
    const only = this.store.all("workstreams").filter((w) => w.ownerAgentId === agentId && w.status === "active").length === 1;
    for (const x of this.store.all("artifacts")) if (x.agentId === agentId && !x.workstreamId && (only || groupKey(x.group) === groupKey(ws.title))) this.store.put("artifacts", { ...x, workstreamId: ws.id });
    this.onClaim?.(agentId, ws.title);
    if (!opts.quiet && agent) {
      // Work nobody asked for (no open task, no prompt from its person lately) is announced as such.
      const onItsOwn = !!existing && existing.ownerAgentId === agentId && existing.status === "active" ? false : !firstAfterJoin && this.startedOnItsOwn(agent);
      this.store.addEvent({
        kind: "system",
        authorType: "agent",
        authorId: agentId,
        authorName: agent.name,
        text: onItsOwn ? `${agent.name} started "${ws.title}" on its own; nobody asked for it.` : `${agent.name} took "${ws.title}".`,
        workstreamId: ws.id,
        data: onItsOwn ? { onItsOwn: true } : {},
      });
      if (onItsOwn) bus.send({ type: "toast", tone: "info", text: `${agent.name} started something on its own`, detail: ws.title });
    }
    return { workstream: ws, conflict: null as Agent | null };
  }

  /** True when nobody asked this agent for work: no open task for it and no prompt from its person lately. */
  private startedOnItsOwn(agent: Agent) {
    if (this.openFor(agent.id).length || this.directives().some((d) => d.targets.includes(agent.id) && (d.progress?.[agent.id] ?? d.status) === "pending")) return false;
    // Only Claude Code reports its person's prompts; for other agents we can't tell, so they aren't accused.
    if (agent.harness !== "claude-code") return false;
    const since = Date.now() - ASKED_WINDOW_MS;
    return !this.store.recentEvents({ kinds: ["prompt"], limit: 60 }).some((e) => e.ts >= since && e.data.agentId === agent.id);
  }

  /** A workstream pauses when its owner goes offline, and picks up again when the owner is back. */
  private resumeWorkstreams(agent: Agent) {
    for (const w of this.store.all("workstreams")) {
      if (w.ownerAgentId !== agent.id || w.status !== "paused") continue;
      this.store.put("workstreams", { ...w, status: "active", updatedAt: Date.now() });
      this.store.addEvent({ kind: "system", authorType: "agent", authorId: agent.id, authorName: agent.name, text: `${agent.name} is back; "${w.title}" is active again.`, workstreamId: w.id });
    }
  }

  /**
   * Housekeeping, run every minute by the hub: pause workstreams whose owner went offline, ask
   * agents about tasks that sat without an ack or a report, and offer the room a reassignment
   * when asking didn't help.
   */
  tick(now = Date.now()) {
    const agents = new Map(this.agents().map((a) => [a.id, a]));
    for (const w of this.store.all("workstreams")) {
      const owner = w.ownerAgentId ? agents.get(w.ownerAgentId) : undefined;
      if (w.status !== "active" || !owner || owner.status !== "offline") continue;
      this.store.put("workstreams", { ...w, status: "paused", updatedAt: now });
      this.store.addEvent({ kind: "system", authorType: "system", authorId: null, authorName: "JamSesh", text: `${owner.name} went offline; "${w.title}" is paused until it's back or someone takes it.`, workstreamId: w.id });
    }
    for (const d of this.openDirectives()) {
      if (d.mode !== "explore" && d.mode !== "implement") continue;
      for (const t of d.targets) {
        const state = d.progress?.[t] ?? d.status;
        if (state === "done" || state === "cancelled") continue;
        const agent = agents.get(t);
        if (!agent || now - this.lastSign(d, t) < TASK_STALE_MS) continue;
        const nudgeAt = d.nudgedAt?.[t];
        const nudged = nudgeAt && nudgeAt > this.lastSign(d, t) ? nudgeAt : undefined; // an answer to the nudge starts the clock again
        // An agent that's gone can't answer a nudge: the room is offered the reassignment right away.
        if (agent.status === "offline" || (nudged && now - nudged >= TASK_OFFER_MS)) {
          if (!d.reassignOfferedAt?.[t]) this.offerReassign(d, agent, now);
        } else if (!nudged) {
          this.store.patch("directives", d.id, { nudgedAt: { ...(d.nudgedAt ?? {}), [t]: now } });
          this.store.addEvent({
            kind: "message",
            authorType: "system",
            authorId: null,
            authorName: "JamSesh",
            text: `It has been ${Math.round((now - this.lastSign(d, t)) / 60_000)} minutes since you reported on directive ${d.id} ("${d.text.slice(0, 100)}"). jam_ack it if you've started, post a jam_update with where you are, or say if you're stuck.`,
            relevance: "work",
            data: { to: t, toName: agent.name, nudge: d.id },
          });
          this.wake(t);
        }
      }
    }
  }

  openDirectives() {
    return this.directives().filter((d) => d.status !== "done" && d.status !== "cancelled");
  }

  /** The last time anything moved on this task for this agent: when it reached the agent, was acked, or the agent reported on it. */
  private lastSign(d: Directive, agentId: string) {
    return Math.max(d.ts, d.signs?.[agentId] ?? 0);
  }

  /** This agent showed progress on this task: the clock starts again and a standing reassignment offer goes. */
  noteProgress(directiveId: string, agentId: string, at = Date.now()) {
    const d = this.store.get("directives", directiveId);
    if (!d || !d.targets.includes(agentId)) return;
    const { [agentId]: _offer, ...offers } = d.reassignOfferedAt ?? {};
    this.store.patch("directives", directiveId, { signs: { ...(d.signs ?? {}), [agentId]: at }, reassignOfferedAt: offers });
  }

  private offerReassign(d: Directive, agent: Agent, now: number) {
    const mins = Math.round((now - this.lastSign(d, agent.id)) / 60_000);
    this.store.patch("directives", d.id, { reassignOfferedAt: { ...(d.reassignOfferedAt ?? {}), [agent.id]: now } });
    this.store.addEvent({ kind: "system", authorType: "system", authorId: null, authorName: "JamSesh", text: `${agent.name} hasn't reported on "${d.text.slice(0, 100)}" in ${mins} minutes. Reassign it from the agent's tile.`, data: { directiveId: d.id, agentId: agent.id, reassignOffer: true } });
    bus.send({ type: "toast", tone: "warn", text: `${agent.name} is quiet on a task`, detail: `${mins} minutes on "${d.text.slice(0, 80)}". Reassign it from its tile.` });
  }

  /**
   * Moves a stalled task to another worker (the best match for it, or `to`). Only `target` is released
   * (default: the targets the room was offered a reassignment for, else every unfinished one); the other targets keep working.
   */
  reassignDirective(id: string, by: string, to?: string, target?: string): Directive | undefined {
    const d = this.store.get("directives", id);
    if (!d || d.status === "done" || d.status === "cancelled") return undefined;
    const open = d.targets.filter((t) => !["done", "cancelled"].includes(d.progress?.[t] ?? d.status));
    const offered = open.filter((t) => d.reassignOfferedAt?.[t]);
    const from = target ? open.filter((t) => t === target) : offered.length ? offered : open;
    if (!from.length) return undefined;
    const taken = new Set(d.targets);
    const live = this.workers().filter((a) => a.status !== "offline" && !taken.has(a.id));
    const pick = (to ? live.find((a) => a.id === to) : undefined) ?? (affinity(this, d.text).find((x) => live.some((a) => a.id === x.agent.id))?.agent ?? live[0]);
    if (!pick) {
      bus.send({ type: "toast", tone: "warn", text: "Nobody else is free to take it", detail: d.text.slice(0, 100) });
      return undefined;
    }
    for (const t of from) {
      this.setDirectiveFor(id, t, "cancelled", `Reassigned to ${pick.name} by ${by}`);
      this.wake(t);
    }
    const left = this.store.get("directives", id);
    if (left) this.store.patch("directives", id, { reassignOfferedAt: Object.fromEntries(Object.entries(left.reassignOfferedAt ?? {}).filter(([t]) => !from.includes(t))) });
    return this.createDirective({ text: d.text, mode: d.mode, targets: [pick.id], requestedBy: by, rationale: `Reassigned from ${from.map((t) => this.agent(t)?.name ?? "an agent").join(", ")}, which hadn't reported in a while.`, workstreamId: d.workstreamId, sourceEventIds: d.sourceEventIds, attachments: d.attachments ?? [] });
  }

  // ---- directives ----

  directives(): Directive[] {
    return this.store.all("directives").sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }

  createDirective(d: {
    text: string;
    mode: DirectiveMode;
    rationale?: string;
    targets: string[];
    priority?: number;
    requestedBy: string;
    sourceEventIds?: number[];
    workstreamId?: string | null;
    attachments?: AttachmentRef[];
  }): Directive {
    // The files that came with the request ride along, so the agent can fetch what the room is looking at.
    const files = new Map<string, AttachmentRef>();
    // Given a list, that list is the delivery, exactly (a card's reviewed files); otherwise the files on the lines it came from.
    // Either way a task carries at most one message's worth: more is refused, never cut.
    if (d.attachments) for (const a of d.attachments) files.set(a.id, a);
    else for (const id of d.sourceEventIds ?? []) for (const a of (this.store.event(id)?.data.attachments ?? []) as AttachmentRef[]) files.set(a.id, a);
    if (files.size > MAX_PER_MESSAGE) throw new Error(`A task carries at most ${MAX_PER_MESSAGE} files.`);
    // Observers only watch: product work never goes to them (answers and notes still can).
    if (d.mode !== "answer" && d.mode !== "note") d = { ...d, targets: d.targets.filter((t) => this.agent(t)?.role !== "observer") };
    const directive: Directive = {
      id: newId("d"),
      ts: Date.now(),
      text: d.text,
      mode: d.mode,
      rationale: d.rationale ?? "",
      targets: d.targets,
      status: "pending",
      progress: Object.fromEntries(d.targets.map((t) => [t, "pending" as const])),
      priority: d.priority ?? 1,
      requestedBy: d.requestedBy,
      sourceEventIds: d.sourceEventIds ?? [],
      workstreamId: d.workstreamId ?? null,
      result: "",
      deliveredAt: null,
      updatedAt: Date.now(),
      ...(files.size ? { attachments: [...files.values()] } : {}),
    };
    this.store.put("directives", directive);
    const names = d.targets.map((t) => this.agent(t)?.name).filter(Boolean);
    this.store.addEvent({
      kind: "directive",
      authorType: "brain",
      authorName: "Room brain",
      text: d.text,
      relevance: "work",
      workstreamId: directive.workstreamId,
      data: { directiveId: directive.id, mode: d.mode, targets: d.targets, targetNames: names, requestedBy: d.requestedBy, rationale: directive.rationale },
    });
    bus.send({
      type: "toast",
      tone: "directive",
      text: names.length ? `→ ${names.join(", ")}` : "Noted for the room",
      detail: d.text,
    });
    for (const t of d.targets) this.wake(t);
    // An agent that's gone, or idle without waiting for work, won't see this until its person types
    // to it. Say so, so someone can nudge it, instead of the room assuming it's underway.
    const asleep = (id: string) => {
      const a = this.agent(id);
      return !a || a.status === "offline" || Date.now() - a.lastSeen > 20 * 60_000;
    };
    const gone = d.targets.filter(asleep).map((t) => this.agent(t)?.name ?? "That agent");
    if (gone.length) bus.send({ type: "toast", tone: "warn", text: `${gone.join(", ")} isn't connected right now`, detail: "It gets this as soon as it's back." });
    if (d.mode === "explore" || d.mode === "implement")
      setTimeout(() => {
        const now = this.store.get("directives", directive.id);
        if (!now || now.status === "done" || now.status === "cancelled") return;
        const idle = d.targets.filter((t) => now.progress[t] === "pending" && !asleep(t) && this.agent(t)?.status !== "waiting").map((t) => this.agent(t)!);
        for (const a of idle) bus.send({ type: "toast", tone: "warn", text: `${a.name} hasn't picked this up yet`, detail: `${a.ownerName}: type anything to it, or tell it to wait for the room (jam_wait).` });
      }, 45_000).unref?.();
    return directive;
  }

  setDirective(id: string, fields: Partial<Directive>) {
    const d = this.store.patch("directives", id, { ...fields, updatedAt: Date.now() });
    // A status set on the directive itself (not through one target's progress) is news for every target.
    if (d && fields.status && !fields.progress) for (const t of d.targets) this.noteProgress(id, t);
    return d;
  }

  /** The one task an agent is on (the one it picked up, else the one open for it); null when there's none or more than one to choose from. */
  workingOn(agentId: string | null | undefined): string | null {
    if (!agentId) return null;
    const open = this.directives().filter((d) => d.targets.includes(agentId) && d.status !== "done" && d.status !== "cancelled" && d.mode !== "answer" && d.progress[agentId] !== "done" && d.progress[agentId] !== "cancelled");
    const picked = open.filter((d) => d.progress[agentId] === "acked");
    const only = picked.length ? picked : open;
    return only.length === 1 ? only[0].id : null;
  }

  /** Cancels an open directive and tells each of its agents to stop, and why. */
  cancelDirective(d: Directive, reason: string, attachments: AttachmentRef[] = []) {
    // The files the cancelling card showed go with the message, with where to fetch each (an agent's inbox prints only text).
    const files = attachments.length ? `\nFiles with this: ${attachments.map((a) => a.name).join(", ")} (links follow in your inbox).` : "";
    this.setDirective(d.id, { status: "cancelled", progress: Object.fromEntries(d.targets.map((t) => [t, "cancelled" as const])) });
    for (const t of d.targets) {
      this.store.addEvent({ kind: "message", authorType: "system", authorName: "JamSesh", text: `Cancelled: "${d.text.slice(0, 120)}". ${reason} Stop that work; a new directive follows if there's something else to do.${files}`, relevance: "work", data: { to: t, directiveId: d.id, ...(attachments.length ? { attachments } : {}) } });
      this.wake(t);
    }
  }

  /** One agent's progress on a directive; the directive's status follows the slowest target. */
  setDirectiveFor(id: string, agentId: string, status: Directive["status"], result?: string) {
    const d = this.store.get("directives", id);
    if (!d) return undefined;
    // Cancelled stays cancelled: a late ack or "done" from the agent doesn't reopen it.
    if (d.status === "cancelled" || d.progress?.[agentId] === "cancelled") return d;
    const progress = { ...(d.progress ?? Object.fromEntries(d.targets.map((t) => [t, d.status]))), [agentId]: status };
    const order: Directive["status"][] = ["pending", "delivered", "acked", "done", "cancelled"];
    const states = d.targets.map((t) => progress[t] ?? "pending");
    const finished = states.every((x) => x === "done" || x === "cancelled");
    const overall = finished ? (states.includes("done") ? "done" : "cancelled") : states.map((x) => order.indexOf(x)).reduce((a, b) => Math.min(a, b)) >= 2 ? "acked" : states.some((x) => x !== "pending") ? "delivered" : "pending";
    const res = result ? [d.result, `${this.agent(agentId)?.name ?? agentId}: ${result}`].filter(Boolean).join("\n") : d.result;
    const out = this.setDirective(id, { progress, status: overall as Directive["status"], result: res });
    this.noteProgress(id, agentId);
    return out;
  }

  /** Directives this agent took but hasn't finished. */
  openFor(agentId: string) {
    return this.directives().filter((d) => d.targets.includes(agentId) && ["delivered", "acked"].includes(d.progress?.[agentId] ?? d.status));
  }

  /** Unread work for an agent: directives aimed at it and messages to it. */
  /**
   * What is waiting for an agent. `markDelivered` (the default) also marks it handed over; `peek` lists only what is still new
   * and marks nothing, for a caller that marks it (markInbox) once the reply carrying it has been sent.
   */
  inbox(agentId: string, markDelivered = true, peek = false) {
    const mine = (d: Directive) => d.progress?.[agentId] ?? d.status;
    const directives = this.directives()
      .filter((d) => d.targets.includes(agentId) && (mine(d) === "pending" || (!markDelivered && !peek && mine(d) === "delivered")))
      .reverse();
    const lastRead = this.store.setting<number>(`msgRead:${agentId}`, 0);
    const quiet = this.skipsBroadcasts(this.agent(agentId));
    // This agent's messages, oldest first, up to 50: chosen before the limit (newer messages for others can't hide one, and the read
    // mark never moves past one that wasn't carried).
    const mineOf = (e: JamEvent) => !e.data.inline && (e.data.to === agentId || (e.data.to === "all" && e.authorId !== agentId && !quiet));
    const messages: JamEvent[] = [];
    for (let after = lastRead; messages.length < 50; ) {
      const page = this.store.eventsAfter(after, ["message"], 200);
      for (const e of page) if (mineOf(e) && messages.length < 50) messages.push(e);
      if (page.length < 200 || messages.length >= 50) break;
      after = page[page.length - 1].id;
    }
    if (markDelivered) this.markInbox(agentId, { directives, messages });
    return { directives, messages };
  }

  /** Marks exactly these items as handed over (read): what a reply carried, once it has been sent. Messages are marked up to the last one carried. */
  markInbox(agentId: string, taken: { directives: Directive[]; messages: JamEvent[] }) {
    for (const d of taken.directives) {
      // Only while still new for this agent: another reader may have delivered it, and the agent may have finished it since.
      const now = this.store.get("directives", d.id);
      if (!now || (now.progress?.[agentId] ?? now.status) !== "pending") continue;
      this.setDirectiveFor(d.id, agentId, "delivered");
      this.setDirective(d.id, { deliveredAt: d.deliveredAt ?? Date.now() });
    }
    if (taken.messages.length) this.store.setSetting(`msgRead:${agentId}`, Math.max(this.store.setting<number>(`msgRead:${agentId}`, 0), taken.messages[taken.messages.length - 1].id));
  }

  hasInbox(agentId: string) {
    const { directives, messages } = this.inbox(agentId, false);
    return directives.some((d) => (d.progress?.[agentId] ?? d.status) === "pending") || messages.length > 0;
  }

  wait(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.hasInbox(agentId)) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiters.get(agentId) ?? new Set();
      this.waiters.set(agentId, set);
      const w: Waiter = {
        resolve: () => {
          clearTimeout(w.timer);
          set.delete(w);
          resolve();
        },
        timer: setTimeout(() => w.resolve(), timeoutMs),
      };
      set.add(w);
      // The caller went away: the wait ends now, and nothing is taken for it.
      signal?.addEventListener("abort", () => w.resolve(), { once: true });
    });
  }

  wake(agentId: string) {
    for (const w of [...(this.waiters.get(agentId) ?? [])]) w.resolve();
  }

  isWaiting(agentId: string) {
    return (this.waiters.get(agentId)?.size ?? 0) > 0;
  }

  /** The brain's name, or any alias the room set for it (settings may not have an alias list yet). */
  isBrainName(name: string) {
    const s = this.settings();
    return !!normName(name) && [...brainNames(s), "brain"].some((n) => sameName(n, name));
  }

  /** Decisions the room made (the brain's; agents' own decisions are updates), relevant to this agent's workstream when it has one. */
  roomDecisions(agentId: string, opts: { afterId?: number; limit: number; workstreamId?: string }) {
    const mine = opts.workstreamId ? [opts.workstreamId] : this.store.all("workstreams").filter((w) => w.ownerAgentId === agentId && w.status === "active").map((w) => w.id);
    const relevant = (e: JamEvent) => e.authorType !== "agent" && (!mine.length || !e.workstreamId || mine.includes(e.workstreamId));
    // Page back until enough are relevant: other workstreams' decisions can't crowd one out.
    const out: JamEvent[] = [];
    let beforeId: number | undefined;
    for (let pages = 0; out.length < opts.limit && pages < 20; pages++) {
      const page = this.store.recentEvents({ kinds: ["decision"], afterId: opts.afterId, beforeId, limit: 100 });
      out.unshift(...page.filter(relevant));
      if (page.length < 100) break;
      beforeId = page[0].id;
    }
    return out.slice(-opts.limit);
  }

  sendMessage(fromAgentId: string, to: string, text: string, data: Record<string, any> = {}) {
    const from = this.agent(fromAgentId);
    if (!from) throw new Error("Unknown agent; call jam_join first.");
    const target = to === "all" ? null : this.agent(to) ?? this.store.all("agents").find((a) => a.name.toLowerCase() === to.toLowerCase());
    if (to !== "all" && !target && this.isBrainName(to)) {
      const ev = this.store.addEvent({
        kind: "message",
        authorType: "agent",
        authorId: from.id,
        authorName: from.name,
        text,
        relevance: "work",
        data: { to: "brain", toName: this.settings().brainName, typed: true, ...data },
      });
      this.onBrainMessage?.(ev);
      return ev;
    }
    if (to !== "all" && !target) throw new Error(`No agent named ${to}. Call jam_agents to see who is here.`);
    // A long note to everyone is stored once; each agent's inbox gets the pointer.
    const short = target ? { text } : this.shelve(from, text);
    const ev = this.store.addEvent({
      kind: "message",
      authorType: "agent",
      authorId: from.id,
      authorName: from.name,
      text: short.text,
      relevance: "work",
      data: { to: target?.id ?? "all", toName: target?.name ?? "everyone", ...data, ...(short.documentId ? { documentId: short.documentId } : {}) },
    });
    if (target) this.wake(target.id);
    else for (const a of this.store.all("agents")) if (a.id !== from.id && !this.skipsBroadcasts(a)) this.wake(a.id);
    return ev;
  }

  // ---- agents asking each other ----

  private asks = new Map<string, { resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }>();

  /** An agent (or the brain, fromId null) asks another agent; resolves with the answer or null on timeout. */
  ask(fromId: string | null, to: string, question: string, waitMs: number): { askId: string; answer: Promise<string | null> } {
    const target = this.agent(to) ?? this.store.all("agents").find((a) => a.name.toLowerCase() === to.toLowerCase());
    if (!target) throw new Error(`No agent named ${to}. Call jam_agents to see who is here.`);
    const from = this.agent(fromId);
    const askId = newId("ask");
    this.store.addEvent({
      kind: "message",
      authorType: from ? "agent" : "brain",
      authorId: from?.id ?? null,
      authorName: from?.name ?? this.settings().brainName,
      text: question,
      relevance: "work",
      data: { to: target.id, toName: target.name, askId },
    });
    this.wake(target.id);
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => (this.asks.delete(askId), resolve(null)), waitMs);
      this.asks.set(askId, { resolve: (a) => (clearTimeout(timer), this.asks.delete(askId), resolve(a)), timer });
    });
    return { askId, answer };
  }

  answer(fromId: string, askId: string, text: string) {
    const from = this.agent(fromId);
    const q = this.store.recentEvents({ kinds: ["message"], limit: 400 }).find((e) => e.data.askId === askId);
    if (!q) throw new Error("No question with that id.");
    const waiting = this.asks.get(askId);
    this.store.addEvent({
      kind: "message",
      authorType: "agent",
      authorId: fromId,
      authorName: from?.name ?? "Agent",
      text,
      relevance: "work",
      // A waiting jam_ask returns the answer itself: the inbox doesn't repeat it.
      data: { to: q.authorId ?? "brain", toName: q.authorName, answerTo: askId, ...(waiting ? { inline: true } : {}) },
    });
    if (waiting) waiting.resolve(text);
    else if (q.authorId) this.wake(q.authorId); // the asker stopped waiting; it gets the answer in its inbox
  }

  // ---- artifacts ----

  artifacts(): Artifact[] {
    return this.store.all("artifacts").sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  }

  upsertArtifact(a: Partial<Artifact> & { kind: Artifact["kind"]; title: string }, opts: { announce?: boolean } = {}): Artifact {
    const existing = a.id ? this.store.get("artifacts", a.id) : undefined;
    const agent = this.agent(a.agentId ?? existing?.agentId);
    // Titles are tidied and grouped as an item arrives (4.5); once an item has versions its title stays put,
    // because later builds are matched to it by that title.
    const title = existing && ((existing.version ?? 1) > 1 || (a.version ?? 1) > 1) ? existing.title : tidyTitle(a.title);
    const split = splitTitle(title);
    const group = this.canonGroup(a.group ?? split.group, existing?.group);
    const variant = split.variant;
    const workstreamId = a.workstreamId ?? existing?.workstreamId ?? this.workstreamFor(agent, a.page ?? existing?.page, group);
    const art: Artifact = {
      id: existing?.id ?? a.id ?? newId("art"),
      ts: existing?.ts ?? Date.now(),
      updatedAt: Date.now(),
      kind: a.kind,
      stage: a.stage ?? existing?.stage ?? (a.kind === "frame" ? "mockup" : "built"),
      agentId: a.agentId ?? existing?.agentId ?? null,
      agentName: agent?.name ?? a.agentName ?? existing?.agentName ?? "",
      title,
      group,
      variant: a.variant ?? variant,
      platform: a.platform ?? existing?.platform ?? agent?.platform ?? null,
      nodeId: a.nodeId ?? existing?.nodeId ?? null,
      url: a.url ?? existing?.url ?? null,
      image: a.image ?? existing?.image ?? null,
      width: a.width ?? existing?.width ?? null,
      height: a.height ?? existing?.height ?? null,
      workstreamId,
      note: a.note ?? existing?.note ?? "",
      page: a.page ?? existing?.page,
      ...(a.version ?? existing?.version ? { version: a.version ?? existing?.version } : {}),
      ...(a.versions ?? existing?.versions ? { versions: a.versions ?? existing?.versions } : {}),
      directiveId: a.directiveId ?? existing?.directiveId ?? (existing ? null : this.workingOn(agent?.id)),
    };
    this.store.put("artifacts", art);
    if (!existing && opts.announce !== false) {
      this.store.addEvent({
        kind: "artifact",
        authorType: art.agentId ? "agent" : "system",
        authorId: art.agentId,
        authorName: art.agentName || "Canvas",
        text: `${art.stage === "built" ? "Built" : "Mockup"}: ${art.title}${art.note ? `. ${art.note}` : ""}`,
        relevance: "work",
        workstreamId: art.workstreamId,
        data: { artifactId: art.id, kind: art.kind, stage: art.stage },
      });
    }
    return art;
  }

  /** Saves what someone said about an item right after it went up (4.2). Repeats of one line don't add up. */
  addReaction(artifactId: string, ev: { id: number; ts: number; text: string; authorName: string }) {
    const art = this.store.get("artifacts", artifactId);
    if (!art || art.reactions?.some((r) => r.eventId === ev.id)) return;
    this.store.put("artifacts", { ...art, reactions: [...(art.reactions ?? []), { by: ev.authorName, text: ev.text, at: ev.ts, eventId: ev.id }].slice(-30) });
  }

  /** The workstream an item belongs to: its agent's active one (the one named like the item's group when there are several), or the canvas page named after one. */
  private workstreamFor(agent: Agent | undefined, page: string | undefined, group: string): string | null {
    const streams = this.store.all("workstreams");
    if (agent) {
      const mine = streams.filter((w) => w.ownerAgentId === agent.id && w.status === "active").sort((x, y) => y.updatedAt - x.updatedAt);
      return (mine.find((w) => groupKey(w.title) === groupKey(group)) ?? mine[0])?.id ?? null;
    }
    return page ? (streams.find((w) => groupKey(w.title) === groupKey(page))?.id ?? null) : null;
  }

  /** One spelling per group: "Mist Mobile rep mode" joins an existing "Mist Mobile rep"; a group named like a workstream takes its title. */
  private canonGroup(group: string, current?: string): string {
    const g = group.replace(/\s+/g, " ").trim();
    if (current && groupKey(current) === groupKey(g)) return current;
    const key = groupKey(g);
    if (!key) return g;
    const seen = this.artifacts().find((x) => x.group && groupKey(x.group) === key);
    return seen?.group ?? this.store.all("workstreams").find((w) => groupKey(w.title) === key)?.title ?? g;
  }

  /**
   * A new build of a screen that's already in the room becomes the next version of that item (3.5): the
   * newest image shows, the earlier ones stay in `versions`, and anything pointing at the id (the screen,
   * a pin) now shows the new build. The earlier build is the one `replaces` names, or the same agent's
   * item of the same stage with the same title once "(built)" and version marks are dropped.
   * `replaces` that names nothing usable throws, so the agent hears it.
   */
  upsertVersion(a: Partial<Artifact> & { kind: Artifact["kind"]; title: string }, replaces?: string): Artifact {
    let prior: Artifact | undefined;
    if (replaces) {
      prior = this.store.get("artifacts", replaces);
      if (!prior) throw new Error(`No artifact ${replaces} to replace. Use jam_artifacts for ids.`);
      if (prior.agentId !== (a.agentId ?? null)) throw new Error("That item belongs to someone else's agent; post yours as a new item.");
    } else if (a.kind === "screenshot" || a.kind === "html") {
      const key = buildKey(tidyTitle(a.title));
      prior = this.artifacts().find((x) => x.kind === a.kind && x.agentId === (a.agentId ?? null) && x.stage === (a.stage ?? "built") && buildKey(tidyTitle(x.title)) === key);
    }
    if (!prior) return this.upsertArtifact(a);
    const v = prior.version ?? 1;
    const earlier: ArtifactVersion = { version: v, at: prior.updatedAt, title: prior.title, image: prior.image, url: prior.url, width: prior.width, height: prior.height, note: prior.note };
    const art = this.upsertArtifact({ ...a, id: prior.id, title: prior.title, version: v + 1, versions: [...(prior.versions ?? []), earlier].slice(-20) });
    this.store.addEvent({
      kind: "artifact",
      authorType: art.agentId ? "agent" : "system",
      authorId: art.agentId,
      authorName: art.agentName || "Canvas",
      text: `New version (v${v + 1}): ${art.title}${art.note ? `. ${art.note}` : ""}`,
      relevance: "work",
      workstreamId: art.workstreamId,
      data: { artifactId: art.id, kind: art.kind, stage: art.stage, version: v + 1 },
    });
    return art;
  }

  // ---- screen and camera shares ----

  shares(): Share[] {
    return this.store.all("shares").filter((x) => x.status === "live" || (x.status === "requested" && Date.now() - x.startedAt < 120_000)).sort((a, b) => a.startedAt - b.startedAt);
  }

  devicesOf(personId: string) {
    return this.store.all("devices").filter((d) => d.personId === personId && d.kind === "client" && Date.now() - d.lastSeen < 10 * 60_000);
  }

  /**
   * The host asks someone to share; their JamSesh window asks them first. A person has at most one
   * share of each kind: asking again returns the pending request or the live share instead of
   * starting a second capture.
   */
  requestShare(personId: string, kind: Share["kind"], reason: string, by: string): Share | null {
    const person = this.person(personId);
    const devices = this.devicesOf(personId);
    if (!person || !devices.length) return null;
    const existing = this.shares().find((x) => x.personId === personId && x.kind === kind);
    if (existing) return existing;
    const share: Share = { id: newId("sh"), deviceId: devices[0].id, personId, personName: person.name, kind, label: `${person.name}'s ${kind}`, status: "requested", reason, startedAt: Date.now() };
    this.store.put("shares", share);
    bus.send({ type: "share-request", shareId: share.id, deviceIds: devices.map((d) => d.id), kind, reason, by });
    return share;
  }

  /** A device starts sharing, on its own or in answer to a request. */
  startShare(deviceId: string, kind: Share["kind"], shareId?: string, label?: string): Share {
    const device = this.store.get("devices", deviceId);
    const person = this.person(device?.personId);
    // An id is this device's own share, or a request made to its person; any other id starts a new share.
    const found = shareId ? this.store.get("shares", shareId) : undefined;
    const existing = found && (found.deviceId === deviceId ? found.status !== "requested" || found.personId === (person?.id ?? null) : found.status === "requested" && !!person && found.personId === person.id) ? found : undefined;
    const id = existing?.id ?? newId("sh");
    // One share of a kind per person (per device for a device nobody claimed): an earlier one, from
    // this window or another, is replaced, and requests for the same thing still waiting are answered.
    for (const old of this.shares()) {
      if (old.id === id || old.kind !== kind) continue;
      if (old.status === "live" && (old.deviceId === deviceId || (person && old.personId === person.id))) {
        this.endShare(old.id);
        bus.send({ type: "share-ended", shareId: old.id, deviceId: old.deviceId, text: "" });
      } else if (old.status === "requested" && person && old.personId === person.id) this.endShare(old.id);
    }
    const share: Share = {
      id,
      deviceId,
      personId: person?.id ?? null,
      personName: person?.name ?? device?.label ?? "Someone",
      kind,
      label: label || `${person?.name ?? "Someone"}'s ${kind}`,
      status: "live",
      reason: existing?.reason ?? "",
      startedAt: Date.now(),
    };
    this.store.put("shares", share);
    this.store.addEvent({ kind: "system", authorType: "person", authorId: share.personId, authorName: share.personName, text: `${share.personName} is sharing their ${kind}.`, data: { shareId: share.id } });
    // Nothing may ever place it: the first sweep comes when its placement window closes.
    if (!this.shareSweep) this.scheduleShareSweep(Session.SHARE_PLACE_MS + 50);
    return share;
  }

  /** What each screen showed just before a share took it over, so the share's end can give it back. */
  private beforeShare = new Map<string, Stage>();

  /** Remember what the main screen shows now, ahead of a new share taking it over. */
  rememberStageFor(shareId: string) {
    if (this.beforeShare.has(shareId)) return;
    const st = this.stage();
    const tiles = st.mode === "layout" ? st.layout?.tiles ?? [] : [];
    if (tiles.length && tiles.every((t) => t.kind === "screen")) {
      // Another share is all the screen shows: this one gives back what that one was hiding.
      for (const t of tiles) {
        const prior = t.kind === "screen" ? this.beforeShare.get(t.shareId) : undefined;
        if (prior) return void this.beforeShare.set(shareId, prior);
      }
    }
    this.beforeShare.set(shareId, st);
  }

  endShare(id: string, status: Share["status"] = "ended") {
    const sh = this.store.get("shares", id);
    if (!sh) return;
    this.store.put("shares", { ...sh, status });
    this.sharesShown.delete(id);
    const before = this.beforeShare.get(id);
    this.beforeShare.delete(id);
    const hosts = ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))];
    for (const screen of hosts) {
      const st = this.stage(screen);
      if (st.mode === "layout" && st.layout?.tiles.some((t) => t.kind === "screen" && t.shareId === id)) {
        const tiles = st.layout.tiles.filter((t) => !(t.kind === "screen" && t.shareId === id));
        // When the share was all the screen showed, the screen goes back to what it showed before.
        const back = !tiles.length && screen === "main" && before && !(before.mode === "layout" && before.layout?.tiles.some((t) => t.kind === "screen" && t.shareId === id)) ? before : null;
        // A lock still held when the share ends stays with what comes back (the owner's share over their own cast, SPEC 10.5).
        // One its owner let go of during the share stays gone.
        this.setStage(tiles.length ? { ...st, layout: { tiles } } : back ? back : { mode: "board" }, back?.by ?? "JamSesh", screen, { override: true, keepLock: st.lock });
      }
    }
  }

  // ---- shares that left the big screen ----

  private shareSweep: ReturnType<typeof setTimeout> | null = null;
  /** Shares a host screen has shown at some point: they had their placement, and the sharer hears why theirs stopped. */
  private sharesShown = new Set<string>();
  /** Long enough for the brain to place a brand-new share before it counts as "not on screen". */
  static SHARE_PLACE_MS = 60_000;
  static SHARE_GRACE_MS = 5_000;

  private shownShareIds(): Set<string> {
    const ids = new Set<string>();
    const screens = ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))];
    for (const screen of screens) {
      const st = this.stage(screen);
      if (st.mode === "layout") for (const t of st.layout?.tiles ?? []) if (t.kind === "screen") ids.add(t.shareId);
    }
    return ids;
  }

  /** After any stage change: a live share that no host screen shows stops, once the grace period passes. */
  private scheduleShareSweep(delay = Session.SHARE_GRACE_MS) {
    if (this.shareSweep) clearTimeout(this.shareSweep);
    this.shareSweep = setTimeout(() => {
      try {
        this.sweepShares();
      } catch (e) {
        console.error("shares: sweep failed:", e instanceof Error ? e.message : e); // a timer must never take the hub down
      }
    }, delay);
    this.shareSweep.unref?.();
  }

  /** Every stage change: a share any host screen shows now has been placed, however briefly. */
  private noteSharesShown() {
    for (const id of this.shownShareIds()) this.sharesShown.add(id);
  }

  sweepShares() {
    this.shareSweep = null;
    const shown = this.shownShareIds();
    for (const id of shown) this.sharesShown.add(id);
    let recheck = 0;
    for (const sh of this.shares()) {
      if (sh.status !== "live" || shown.has(sh.id)) continue;
      // Only a share that was never shown gets the placement window; one taken down had its grace already.
      const young = this.sharesShown.has(sh.id) ? 0 : Session.SHARE_PLACE_MS - (Date.now() - sh.startedAt);
      if (young > 0) {
        recheck = Math.max(recheck, young);
        continue;
      }
      const text = this.sharesShown.has(sh.id) ? `Your ${sh.kind} left the big screen, so sharing stopped.` : `Your ${sh.kind} wasn't put on the big screen, so sharing stopped.`;
      this.endShare(sh.id);
      bus.send({ type: "share-ended", shareId: sh.id, deviceId: sh.deviceId, text });
    }
    if (recheck) this.scheduleShareSweep(recheck + 50);
  }

  // ---- annotations ----

  annotations(): Annotation[] {
    return this.store.all("annotations").filter((a) => a.status !== "done").sort((a, b) => a.ts - b.ts);
  }

  addAnnotation(a: Omit<Annotation, "id" | "ts" | "status" | "promptEventId" | "authorName"> & { authorName?: string }): Annotation {
    const person = this.person(a.personId);
    const ann: Annotation = { ...a, id: newId("pin"), ts: Date.now(), authorName: person?.name ?? a.authorName ?? "Someone", status: "open", promptEventId: null };
    this.store.put("annotations", ann);
    return ann;
  }

  // ---- curated context ----

  /** The session brief: its sections in full, and the short excerpt a joining agent gets. */
  brief() {
    return buildBrief(this);
  }

  /** Active facts first (newest first), then the latest resolved or superseded ones. */
  facts(): Fact[] {
    const all = this.store.all("facts").sort((a, b) => b.updatedAt - a.updatedAt);
    return [...all.filter((f) => f.status === "active"), ...all.filter((f) => f.status !== "active").slice(0, 30)];
  }

  /** An overheard task or an agent's task waits on the Tasks board (4.1). Null when it was empty or is already waiting. */
  proposeTask(p: TaskProposal) {
    return this.board.proposeTask(p);
  }

  /** Context nobody has approved (overheard, reported by an agent, from a document) waits on the Tasks board. Null when it's already known. */
  proposeContext(p: ContextProposal) {
    return this.board.proposeContext(p);
  }

  /** What agents shipped, newest first: their routine notices, which never become cards or facts. */
  changelog(limit = 50): JamEvent[] {
    return this.store
      .recentEvents({ kinds: ["update"], limit: 600 })
      .filter((e) => e.authorType === "agent" && ["shipped", "done"].includes(String(e.data?.updateKind)))
      .slice(-limit)
      .reverse();
  }

  // ---- saved layouts ----

  savedLayouts(): Record<string, Stage> {
    return this.store.setting<Record<string, Stage>>("layouts", {});
  }

  saveLayout(name: string, stage = this.stage()) {
    const all = { ...this.savedLayouts(), [name.trim()]: { ...stage, pinned: false } };
    this.store.setSetting("layouts", all);
    bus.changed("settings");
    return all;
  }

  // ---- people ----

  setPhoto(personId: string, url: string | null) {
    return this.store.patch("people", personId, { photo: url });
  }

  // ---- dev servers ----

  devservers(): DevServer[] {
    return this.store.all("devservers");
  }

  // ---- stage ----

  // ---- big screens: "main", plus one per display on a user-less host ----

  private bigScreens = new Map<string, Omit<ScreenInfo, "stage" | "name" | "role">>();
  /** What the host app says each screen is: its name and role (setting "screenNames", by id). */
  private screenNames(): Record<string, { name: string; role: "main" | "extra" }> {
    return this.store.setting("screenNames", {});
  }

  /** The host app tells the hub the room's screens, named as the person set them up ("Left TV"). */
  configureScreens(list: { id: string; name: string; role?: string }[]) {
    const next: Record<string, { name: string; role: "main" | "extra" }> = {};
    for (const sc of list) {
      if (!/^[\w-]{1,32}$/.test(String(sc?.id))) continue;
      const name = String(sc.name ?? "").trim().slice(0, 40);
      next[sc.id] = { name: name || (sc.id === "main" ? "Main screen" : `Screen ${sc.id.replace(/\D/g, "") || sc.id}`), role: sc.id === "main" ? "main" : "extra" };
    }
    if (JSON.stringify(next) === JSON.stringify(this.screenNames())) return;
    this.store.setSetting("screenNames", next);
    bus.changed("screens");
  }

  /** A screen by its id or by what it's called ("left tv", "the Left TV"); undefined when nothing fits. */
  findScreen(ref?: string): ScreenInfo | undefined {
    const want = (ref ?? "").toLowerCase().replace(/^the\s+/, "").trim();
    if (!want) return undefined;
    const all = this.screens();
    const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return all.find((sc) => sc.id === want) ?? all.find((sc) => plain(sc.name) === plain(want)) ?? all.find((sc) => plain(sc.name).includes(plain(want)) || plain(want).includes(plain(sc.name)));
  }

  private screenReverts = new Map<string, ReturnType<typeof setTimeout>>();

  /** The hub is stopping: no timer of this session touches its store again (it may be closed or deleted next). */
  stop() {
    for (const t of [this.lockSweep, this.stageRevert, this.shareSweep, ...this.screenReverts.values()]) if (t) clearTimeout(t);
    this.screenReverts.clear();
    this.lockSweep = this.stageRevert = this.shareSweep = null;
  }

  /** A big-screen window reported its size; windows that stop reporting drop off after 3 minutes. */
  reportScreen(id: string, info: Omit<ScreenInfo, "id" | "stage" | "name" | "role">) {
    const known = this.bigScreens.has(id);
    this.bigScreens.set(id, { id, ...info });
    if (!known) bus.changed("screens");
  }

  /** A big-screen window closed (the host app says so): it stops being a place to show things now,
   *  not 3 minutes later. The main screen always stays. */
  removeScreen(id: string) {
    if (id === "main" || !this.bigScreens.delete(id)) return;
    clearTimeout(this.screenReverts.get(id));
    this.screenReverts.delete(id);
    bus.changed("screens");
  }

  screens(): ScreenInfo[] {
    const now = Date.now();
    return [...this.bigScreens.values()]
      .filter((sc) => now - sc.at < 3 * 60_000)
      .sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : a.screenX - b.screenX))
      .map((sc, i, all) => {
        const known = this.screenNames()[sc.id];
        // With no names from the host app, a screen is called by where it sits (left to right).
        const name = known?.name ?? (sc.id === "main" ? "Main screen" : `Screen ${i + 1}`);
        return { ...sc, name, role: sc.id === "main" ? ("main" as const) : ("extra" as const), stage: this.stage(sc.id) };
      });
  }

  stage(screen = "main"): Stage {
    if (screen !== "main") return this.store.setting<Record<string, Stage>>("screenStages", {})[screen] ?? { mode: "board", title: "", caption: "", items: [], pinned: false, since: Date.now(), by: "JamSesh" };
    return this.store.setting<Stage>("stage", {
      mode: "welcome",
      title: "",
      caption: "",
      items: [],
      pinned: false,
      since: Date.now(),
      by: "JamSesh",
    });
  }

  /** How long a brought-up screen stays before the board comes back (tests shorten it). */
  static STAGE_REVERT_MS = 6 * 60_000;

  /** Whether a stage goes back to the board by itself. Not while it shows a live share (the share's end gives the screen back what it hid, and a timer would cut the share first), nor while a person holds it. */
  private revertsToBoard(stage: Stage) {
    if (stage.pinned || stage.lock || stage.mode === "board" || stage.mode === "welcome") return false;
    if (stage.mode === "layout" && stage.layout?.tiles.some((t) => t.kind === "screen" && this.store.get("shares", t.shareId)?.status === "live")) return false;
    return true;
  }

  /**
   * Expand one tile of a screen's stage to fill the presentation area, or collapse back (`key` null). In place: the stage keeps its age,
   * its history entry and its lock, and a lock doesn't refuse it, since looking closer isn't replacing what the owner put up. Someone is
   * looking at it, so a stage that returns to the board by itself starts its wait again.
   */
  expandTile(key: string | null, screen = "main"): Stage {
    const cur = this.stage(screen);
    const tile = typeof key === "string" ? key.trim().slice(0, 80) : "";
    if (cur.mode === "join" || (tile ? cur.expanded === tile : !cur.expanded)) return cur;
    const { expanded: _drop, ...rest } = cur;
    const stage: Stage = tile ? { ...rest, expanded: tile } : rest;
    this.commitStage(stage, screen);
    return stage;
  }

  /** The keys of the tiles a screen's stage shows, in the order the screen draws them (the web's `stageTiles` keeps the same rules). */
  stageTileKeys(screen = "main"): { key: string; artifactId?: string }[] {
    const st = this.stage(screen);
    const arts = this.artifacts();
    const known = new Set(arts.map((a) => a.id));
    const byId = (ids: string[]) => ids.filter((id) => known.has(id)).map((id) => ({ key: id, artifactId: id }));
    switch (st.mode) {
      case "welcome":
      case "board":
        return arts.slice(0, 5).map((a) => ({ key: a.id, artifactId: a.id }));
      case "spotlight":
        return byId(st.items);
      case "compare":
        return byId(st.items).sort((x, y) => {
          const [p, q] = [arts.find((a) => a.id === x.key)!, arts.find((a) => a.id === y.key)!];
          return (p.variant || p.title).localeCompare(q.variant || q.title);
        });
      case "parity":
        return byId((st.columns?.length ? st.columns : [{ label: "", items: st.items }]).flatMap((c) => c.items));
      case "layout":
        return (st.layout?.tiles ?? []).map((t, i) => ({ key: `t${i}`, artifactId: t.kind === "artifact" ? t.artifactId : undefined }));
      default:
        return [];
    }
  }

  /** Expand "the second one" or a named artifact's tile, or collapse (neither given). Says why when it can't. */
  expandWhich(ref: { artifactId?: string; position?: number }, screen = "main"): { ok: true; stage: Stage } | { ok: false; error: string } {
    if (ref.artifactId === undefined && ref.position === undefined) return { ok: true, stage: this.expandTile(null, screen) };
    const tiles = this.stageTileKeys(screen);
    if (!tiles.length) return { ok: false, error: "The screen isn't showing tiles to expand." };
    const hit = ref.artifactId !== undefined ? tiles.find((t) => t.artifactId === ref.artifactId) : tiles[Math.trunc(ref.position ?? 0) - 1];
    if (!hit) return { ok: false, error: ref.artifactId !== undefined ? "That isn't on the screen right now." : `The screen has ${tiles.length} tile${tiles.length === 1 ? "" : "s"}.` };
    return { ok: true, stage: this.expandTile(hit.key, screen) };
  }

  /**
   * Put something on a screen. A screen a person locked refuses everything except people (and `override`,
   * for the hub's own housekeeping: a share ending, a request the owner approved): the stage comes back
   * unchanged, and callers that want to explain why ask `lockOf` first. A person's cast takes the lock.
   */
  setStage(next: Partial<Stage> & { mode: Stage["mode"] }, by: string, screen = "main", opts: StageOpts = {}) {
    const cur = this.stage(screen);
    if (!opts.person && !opts.override && this.lockOf(screen)) return cur;
    const now = Date.now();
    const quiet = next.mode === "board" || next.mode === "welcome";
    const lock: StageLock | undefined = quiet ? undefined : opts.keepLock ?? (opts.person && !opts.noLock ? { by: opts.person.name, personId: opts.person.id, since: now, lastActive: now } : undefined);
    const { lock: _drop, ...rest } = next;
    const stage: Stage = { title: "", caption: "", items: [], pinned: false, ...rest, since: now, by, screenId: screen, ...(lock ? { lock } : {}) };
    this.commitStage(stage, screen);
    this.recordHistory(stage, screen);
    return stage;
  }

  private commitStage(stage: Stage, screen: string) {
    this.expireAsksFor(screen, stage.lock);
    if (screen !== "main") {
      this.store.setSetting("screenStages", { ...this.store.setting<Record<string, Stage>>("screenStages", {}), [screen]: stage });
      bus.changed("screens");
      this.noteSharesShown();
      this.scheduleShareSweep();
      clearTimeout(this.screenReverts.get(screen));
      if (this.revertsToBoard(stage))
        this.screenReverts.set(screen, setTimeout(() => this.setStage({ mode: "board" }, "JamSesh", screen, { override: true }), Session.STAGE_REVERT_MS));
      return;
    }
    this.store.setSetting("stage", stage);
    bus.send({ type: "stage", stage });
    this.noteSharesShown();
    this.scheduleShareSweep();
    if (this.bigScreens.size > 1) bus.changed("screens");
    if (this.stageRevert) clearTimeout(this.stageRevert);
    this.stageRevert = null;
    // Anything the brain brought up returns to the live board after a while.
    if (this.revertsToBoard(stage)) this.stageRevert = setTimeout(() => this.setStage({ mode: "board" }, "JamSesh", "main", { override: true }), Session.STAGE_REVERT_MS);
  }

  // ---- locks: what a person puts up stays up (3.1) ----

  /** A lock this old makes an agent's request ask its owner instead of just waiting. */
  static LOCK_ASK_MS = 5 * 60_000;
  /** A lock held by no one in particular lets go after this long untouched. A person's lock stays while they're here. */
  static LOCK_IDLE_MS = 20 * 60_000;
  /** Gone from the room: no window of theirs has checked in for this long. */
  static LOCK_GONE_MS = 10 * 60_000;
  /** Whether a window has a live connection (the HTTP layer supplies it). */
  deviceOnline: (deviceId: string) => boolean = () => false;

  /** The lock on a screen, or null. A lock whose owner left or went quiet is let go on the way. */
  lockOf(screen = "main"): StageLock | null {
    const lock = this.stage(screen).lock;
    if (!lock) return null;
    if (this.lockLapsed(lock)) {
      this.unlockStage(screen);
      return null;
    }
    return lock;
  }

  private lockLapsed(lock: StageLock) {
    const now = Date.now();
    // Someone with no person to watch (the host before anyone picked who they are) can't be seen to leave: only quiet lets go.
    if (!lock.personId) return now - lock.lastActive >= Session.LOCK_IDLE_MS;
    if (!this.person(lock.personId)) return true;
    // The person at the host also has the host's own window, which carries no person of its own.
    const atHost = lock.personId === this.store.setting<string>("hostPersonId", "");
    const windows = this.store.all("devices").filter((d) => d.personId === lock.personId || (atHost && d.kind === "host"));
    // No window of theirs on record (the device list was cleared, or they never had one here): quiet lets go.
    if (!windows.length) return now - lock.lastActive >= Session.LOCK_GONE_MS;
    // A window with a live connection is here, however long since it last reported itself.
    return windows.every((d) => !this.deviceOnline(d.id) && now - d.lastSeen > Session.LOCK_GONE_MS);
  }

  /** Lets go of a screen's lock; what it shows stays. It returns to the board on the usual timer from here. */
  unlockStage(screen = "main") {
    const cur = this.stage(screen);
    if (!cur.lock) return;
    const { lock: _drop, ...rest } = cur;
    this.commitStage(rest, screen);
  }

  /** The owner did something with their screen: it counts as activity. */
  touchLock(screen = "main") {
    const cur = this.stage(screen);
    if (!cur.lock) return;
    this.commitStage({ ...cur, lock: { ...cur.lock, lastActive: Date.now() } }, screen);
  }

  /** Locks whose owners left or went quiet let go even when nobody asks (a timer runs this). */
  sweepLocks() {
    for (const screen of ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))]) this.lockOf(screen);
  }

  // ---- ready to show: agents' items wait while a screen is locked ----

  readyToShow(): ReadyItem[] {
    const cutoff = Date.now() - 60 * 60_000;
    return this.store.setting<ReadyItem[]>("readyToShow", []).filter((r) => r.at > cutoff);
  }

  /** An agent's item waits for the screen. Asking again for the same thing replaces the earlier entry. */
  queueReady(item: Omit<ReadyItem, "id" | "at">): ReadyItem {
    const ready: ReadyItem = { ...item, id: newId("rdy"), at: Date.now() };
    const kept = this.readyToShow().filter((r) => !(r.agentId === item.agentId && r.screen === item.screen && r.label === item.label));
    this.store.setSetting("readyToShow", [...kept, ready].slice(-12));
    bus.changed("readyToShow");
    return ready;
  }

  /** Puts a queued item on its screen. A person showing it takes the screen's lock; with no person (the owner said yes) it goes up unlocked. */
  showReady(id: string, person?: { id: string | null; name: string }): Stage | null {
    const item = this.readyToShow().find((r) => r.id === id);
    if (!item) return null;
    this.dismissReady(id);
    return person ? this.setStage(item.stage, person.name, item.screen, { person }) : this.setStage(item.stage, item.agentName, item.screen, { override: true });
  }

  dismissReady(id: string) {
    this.store.setSetting("readyToShow", this.readyToShow().filter((r) => r.id !== id));
    bus.changed("readyToShow");
  }

  // ---- asking the lock's owner ----

  /** An unanswered question goes stale after this long; the item stays queued. */
  static ASK_TTL_MS = 5 * 60_000;
  /** After a no, an agent's request doesn't ask again for this long. */
  static ASK_COOLDOWN_MS = 10 * 60_000;
  onShowRequest: ((r: ShowRequest) => void) | null = null;

  showRequests(): ShowRequest[] {
    const now = Date.now();
    return this.store.setting<ShowRequest[]>("showRequests", []).map((r) => (r.status === "pending" && now - r.at >= Session.ASK_TTL_MS ? { ...r, status: "expired" as const } : r));
  }

  /**
   * An agent wants a locked screen. Once the lock is old enough the owner is asked, on screen and out
   * loud; one question at a time per screen, and none right after a no.
   */
  askOwner(item: ReadyItem): ShowRequest | null {
    const lock = this.lockOf(item.screen);
    if (!lock || Date.now() - lock.since < Session.LOCK_ASK_MS) return null;
    const all = this.showRequests();
    if (all.some((r) => r.screen === item.screen && r.status === "pending")) return null;
    if (all.some((r) => r.screen === item.screen && r.status === "denied" && Date.now() - r.at < Session.ASK_COOLDOWN_MS)) return null;
    const agent = this.agent(item.agentId);
    const req: ShowRequest = {
      id: newId("ask"),
      at: Date.now(),
      screen: item.screen,
      ownerId: lock.personId,
      ownerName: lock.by,
      lockSince: lock.since,
      agentName: item.agentName,
      agentOwner: agent?.ownerName ?? "",
      label: item.label,
      readyId: item.id,
      status: "pending",
    };
    this.store.setSetting("showRequests", [...all.filter((r) => Date.now() - r.at < 60 * 60_000), req].slice(-20));
    this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: `${lock.by} has the big screen locked. Asked whether ${item.agentName}'s ${item.label} can go up. Say "yes, show it" or "keep mine up".`, relevance: "work", data: { showRequest: req.id } });
    bus.changed("showRequests");
    this.onShowRequest?.(req);
    return req;
  }

  /**
   * The lock's owner answered. Yes puts the item up (unlocked); no keeps their screen, and the item stays in the queue.
   * The answer is about one lock: once the screen's lock changed (unlocked, or someone else's cast), the question has
   * expired and a late yes does nothing, nor does a yes for an item no longer waiting. The item stays queued either way.
   */
  answerShowRequest(id: string, approve: boolean, by: string): ShowRequest | null {
    const req = this.showRequests().find((r) => r.id === id);
    if (!req || req.status !== "pending") return null;
    const lock = this.lockOf(req.screen);
    const waiting = this.readyToShow().some((r) => r.id === req.readyId);
    if (!lock || lock.since !== req.lockSince || lock.personId !== req.ownerId || (approve && !waiting)) return this.expireShowRequest(req);
    const done: ShowRequest = { ...req, status: approve ? "approved" : "denied", decidedBy: by, at: approve ? req.at : Date.now() };
    this.store.setSetting("showRequests", this.showRequests().map((r) => (r.id === id ? done : r)));
    if (approve) this.showReady(req.readyId);
    else this.touchLock(req.screen);
    this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: approve ? `${by} said yes: ${req.agentName}'s ${req.label} is on the big screen.` : `${by} is keeping their screen up. ${req.agentName}'s ${req.label} waits in the queue.`, relevance: "work", data: { showRequest: id } });
    bus.changed("showRequests");
    return done;
  }

  private expireShowRequest(req: ShowRequest): ShowRequest {
    const gone: ShowRequest = { ...req, status: "expired" };
    this.store.setSetting("showRequests", this.showRequests().map((r) => (r.id === req.id ? gone : r)));
    bus.changed("showRequests");
    return gone;
  }

  /** A screen's lock changed: questions about the lock it had are over (their items stay queued). */
  private expireAsksFor(screen: string, lock: StageLock | undefined) {
    for (const r of this.store.setting<ShowRequest[]>("showRequests", []))
      if (r.screen === screen && r.status === "pending" && (!lock || lock.since !== r.lockSince)) this.expireShowRequest(r);
  }

  // ---- history: what each screen showed (3.6) ----

  static HISTORY_MAX = 20;

  /** What a screen showed recently, newest first, with who put it up. */
  stageHistory(screen?: string): Record<string, StageHistoryEntry[]> {
    const all = this.store.setting<Record<string, StageHistoryEntry[]>>("stageHistory", {});
    return screen ? { [screen]: all[screen] ?? [] } : all;
  }

  private recordHistory(stage: Stage, screen: string) {
    if (stage.mode === "board" || stage.mode === "welcome" || stage.mode === "join") return;
    // A share ends on its own, so a screen showing one can't be brought back.
    if (stage.mode === "layout" && stage.layout?.tiles.some((t) => t.kind === "screen")) return;
    const { lock: _l, since: _s, by: _b, ...snap } = stage;
    const sig = JSON.stringify(snap);
    const all = this.stageHistory();
    const mine = (all[screen] ?? []).filter((e) => JSON.stringify(e.stage) !== sig);
    const entry: StageHistoryEntry = { id: newId("his"), screen, at: stage.since, by: stage.by, label: stageLabel(stage, (id) => this.store.get("artifacts", id)?.title), stage: snap };
    this.store.setSetting("stageHistory", { ...all, [screen]: [entry, ...mine].slice(0, Session.HISTORY_MAX) });
    bus.changed("stageHistory");
  }

  /** What a screen showed before what it shows now, newest first. */
  previousScreens(screen = "main"): StageHistoryEntry[] {
    const all = this.stageHistory(screen)[screen] ?? [];
    return all[0]?.at === this.stage(screen).since ? all.slice(1) : all;
  }

  /** The newest earlier screen a person put up, for "bring back what Jonathan had up". */
  historyBy(name: string, screen = "main"): StageHistoryEntry | undefined {
    const want = name.trim().toLowerCase();
    return this.previousScreens(screen).find((e) => e.by.toLowerCase().includes(want));
  }

  /** Brings an earlier screen back. A person's tap takes the lock; anyone else is held off by one. */
  restoreHistory(id: string, screen: string, person?: { id: string | null; name: string }, by = "JamSesh"): Stage | null {
    const entry = (this.stageHistory(screen)[screen] ?? []).find((e) => e.id === id);
    if (!entry) return null;
    return this.setStage({ ...entry.stage, pinned: false }, person?.name ?? by, screen, person ? { person } : {});
  }
}

/** How a setStage call says who is acting: a person (who may replace a lock and takes one) or the hub's own upkeep. */
export interface StageOpts {
  person?: { id: string | null; name: string };
  /** Housekeeping that must happen whatever is locked: a share ending, an approved request, a timer. */
  override?: boolean;
  /** A person's action that shouldn't hold the screen (a share they started has its own hold). */
  noLock?: boolean;
  /** The new stage keeps this lock: the owner's own share over their cast, and that cast coming back when it ends. */
  keepLock?: StageLock;
}

/** A few words for a stage, for the history strip and the ready queue. */
export function stageLabel(stage: Partial<Stage> & { mode: string }, titleOf: (id: string) => string | undefined = () => undefined): string {
  if (stage.title) return stage.title;
  const first = stage.items?.map(titleOf).find(Boolean);
  if (first) return stage.items!.length > 1 ? `${first} and ${stage.items!.length - 1} more` : first;
  if (stage.mode === "layout") return `${stage.layout?.tiles.length ?? 0} tiles`;
  return ({ spotlight: "Spotlight", compare: "Compare", parity: "Side by side", agents: "What everyone is doing", canvas: "The canvas", custom: "Custom view" } as Record<string, string>)[stage.mode] ?? stage.mode;
}

export function publicEvent(e: JamEvent): JamEvent {
  if (!e.data?.embedding) return e;
  const { embedding: _drop, ...data } = e.data;
  return { ...e, data };
}

/** An agent as the room sees it: its chat id is a transport handle (Claude Code's session id, an MCP session), never shown. */
export function publicAgent(a: Agent): Agent {
  if (!a.chatId) return a;
  const { chatId: _drop, ...rest } = a;
  return rest;
}

/** A folder as a person would say it: the home folder is ~. */
export function tildePath(p: string) {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

/** Compares paths the way macOS resolves them: /private/tmp is /tmp, ~ is home, no trailing slash. */
export function normalizePath(p: string) {
  return p
    .trim()
    .replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
    .replace(/^\/private\/(tmp|var|etc)(?=\/|$)/, "/$1")
    .replace(/\/+$/, "");
}

function makeCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join("");
}

export function weightForRole(role: string): number {
  const r = role.toLowerCase();
  if (/\b(ceo|founder|cpo|cto|chief|head of|vp|director)\b/.test(r)) return 3;
  if (/\b(lead|principal|staff|manager|pm)\b/.test(r) || /\bproduct (manager|owner|lead)\b/.test(r)) return 2;
  return 1;
}

export function shortRepo(repo: string) {
  return repo.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? repo;
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** A title with the marks of a rebuild dropped, so "Checkout (built)" and "Checkout v2" are the same screen as "Checkout". */
export function buildKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\[(]\s*(built|rebuilt|final|new|latest|updated|v\d+|version \d+|rev(ision)? ?\d+|\d+)\s*[\])]/g, " ")
    .replace(/\s*[-–—:·]\s*(built|rebuilt|final|new|latest|updated|v\d+|version \d+|rev(ision)? ?\d+)\s*$/g, " ")
    .replace(/\s+(built|rebuilt|v\d+|version \d+)\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that only restate what an item is, so "Mist Mobile rep" and "Mist Mobile rep mode" are one group. */
const GROUP_FILLER = /\s+(mode|page|pages|screen|screens|flow|view|views)$/;

/** A group compared without case, punctuation or filler words. */
export function groupKey(group: string): string {
  return group.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(GROUP_FILLER, "");
}

/**
 * Titles follow "<Workstream> / <Letter>: <idea>". On arrival: spacing is normalised, the letter is
 * capitalised, and a trailing "(built)" is dropped (the stage already says it). Anything else is left alone.
 */
export function tidyTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim().replace(/\s*[[(]\s*(built|rebuilt)\s*[\])]\s*$/i, "");
  const m = t.match(/^(.*?\S)\s*\/\s*([A-Za-z0-9]{1,2})\s*[:\-–—]\s*(.+)$/);
  return m && !/[/:]$/.test(m[1]) && !m[1].includes("://") ? `${m[1]} / ${m[2].toUpperCase()}: ${m[3]}` : t;
}

/** "Mobile nav / B: bottom tabs" → group "Mobile nav", variant "B". */
export function splitTitle(title: string): { group: string; variant: string } {
  const parts = title.split(/\s+\/\s+|\s+—\s+(?=[A-Z0-9]\b)/);
  if (parts.length < 2) return { group: title.trim(), variant: "" };
  const variant = parts.slice(1).join(" / ").trim();
  const letter = variant.match(/^(?:variant\s+|option\s+|direction\s+)?([A-Z0-9]{1,2})\b/i);
  return { group: parts[0].trim(), variant: letter ? letter[1].toUpperCase() : variant };
}
