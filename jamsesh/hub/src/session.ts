import { createHash } from "node:crypto";
// The session: people, devices, agents, workstreams, directives, artifacts and the
// stage. Every other part of the hub (brain, audio, canvas, MCP, HTTP) goes through it.
import { parseStage } from "./stageSchema";
import { brainNames, cleanNames, MAX_ALIASES, MAX_NAME, normName, sameName } from "./names";
import { bus } from "./bus";
import { silent } from "./brain/speech";
import { cleanVocabulary } from "./audio/vocabulary";
import { config, hostAddresses } from "./config";
import { affinity } from "./brain/affinity";
import { canonicalCwd, chatKey, isChatKey } from "./chatkey";
import { newId, PALETTE, Store } from "./store";
import type {
  EventKind,
  Agent,
  ActiveRecording,
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
 BuildRequest, ReadyItem, ScreenInfo, ShowRequest, StageHistoryEntry, StageLock, StageTileKey, FontsState, LiveApp } from "./types";

/** A message or update longer than this is stored once and others get a pointer. */
export const LONG_TEXT = 1200;

/** An agent quiet this long shows as offline (and its record can be taken over by a rejoin). */
export const AGENT_OFFLINE_MS = 20 * 60_000;
/** An open task nobody has acked or reported on for this long gets a nudge to its agent; after the grace the room is offered a reassignment. */
export const TASK_STALE_MS = 20 * 60_000;
export const TASK_OFFER_MS = 10 * 60_000;
/** Why product work for observers alone is refused (createDirective, the API, the brain's tools). */
export const ONLY_OBSERVERS = "Those agents only watch (observers), so nobody would do this. Pick a working agent.";
/** Why an observer can't take a workstream (jam_claim and Session.claim say the same). */
export const OBSERVER_CLAIM = "You joined as an observer, which only watches. Ask your person to rejoin you as a worker before you claim work.";
/** A person prompt this recent means the agent's own work was asked for. */
const ASKED_WINDOW_MS = 30 * 60_000;

export const DEFAULT_MODELS: Settings["models"] = {
  triage: "google/gemini-3.5-flash-lite",
  router: "anthropic/claude-sonnet-5.5",
  digest: "google/gemini-3.5-flash",
  speech: "microsoft/mai-voice-2.1",
  transcribe: "openai/gpt-transcribe",
};

/** The room's model choices for the roles that exist: a role that was dropped (an older room's "presenter") doesn't come back. */
function knownModels(stored: Partial<Settings["models"]>): Settings["models"] {
  const merged: Record<string, string> = { ...DEFAULT_MODELS, ...stored };
  return Object.fromEntries(Object.keys(DEFAULT_MODELS).map((k) => [k, merged[k]])) as Settings["models"];
}

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
  onDirective: ((d: Directive) => void) | null = null;
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
    this.migrateChatKeys();
    // Agents outlive a hub restart: they reconnect on their next call, and directives wait in their inbox.
    for (const a of store.all("agents")) if (a.status !== "offline") store.put("agents", { ...a, status: "idle", canvas: "none" }, false);
    for (const d of store.all("devices")) store.put("devices", { ...d, micOn: false, level: 0 }, false);
    // Nobody is still sharing after a restart: end the shares and take their tiles off the stage.
    this.reconcileShares();
    // The stage's timer died with the old process: a brought-up screen still returns to the board.
    this.armRevert("main", this.stage(), 1000);
    for (const id of Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))) this.armRevert(id, this.stage(id), 1000);
    // A lock whose owner left lets go without anyone asking.
    this.lockSweep = setInterval(() => this.sweepLocks(), 30_000);
    this.lockSweep.unref?.();
    bus.resolver = (key) => this.resolve(key);
    // A stage saved before the last stop may point at a tile whose artifact is gone; and when artifacts change later, the same check.
    this.dropDeadExpanded();
    this.offArtifacts = bus.on((m: any) => {
      if (m.type === "patch" && m.key === "artifacts") this.dropDeadExpanded();
    });
  }

  /**
   * Chats without an id of their own used to be keyed by their readable `harness:machine:folder`, cut at 300
   * characters, with the folder as typed. When the store opens, each such record and removal gets the key it
   * would get now, from its stored harness, machine and folder (the real path where this computer can see it),
   * so only current keys are ever compared. A record that doesn't store those is left as it is: it matches
   * nothing, and in particular never anything by a shared prefix.
   */
  private migrateChatKeys() {
    const keyed = (h: string | undefined): h is string => !!h && h !== "claude-code";
    const redo = (harness: string | undefined, machine: string | undefined, cwd: string | undefined) => {
      if (!keyed(harness) || !machine || !cwd) return null;
      const folder = canonicalCwd(cwd, machine === "host");
      return folder ? { folder, key: chatKey(harness, machine, folder) } : null;
    };
    // A folder is compared as one spelling for every harness, so a removal holds for the whole folder.
    for (const a of this.store.all("agents")) {
      if (a.harness === "claude-code" && a.machine && a.cwd) {
        const folder = canonicalCwd(a.cwd, a.machine === "host");
        if (folder && folder !== a.cwd) this.store.put("agents", { ...a, cwd: folder }, false);
        continue;
      }
      if (!keyed(a.harness) || !a.chatId || isChatKey(a.chatId, a.harness)) continue;
      const n = redo(a.harness, a.machine, a.cwd);
      if (n) this.store.put("agents", { ...a, chatId: n.key, cwd: n.folder }, false);
    }
    const removed = this.removedChats();
    let changed = false;
    const next = removed.map((r) => {
      if (r.harness === "claude-code" && r.machine && r.cwd) {
        const folder = canonicalCwd(r.cwd, r.machine === "host");
        if (folder && folder !== r.cwd) {
          changed = true;
          return { ...r, cwd: folder };
        }
        return r;
      }
      if (!keyed(r.harness) || (r.chatId && isChatKey(r.chatId, r.harness))) return r;
      const n = redo(r.harness, r.machine, r.cwd);
      if (!n) return r;
      changed = true;
      return { ...r, chatId: n.key, cwd: n.folder };
    });
    if (changed) this.store.setSetting("removedChats", next);
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
      models: withCurrentSpeech(knownModels(s.setting<Partial<Settings["models"]>>("models", {}))),
      transcription: s.setting("transcription", "auto"),
      hostControl: s.setting("hostControl", true),
      language: s.setting("language", "en"),
      vocabulary: cleanVocabulary(s.setting<unknown>("vocabulary", [])),
      fastEngine: s.setting<unknown>("fastEngine", false) === true,
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
    const allowed = ["sessionName", "brainName", "brainAliases", "brainNotes", "brainEnabled", "voiceReplies", "voice", "transcription", "hostControl", "language", "vocabulary", "fastEngine"] as const;
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      // The API is the contract: a paired browser can post anything.
      if (k === "brainAliases") this.store.setSetting(k, cleanNames(patch[k]));
      else if (k === "vocabulary") this.store.setSetting(k, cleanVocabulary(patch[k]));
      else if (k === "fastEngine") this.store.setSetting(k, patch[k] === true);
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
  /** Live Simulator and Mac app tiles; LiveApps owns them. */
  liveApps: () => LiveApp[] = () => [];
  fonts: () => FontsState = () => ({ available: [], wanted: [] });
  /** Whether voice matching works on this host (the hub supplies it: the pipeline owns the voiceprints). */
  voiceprints: () => HubState["voiceprints"] = () => ({ available: false, reason: "", code: "ok", fix: "", enrolled: 0, lines: 0, byVoice: 0, neverUsed: false });

  /** The newest artifacts, plus any a screen is showing however old: a screen's tiles must always resolve. */
  private stateArtifacts() {
    const all = this.artifacts();
    const recent = all.slice(0, 120);
    const shown = new Set<string>();
    for (const screen of ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))]) {
      const st = this.stage(screen);
      for (const id of st.items) shown.add(id);
      for (const c of st.columns ?? []) for (const id of c.items) shown.add(id);
      for (const tl of st.layout?.tiles ?? []) if (tl.kind === "artifact") shown.add(tl.artifactId);
    }
    if (!shown.size) return recent;
    const have = new Set(recent.map((a) => a.id));
    return [...recent, ...all.slice(120).filter((a) => shown.has(a.id) && !have.has(a.id))];
  }

  state(): HubState {
    return {
      session: { roomId: this.roomId(), name: this.settings().sessionName, code: this.code, silent: silent(), startedAt: this.startedAt, hubUrl: this.hubUrl, canvas: this.canvas, addresses: this.addresses() },
      settings: this.settings(),
      people: this.people(),
      devices: this.store.all("devices"),
      agents: this.agents().map(publicAgent),
      workstreams: this.store.all("workstreams").sort((a, b) => b.updatedAt - a.updatedAt),
      directives: this.stateDirectives(),
      artifacts: this.stateArtifacts(),
      devservers: this.store.all("devservers"),
      events: this.store.recentEvents({ limit: 250 }).map(publicEvent),
      utterances: this.store.all("utterances").sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : 1)).slice(-200),
      stage: this.stage(),
      shares: this.shares(),
      annotations: this.annotations(),
      recordings: this.recordings(),
      facts: this.facts(),
      buildRequests: this.buildRequests(),
      liveApps: this.liveApps(),
      fonts: this.fonts(),
      screens: this.screens(),
      readyToShow: this.readyToShow(),
      showRequests: this.showRequests().filter((r) => r.status === "pending"),
      stageHistory: this.stageHistory(),
      stageTiles: this.stageTiles(),
      digest: this.store.digest("session")?.text ?? "",
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
        return { key, value: this.stateDirectives() };
      case "artifacts":
        return { key, value: this.stateArtifacts() };
      case "devservers":
        return { key, value: this.store.all("devservers") };
      case "utterances":
        return { key, value: this.store.all("utterances").sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : 1)).slice(-200) };
      case "totals":
        return { key, value: this.totals() };
      case "digest":
        return { key, value: this.store.digest("session")?.text ?? "" };
      case "shares":
        return { key, value: this.shares() };
      case "annotations":
        return { key, value: this.annotations() };
      case "recordings":
        return { key, value: this.recordings() };
      case "facts":
        return { key, value: this.facts() };
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
      case "liveApps":
        return { key, value: this.liveApps() };
      case "fonts":
        return { key, value: this.fonts() };
      case "readyToShow":
        return { key, value: this.readyToShow() };
      case "showRequests":
        return { key, value: this.showRequests().filter((r) => r.status === "pending") };
      case "stageHistory":
        return { key, value: this.stageHistory() };
      case "stageTiles":
        return { key, value: this.stageTiles() };
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
    const samples = new Map<string, Person["voiceLearned"] & object>();
    for (const s of this.store.voiceSamples()) {
      const n = samples.get(s.personId) ?? { read: 0, corrections: 0, heard: 0 };
      n[({ enrol: "read", correction: "corrections", auto: "heard" } as const)[s.kind]]++;
      samples.set(s.personId, n);
    }
    const total = (n?: Person["voiceLearned"]) => (n ? n.read + n.corrections + n.heard : 0);
    return this.store
      .all("people")
      .map((p) => ({ ...p, voiceSamples: total(samples.get(p.id)), voiceLearned: samples.get(p.id), hasVoiceprint: total(samples.get(p.id)) > 0 }))
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

  upsertPerson(fields: { id?: string; name: string; role?: string; weight?: number }): Person {
    const existing = fields.id ? this.store.get("people", fields.id) : this.personByName(fields.name);
    if (existing) {
      const incoming = fields.name.trim();
      // Matched by name, not id: "Sam" or "I'm Felipe" is a shorter way to say who someone is, not a rename.
      const shortened = !fields.id && !!incoming && existing.name.toLowerCase().startsWith(incoming.toLowerCase());
      const name = shortened ? existing.name : incoming || existing.name;
      if (name !== existing.name) this.renameOwned(existing, name);
      return this.store.put("people", {
        ...existing,
        name,
        role: fields.role ?? existing.role,
        // A new title brings its weight with it, unless someone set the weight by hand.
        weight: fields.weight ?? (fields.role !== undefined && fields.role !== existing.role && existing.weight === weightForRole(existing.role) ? weightForRole(fields.role) : existing.weight),
      });
    }
    const count = this.store.all("people").length;
    const p: Person = {
      id: newId("p"),
      name: fields.name.trim(),
      role: fields.role ?? "",
      weight: fields.weight ?? weightForRole(fields.role ?? ""),
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
    // A chat is its own agent: one that names its chat resumes only that chat's record from the same
    // machine (or an older record from before chats were told apart), and a chat that doesn't never
    // takes a named chat's.
    const sameChat = (a: Agent) => (info.chatId ? !a.chatId || a.chatId === info.chatId : !a.chatId);
    const existing =
      // A chat id is only the caller's word: it resumes a record from the same machine, never another device's.
      (info.chatId ? agents.find((a) => a.chatId === info.chatId && a.harness === info.harness && (a.machine === info.machine || !!info.sameMachine?.(a.machine))) : undefined) ??
      agents.find((a) => sameChat(a) && a.machine === info.machine && (info.cwd ? a.cwd === info.cwd : a.repo === info.repo) && a.harness === info.harness) ??
      (info.cwd && owner
        ? agents
            .filter((a) => a.ownerId === owner.id && a.harness === info.harness && a.cwd === info.cwd && now - a.lastSeen > 60_000)
            // Only a record from before chats had ids migrates this way: a named chat is never inherited
            // by another chat, however long it has been quiet or wherever the newcomer joins from.
            .filter((a) => !a.chatId)
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
    this.cancelAsks(id);
    const ids = opts.purge ? this.store.deleteAgentEvents(id) : [];
    if (opts.purge) for (const d of this.store.all("documents")) if (d.authorId === id) this.store.remove("documents", d.id);
    if (ids.length) bus.send({ type: "events-removed", ids });
    if (!opts.purge) this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: `${agent.name} was removed from the session.` });
    return { removed: true, events: ids.length };
  }

  /**
   * Chats the room removed. Their jam_join is refused until a person lets them back in: "Allow again"
   * in Settings, a people-only route; nothing a chat or its hook says clears one. Kept in the session, so a hub restart doesn't let them straight back.
   */
  removedChats(): RemovedChat[] {
    return this.store.setting<RemovedChat[]>("removedChats", []);
  }

  private blockRejoin(agent: Agent) {
    const rec: RemovedChat = { id: newId("rc"), agentId: agent.id, chatId: agent.chatId ?? null, machine: agent.machine, cwd: agent.cwd || undefined, harness: agent.harness, name: agent.name, ownerName: agent.ownerName, at: Date.now() };
    // Kept until a person lets the chat back in (or the session goes): never dropped for space.
    this.store.setSetting("removedChats", [...this.removedChats().filter((r) => r.agentId !== agent.id), rec]);
    bus.send({ type: "removed-chats" });
  }

  /** The removal that keeps this chat out, if any (by its chat id, or the agent id its connection had). */
  /**
   * `folder`: a join that can't name its chat (a Claude Code chat without its chat id, on a fresh MCP
   * session) is refused if a chat removed from that machine, folder and harness hasn't been let back.
   */
  rejoinBlocked(chatId: string | undefined, agentId: string | null, folder?: { machine: string; cwd: string; harness: string }): RemovedChat | undefined {
    return this.removedChats().find(
      (r) =>
        (!!chatId && r.chatId === chatId && (!folder || (r.machine === folder.machine && r.harness === folder.harness))) ||
        (!!agentId && r.agentId === agentId) ||
        (!!folder?.cwd && r.machine === folder.machine && r.cwd === folder.cwd && r.harness === folder.harness),
    );
  }

  /**
   * Lets a removed chat join again: only a person's Allow again (a people-only route) calls this. A removal
   * keeps the whole folder out (every new chat from that machine and folder), so allowing one clears every
   * removal for that machine, folder and harness together: the person is never told it worked while the
   * folder is still blocked. Returns how many were cleared.
   */
  allowRejoin(match: { id: string }): number {
    const all = this.removedChats();
    const picked = all.find((r) => r.id === match.id);
    if (!picked) return 0;
    const sameFolder = (r: RemovedChat) => r.id === picked.id || (!!picked.cwd && r.cwd === picked.cwd && r.machine === picked.machine && r.harness === picked.harness);
    const gone = all.filter(sameFolder);
    for (const r of gone) this.removedAgents.delete(r.agentId);
    this.store.setSetting("removedChats", all.filter((r) => !gone.includes(r)));
    bus.send({ type: "removed-chats" });
    return gone.length;
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
    // A workstream another agent holds isn't this one's: the update stays untagged rather than land in its
    // brief. An observer claims nothing, so its update stays untagged too. A workstream the update takes
    // up for the first time is announced like any claim (work nobody asked for included).
    const mine = (w: Workstream) => w.ownerAgentId === agentId && w.status === "active";
    const already = !!extra.workstream && this.store.all("workstreams").some((w) => mine(w) && normalize(w.title) === normalize(extra.workstream!));
    const claimed = extra.workstream && agent.role !== "observer" ? this.claim(agentId, extra.workstream, { quiet: already }) : undefined;
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
    if (agent?.role === "observer") throw new Error(OBSERVER_CLAIM);
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
    // By time, for this agent: however busy the room, other agents' prompts can't push its own out.
    return !this.store.promptedSince(agent.id, since);
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
    for (const open of this.openDirectives()) {
      if (open.mode !== "explore" && open.mode !== "implement") continue;
      for (const t of open.targets) {
        // Fresh for each target: an earlier target's nudge or offer this tick is kept, not overwritten.
        const d = this.store.get("directives", open.id) ?? open;
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
    // A comparison names who it compares with, so a replacement could not be made: refuse before anything is cancelled.
    if (d.mode === "coordinate") throw new Error("A comparison names the agents to compare, so it can't be reassigned. Cancel it and ask again.");
    const open = d.targets.filter((t) => !["done", "cancelled"].includes(d.progress?.[t] ?? d.status));
    const offered = open.filter((t) => d.reassignOfferedAt?.[t]);
    const from = target ? open.filter((t) => t === target) : offered.length ? offered : open;
    if (!from.length) return undefined;
    const taken = new Set(d.targets);
    const live = this.workers().filter((a) => a.status !== "offline" && !taken.has(a.id));
    // A named recipient is that agent or nobody: never someone the person didn't choose.
    if (to && !live.some((a) => a.id === to)) {
      const named = this.agent(to);
      throw new Error(!named ? "There's no agent with that id." : named.role === "observer" ? `${named.name} only watches, so it can't take work.` : taken.has(named.id) ? `${named.name} already has this task.` : `${named.name} is offline, so it can't take it now.`);
    }
    const pick = to ? live.find((a) => a.id === to) : (affinity(this, d.text).find((x) => live.some((a) => a.id === x.agent.id))?.agent ?? live[0]);
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
    return this.createDirective({ text: d.text, mode: d.mode, targets: [pick.id], requestedBy: by, rationale: `Reassigned from ${from.map((t) => this.agent(t)?.name ?? "an agent").join(", ")}, which hadn't reported in a while.`, workstreamId: d.workstreamId, sourceEventIds: d.sourceEventIds });
  }

  // ---- directives ----

  /** This room's id (one per session, kept with it): what a hook ties a queued prompt to. */
  roomId(): string {
    let id = this.store.setting<string>("roomId", "");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) this.store.setSetting("roomId", (id = crypto.randomUUID()));
    return id;
  }

  /** What the live state carries: the newest 60, plus every open one however old, so each agent's tile has all its tasks (and their Reassign offers). */
  stateDirectives(): Directive[] {
    const all = this.directives();
    return all.filter((d, i) => i < 60 || (d.status !== "done" && d.status !== "cancelled"));
  }

  directives(): Directive[] {
    return this.store.all("directives").sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }

  createDirective(d: {
    text: string;
    mode: DirectiveMode;
    rationale?: string;
    targets: string[];
    counterparts?: string[];
    priority?: number;
    requestedBy: string;
    sourceEventIds?: number[];
    workstreamId?: string | null;
    /** Once per key: asking again for the same key returns the directive already made. */
    key?: string;
  }): Directive {
    if (d.key) {
      const had = this.store.all("directives").find((x) => x.key === d.key);
      if (had) return had;
    }
    // Observers only watch: product work never goes to them (answers and notes still can).
    if (d.mode !== "answer" && d.mode !== "note") {
      const workers = d.targets.filter((t) => this.agent(t)?.role !== "observer");
      // Nobody left to do it: no task is made (a task nobody can receive would sit open for ever).
      if (d.targets.length && !workers.length) throw new Error(ONLY_OBSERVERS);
      d = { ...d, targets: workers };
    }
    // Only agents in the room are kept as counterparts. A coordinate directive is a comparison, so it must
    // name who with, whatever made it: each target needs a known counterpart other than itself.
    const counterparts = [...new Set(d.counterparts ?? [])].filter((c) => this.agent(c) && this.agent(c)?.role !== "observer"); // an observer takes no part in a comparison
    if (d.mode === "coordinate" && (!d.targets.length || d.targets.some((t) => !counterparts.some((c) => c !== t)))) throw new Error("A coordinate directive has to name the agent(s) to compare with (counterparts).");
    const directive: Directive = {
      id: newId("d"),
      ...(d.key ? { key: d.key } : {}),
      ts: Date.now(),
      text: d.text,
      mode: d.mode,
      rationale: d.rationale ?? "",
      targets: d.targets,
      ...(counterparts.length ? { counterparts } : {}),
      status: "pending",
      progress: Object.fromEntries(d.targets.map((t) => [t, "pending" as const])),
      priority: d.priority ?? 1,
      requestedBy: d.requestedBy,
      sourceEventIds: d.sourceEventIds ?? [],
      workstreamId: d.workstreamId ?? null,
      result: "",
      deliveredAt: null,
      updatedAt: Date.now(),
    };
    const names = d.targets.map((t) => this.agent(t)?.name).filter(Boolean);
    // The directive and its event are one write: a failure between them leaves neither, so a retry can't double it.
    this.store.atomic(() => {
    this.store.put("directives", directive, false);
    this.store.addEvent({
      kind: "directive",
      authorType: "brain",
      authorName: "Room brain",
      text: d.text,
      relevance: "work",
      workstreamId: directive.workstreamId,
      data: { directiveId: directive.id, mode: d.mode, targets: d.targets, targetNames: names, requestedBy: d.requestedBy, rationale: directive.rationale },
    });
    });
    bus.changed("directives");
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
    this.onDirective?.(directive);
    return directive;
  }

  setDirective(id: string, fields: Partial<Directive>) {
    const d = this.store.patch("directives", id, { ...fields, updatedAt: Date.now() });
    // A status set on the directive itself (not through one target's progress) is news for every target.
    if (d && fields.status && !fields.progress) for (const t of d.targets) this.noteProgress(id, t);
    return d;
  }

  /**
   * A person ends a whole task (done or cancelled): every target still on it ends the same way, so no
   * agent's inbox or tile keeps it open. A finished task never reopens.
   */
  endDirective(id: string, status: unknown): Directive | undefined {
    const d = this.store.get("directives", id);
    if (!d) return undefined;
    if (status !== "done" && status !== "cancelled") return d;
    if (d.status === "done" || d.status === "cancelled") return d;
    const progress = { ...(d.progress ?? {}) };
    for (const t of d.targets) if (progress[t] !== "done" && progress[t] !== "cancelled") progress[t] = status;
    const out = this.setDirective(id, { progress, status });
    for (const t of d.targets) this.wake(t);
    return out;
  }

  /**
   * Why an agent can't finish a coordinate directive yet, or null. A comparison with another agent is
   * the whole job, so "done" needs a recorded exchange on that directive (messages and asks carry its
   * id; an answer carries the id of the ask it answers), with no time window: a message this agent
   * sent to one of the named counterparts, and a message or answer from one of them back to it.
   * (Dropping it, "cancelled", is always allowed.)
   */
  exchangeGap(d: Directive, agentId: string): string | null {
    if (d.mode !== "coordinate") return null;
    const msgs = this.store.messagesAbout(d.id);
    const named = (d.counterparts ?? []).filter((c) => c !== agentId);
    if (!named.length) return "This coordinate directive names nobody to compare with, so it can't be completed: jam_ack it cancelled and ask the room to send it again.";
    // Both directions with the same counterpart: one agent's replies don't stand in for another's.
    const both = named.some((c) => c !== agentId && msgs.some((e) => e.authorId === agentId && e.data.to === c) && msgs.some((e) => e.authorId === c && e.data.to === agentId));
    const sent = msgs.some((e) => e.authorId === agentId && named.includes(String(e.data.to)));
    if (both) return null;
    return `This is a comparison with another agent: ${sent ? "wait for their reply" : "send them what you found through jam_message or jam_ask, with directiveId " + d.id}. Their reply has to carry directiveId ${d.id} too. If nobody can answer, jam_ack it cancelled and say why.`;
  }

  /** One agent's progress on a directive; the directive's status follows the slowest target. A target's done or cancelled is final. */
  setDirectiveFor(id: string, agentId: string, status: Directive["status"], result?: string) {
    const d = this.store.get("directives", id);
    if (!d) return undefined;
    if (!d.targets.includes(agentId)) throw new Error("That directive isn't addressed to you.");
    const mine = d.progress?.[agentId];
    if (mine === "done" || mine === "cancelled") return d; // terminal: a late ack or update doesn't reopen it or add to its result
    const rank = ["pending", "delivered", "acked"];
    if (mine && rank.includes(mine) && rank.includes(status) && rank.indexOf(status) < rank.indexOf(mine)) return d; // never backwards
    // Finished stays finished: a late ack or "done" doesn't reopen a task that is done or cancelled as a whole.
    if (d.status === "done" || d.status === "cancelled") return d;
    if (status === "done") {
      const gap = this.exchangeGap(d, agentId);
      if (gap) throw new Error(gap);
    }
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
  inbox(agentId: string, markDelivered = true) {
    const mine = (d: Directive) => d.progress?.[agentId] ?? d.status;
    const directives = this.directives()
      .filter((d) => d.targets.includes(agentId) && (mine(d) === "pending" || (!markDelivered && mine(d) === "delivered")))
      .reverse();
    const lastRead = this.store.setting<number>(`msgRead:${agentId}`, 0);
    const quiet = this.skipsBroadcasts(this.agent(agentId));
    const forMe = (e: JamEvent) => !e.data.inline && (e.data.to === agentId || (e.data.to === "all" && e.authorId !== agentId && !quiet));
    // Read forward from the cursor, oldest first, and filter before counting: the next 50 messages for
    // this agent, however many for others came in between. Nothing unread is ever passed over.
    const messages: JamEvent[] = [];
    for (let after = lastRead; messages.length < 50; ) {
      const page = this.store.eventsAfter(after, ["message"], 200);
      for (const e of page) if (forMe(e) && messages.length < 50) messages.push(e);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
    if (markDelivered) {
      for (const d of directives) {
        this.setDirectiveFor(d.id, agentId, "delivered");
        this.setDirective(d.id, { deliveredAt: d.deliveredAt ?? Date.now() });
      }
      if (messages.length) this.store.setSetting(`msgRead:${agentId}`, messages[messages.length - 1].id);
    }
    return { directives, messages };
  }

  hasInbox(agentId: string) {
    const { directives, messages } = this.inbox(agentId, false);
    return directives.some((d) => (d.progress?.[agentId] ?? d.status) === "pending") || messages.length > 0;
  }

  wait(agentId: string, timeoutMs: number): Promise<void> {
    if (this.hasInbox(agentId)) return Promise.resolve();
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
    // After a cursor (what an agent was last handed), read forward oldest first: a burst bigger than
    // the limit arrives over successive handovers, and the cursor never passes one it didn't hand over.
    if (opts.afterId != null) {
      const next: JamEvent[] = [];
      for (let after = opts.afterId; next.length < opts.limit; ) {
        const page = this.store.eventsAfter(after, ["decision"], 200);
        for (const e of page) if (relevant(e) && next.length < opts.limit) next.push(e);
        if (page.length < 200) break;
        after = page[page.length - 1].id;
      }
      return next;
    }
    // The latest: page back until enough are relevant, so other workstreams' decisions can't crowd one out.
    const out: JamEvent[] = [];
    // The newest that matter: page back until enough are relevant, so other workstreams' can't crowd one out.
    let beforeId: number | undefined;
    while (out.length < opts.limit) {
      const page = this.store.recentEvents({ kinds: ["decision"], beforeId, limit: 100 });
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

  private asks = new Map<string, { resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout>; from: string | null }>();

  /** Ends the questions this agent is waiting on (it was removed, or its device disconnected): they return empty now. */
  cancelAsks(fromId: string) {
    for (const a of [...this.asks.values()]) if (a.from === fromId) a.resolve(null);
  }

  /** An agent (or the brain, fromId null) asks another agent; resolves with the answer or null on timeout. */
  ask(fromId: string | null, to: string, question: string, waitMs: number, data: Record<string, any> = {}): { askId: string; answer: Promise<string | null> } {
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
      data: { to: target.id, toName: target.name, askId, ...data },
    });
    this.wake(target.id);
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => (this.asks.delete(askId), resolve(null)), waitMs);
      this.asks.set(askId, { resolve: (a) => (clearTimeout(timer), this.asks.delete(askId), resolve(a)), timer, from: fromId });
    });
    return { askId, answer };
  }

  private answered(askId: string) {
    return this.store.messagesAnswering(askId).length > 0;
  }

  answer(fromId: string, askId: string, text: string, data: Record<string, any> = {}) {
    const from = this.agent(fromId);
    const q = this.store.messageByAsk(askId);
    if (!q) throw new Error("No question with that id.");
    if (q.data.to !== fromId) throw new Error("That question wasn't asked of you.");
    if (this.answered(askId)) throw new Error("That question was already answered.");
    const waiting = this.asks.get(askId);
    this.store.addEvent({
      kind: "message",
      authorType: "agent",
      authorId: fromId,
      authorName: from?.name ?? "Agent",
      text,
      relevance: "work",
      // A waiting jam_ask returns the answer itself: the inbox doesn't repeat it.
      data: { to: q.authorId ?? "brain", toName: q.authorName, answerTo: askId, ...data, ...(waiting ? { inline: true } : {}) },
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
    const { group, variant } = splitTitle(a.title);
    const agent = this.agent(a.agentId ?? existing?.agentId);
    const art: Artifact = {
      id: existing?.id ?? a.id ?? newId("art"),
      ts: existing?.ts ?? Date.now(),
      updatedAt: Date.now(),
      kind: a.kind,
      stage: a.stage ?? existing?.stage ?? (a.kind === "frame" ? "mockup" : "built"),
      agentId: a.agentId ?? existing?.agentId ?? null,
      agentName: agent?.name ?? a.agentName ?? existing?.agentName ?? "",
      title: a.title,
      group: a.group ?? group,
      variant: a.variant ?? variant,
      platform: a.platform ?? existing?.platform ?? agent?.platform ?? null,
      nodeId: a.nodeId ?? existing?.nodeId ?? null,
      url: a.url ?? existing?.url ?? null,
      image: a.image ?? existing?.image ?? null,
      width: a.width ?? existing?.width ?? null,
      height: a.height ?? existing?.height ?? null,
      workstreamId: a.workstreamId ?? existing?.workstreamId ?? null,
      note: a.note ?? existing?.note ?? "",
      page: a.page ?? existing?.page,
      ...(a.version ?? existing?.version ? { version: a.version ?? existing?.version } : {}),
      ...(a.versions ?? existing?.versions ? { versions: a.versions ?? existing?.versions } : {}),
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

  /**
   * A new build of a screen that's already in the room becomes the next version of that item (3.5): the
   * newest image shows, the earlier ones stay in `versions`, and anything pointing at the id (the screen,
   * a pin) now shows the new build. The earlier build is the one `replaces` names, or the same agent's
   * item of the same stage with the same title once "(built)" and version marks are dropped.
   * `replaces` that names nothing usable throws, so the agent hears it.
   */
  upsertVersion(a: Partial<Artifact> & { kind: Artifact["kind"]; title: string }, replaces?: string, fold = true): Artifact {
    let prior: Artifact | undefined;
    if (replaces) {
      prior = this.store.get("artifacts", replaces);
      if (!prior) throw new Error(`No artifact ${replaces} to replace. Use jam_artifacts for ids.`);
      if (prior.agentId !== (a.agentId ?? null)) throw new Error("That item belongs to someone else's agent; post yours as a new item.");
    } else if (fold && (a.kind === "screenshot" || a.kind === "html")) {
      const key = buildKey(a.title);
      prior = this.artifacts().find((x) => x.kind === a.kind && x.agentId === (a.agentId ?? null) && x.stage === (a.stage ?? "built") && buildKey(x.title) === key);
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
    // It also has to be the same kind of capture: a camera never takes over a screen share's record.
    const ownShare = found?.deviceId === deviceId && (found.status === "live" || (found.status === "ended" && !!found.lost));
    const askedOf = found?.status === "requested" && !!person && found.personId === person.id;
    const existing = found && found.kind === kind && (ownShare || askedOf) ? found : undefined;
    const id = existing?.id ?? newId("sh");
    // One share of a kind per person (per device for a device nobody claimed): an earlier one, from
    // this window or another, is replaced, and requests for the same thing still waiting are answered.
    for (const old of this.shares()) {
      if (old.id === id || old.kind !== kind) continue;
      if (old.status === "live" && (old.deviceId === deviceId || (person && old.personId === person.id))) {
        this.endShare(old.id);
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
    // Nothing may ever place it: its placement deadline starts now.
    this.checkShares(false);
    return share;
  }

  /**
   * A new share fills the presentation area alone at once, whether or not the brain is on (it lays things out beside it
   * only when the room asks). It goes to the main screen if the share may take it over; if a person's cast, lock or pin
   * holds it, to a free extra screen; with none, the room gets a note. When the share ends the screen gets back what it showed.
   */
  placeShare(share: Share) {
    const target = this.shareTarget(share);
    if (!target && this.screenSeen && !this.screens().length) {
      bus.send({ type: "toast", tone: "info", text: `${share.personName} is sharing their ${share.kind}`, detail: "No big screen window is open to show it on." });
      return;
    }
    if (!target) {
      const lock = this.lockOf("main");
      bus.send({ type: "toast", tone: "info", text: `${share.personName} is sharing their ${share.kind}`, detail: lock && lock.personId !== share.personId ? `${lock.by} has the screen locked; unlock it or ask the brain to show the share.` : "The screen is pinned; unpin it or ask the brain to show the share." });
      return;
    }
    const stage = this.stage(target);
    const held = this.lockOf(target);
    // The screens' earlier stages are saved by setStage, in the same transaction as the placement.
    // The owner's own share over their cast keeps their lock, and the cast comes back with it (SPEC 10.5). Under one claim,
    // so only onto the very screen and lock it was decided for; anything newer (another cast, an unlock) wins.
    const claim = this.stageClaim();
    void this.setStage({ mode: "layout", title: stage.title, layout: { tiles: [{ kind: "screen", shareId: share.id, label: share.label }] } }, "JamSesh", target, { override: true, keepLock: held ?? undefined, claim });
  }

  /** The screen a new share may take over: main, else a free extra one; null when a lock or pin that isn't the sharer's holds them all. */
  shareTarget(share: Share): string | null {
    // A screen the sharer themself pinned or locked is theirs to share over, matched by a person id on both sides: a missing id is nobody.
    // A pin is a person's only if a person's id is recorded on it (empty: a person with no id of their own, so nobody else's share). The display label says nothing.
    const eligible = (id: string) => {
      const st = this.stage(id);
      const lock = this.lockOf(id);
      if (lock) return !!share.personId && lock.personId === share.personId;
      if (!st.pinned || st.pinnedById === undefined) return true;
      return !!share.personId && st.pinnedById === share.personId;
    };
    // Only screens whose window is reporting now (a closed main is not a place to put anything), main first.
    const live = this.screens().map((x) => x.id);
    // Before any window has reported (a cold start) main is where one will appear; once they have, only reporting windows count.
    return (live.length ? live : this.screenSeen ? [] : ["main"]).find(eligible) ?? null;
  }

  /** What each screen showed just before a share took it over, so the share's end can give it back. */
  /** The per-screen stages a share hid, kept in the store with the share so a restart still gives them back. */
  private priorStages(): Record<string, Record<string, Stage>> {
    return this.store.setting<Record<string, Record<string, Stage>>>("beforeShare", {});
  }

  /** Remember what every screen shows now (keyed by screen), ahead of a new share taking one of them over. */
  /** Called when a share newly takes a screen: what the screen showed then is what its end gives back (a share that returns saves it afresh). */
  rememberStageFor(shareId: string, screen = "main") {
    const all = this.priorStages();
    const st = this.stage(screen);
    const tiles = st.mode === "layout" ? st.layout?.tiles ?? [] : [];
    let kept = st;
    if (tiles.length && tiles.every((t) => t.kind === "screen")) {
      // Another share is all this screen shows: this one gives back what that one was hiding.
      for (const t of tiles) {
        const prior = t.kind === "screen" ? all[t.shareId]?.[screen] : undefined;
        if (prior) {
          kept = prior;
          break;
        }
      }
    }
    this.store.setSetting("beforeShare", { ...all, [shareId]: { ...all[shareId], [screen]: kept } });
  }

  /**
   * Ends a share. A live one's window is always told, so its capture stops for good; `lost` marks an
   * end the sharer didn't choose (their connection dropped), which their window may register again.
   */
  endShare(id: string, status: Share["status"] = "ended", opts: { note?: string; lost?: boolean } = {}) {
    const sh = this.store.get("shares", id);
    if (!sh) return;
    // The share's status, every screen's restore and the removal of its snapshot are one write: a crash between them can't leave an ended share on screen.
    this.atomically(() => {
      this.store.put("shares", { ...sh, status, lost: opts.lost || undefined }, false);
      this.after(() => bus.changed("shares"));
      if (sh.status === "live" && !opts.lost) this.after(() => bus.send({ type: "share-ended", shareId: sh.id, deviceId: sh.deviceId, text: opts.note ?? "" }));
      this.sharesShown.delete(id);
      this.offScreen.delete(id);
      this.releaseShareTiles(id);
    });
  }

  /** Takes an ended share off every screen (giving back what it hid) and drops its snapshot. */
  private releaseShareTiles(id: string) {
    const { [id]: before, ...others } = this.priorStages();
    if (before) this.store.setSetting("beforeShare", others);
    const hosts = ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))];
    for (const screen of hosts) {
      const st = this.stage(screen);
      if (st.mode === "layout" && st.layout?.tiles.some((t) => t.kind === "screen" && t.shareId === id)) {
        const tiles = st.layout.tiles.filter((t) => !(t.kind === "screen" && t.shareId === id));
        // When the share was all the screen showed, the screen goes back to what it showed before.
        const prior = before?.[screen];
        const back = !tiles.length && prior && !(prior.mode === "layout" && prior.layout?.tiles.some((t) => t.kind === "screen" && t.shareId === id)) ? prior : null;
        // A lock still held when the share ends stays with what comes back (the owner's share over their own cast, SPEC 10.5).
        // One its owner let go of during the share stays gone.
        // The pin comes back only with the lock that held it: an owner who unlocked during the share released the pin with it.
        // A pin that had no lock was never anyone's to release, and stays.
        const restored = back && back.lock && !st.lock ? { ...back, pinned: false, pinnedById: undefined } : back;
        const put = this.setStage(tiles.length ? { ...st, layout: { tiles } } : restored ? restored : { mode: "board" }, back?.by ?? "JamSesh", screen, { override: true, keepLock: st.lock });
        // What it hid can't be shown again (its artifacts are gone): the board, rather than the ended share's tile.
        if (!put.applied) void this.setStage({ mode: "board" }, "JamSesh", screen, { override: true });
      }
    }
  }

  /**
   * At startup: shares that ended but whose snapshot is still stored (the hub stopped between the steps of an older
   * ending) are released now. One whose snapshot is gone can't be given back what it hid, so its screen is left as it is.
   */
  private reconcileShares() {
    // Nobody is still sharing after a restart.
    for (const sh of this.store.all("shares")) if (sh.status === "live") this.endShare(sh.id, "ended", { lost: true });
    for (const id of Object.keys(this.priorStages())) this.atomically(() => this.releaseShareTiles(id));
    // An ended share still on a screen with nothing saved to give back: the earlier screen is lost, but the dead tile comes off
    // (the other tiles stay; alone, the screen shows the board).
    const dead = new Set<string>();
    for (const screen of ["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {}))]) {
      const st = this.stage(screen);
      for (const t of st.mode === "layout" ? st.layout?.tiles ?? [] : [])
        if (t.kind === "screen" && this.store.get("shares", t.shareId)?.status !== "live") dead.add(t.shareId);
    }
    for (const id of dead) {
      console.warn(`share ${id} ended but still showed on a screen, and no earlier screen was saved; took its tile off`);
      this.atomically(() => this.releaseShareTiles(id));
    }
  }

  // ---- shares that left the big screen ----

  private shareSweep: ReturnType<typeof setTimeout> | null = null;
  private shareSweepAt = 0;
  /** Shares a host display has shown at some point: they had their placement, and the sharer hears why theirs stopped. */
  private sharesShown = new Set<string>();
  /** When each shown share was first seen on no display: its grace runs from there, whatever the stage does next. */
  private offScreen = new Map<string, number>();
  /** Long enough to place a brand-new share (a pinned screen waits for a person) before it counts as "not on screen". */
  static SHARE_PLACE_MS = 60_000;
  static SHARE_GRACE_MS = 5_000;
  /** How often a share that is up gets looked at again, so a display that stops reporting is noticed. */
  static SHARE_CHECK_MS = 15_000;

  /** Shares on a display that is there now: one whose window still reports (not closed or gone quiet), the main one included. */
  private shownShareIds(): Set<string> {
    const ids = new Set<string>();
    const screens = new Set(this.screens().map((sc) => sc.id));
    for (const screen of screens) {
      const st = this.stage(screen);
      if (st.mode === "layout") for (const t of st.layout?.tiles ?? []) if (t.kind === "screen") ids.add(t.shareId);
    }
    return ids;
  }

  /** Wake the sweep by `at`. A later deadline never pushes back an earlier one, so stage changes can't postpone a cleanup. */
  private wakeSweep(at: number) {
    if (!Number.isFinite(at)) return;
    if (this.shareSweep && this.shareSweepAt <= at) return;
    if (this.shareSweep) clearTimeout(this.shareSweep);
    this.shareSweepAt = at;
    this.shareSweep = setTimeout(() => {
      this.shareSweep = null;
      this.shareSweepAt = 0;
      try {
        this.sweepShares();
      } catch (e) {
        console.error("shares: sweep failed:", e instanceof Error ? e.message : e); // a timer must never take the hub down
      }
    }, Math.max(0, at - Date.now()));
    this.shareSweep.unref?.();
  }

  /**
   * Which live shares are on a display now, and each one's deadline: a share never shown has its
   * placement window from when it started; one taken down has the grace from when it left. With
   * `end`, shares past their deadline stop and the sharer is told why.
   */
  private checkShares(end: boolean) {
    const now = Date.now();
    const shown = this.shownShareIds();
    let next = Infinity;
    for (const sh of this.shares()) {
      if (sh.status !== "live") continue;
      if (shown.has(sh.id)) {
        this.sharesShown.add(sh.id);
        this.offScreen.delete(sh.id);
        next = Math.min(next, now + Session.SHARE_CHECK_MS);
        continue;
      }
      const placed = this.sharesShown.has(sh.id);
      if (placed && !this.offScreen.has(sh.id)) this.offScreen.set(sh.id, now);
      const due = placed ? this.offScreen.get(sh.id)! + Session.SHARE_GRACE_MS : sh.startedAt + Session.SHARE_PLACE_MS;
      if (!end || due > now) {
        next = Math.min(next, due);
        continue;
      }
      const text = placed ? `Your ${sh.kind} left the big screen, so sharing stopped.` : `Your ${sh.kind} wasn't put on the big screen, so sharing stopped.`;
      this.endShare(sh.id, "ended", { note: text });
    }
    this.wakeSweep(next);
  }

  sweepShares() {
    this.checkShares(true);
  }

  // ---- recordings in progress ----

  private active = new Map<string, ActiveRecording>();
  recordings(): ActiveRecording[] {
    return [...this.active.values()];
  }
  setRecording(r: ActiveRecording | null, deviceId?: string) {
    if (r) this.active.set(r.deviceId, r);
    else if (deviceId) this.active.delete(deviceId);
    bus.changed("recordings");
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

  /** Active facts first (newest first), then the latest resolved or superseded ones. */
  facts(): Fact[] {
    const all = this.store.all("facts").sort((a, b) => b.updatedAt - a.updatedAt);
    return [...all.filter((f) => f.status === "active"), ...all.filter((f) => f.status !== "active").slice(0, 30)];
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

  /** A screen by its id or by what it's called ("left tv", "the Left TV"); undefined when nothing fits, or more than one does. */
  findScreen(ref?: string): ScreenInfo | undefined {
    const m = this.screenMatch(ref);
    return m && "screen" in m ? m.screen : undefined;
  }

  /**
   * What a screen reference means: an id ("screen-2") as an id only; else the name of exactly one screen (ignoring case,
   * "the" and punctuation), or the start of exactly one screen's name in whole words ("left" for "Left TV"). Never part
   * of an id or a word. Two screens with that name, or starting that way: the ones to ask between. Nothing: null.
   */
  screenMatch(ref?: string): { screen: ScreenInfo } | { choices: string[] } | null {
    const plain = (x: string) => x.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
    const raw = (ref ?? "").trim();
    const want = plain(raw);
    if (!want) return null;
    const all = this.screens();
    // An id is looked up as an id only: a stale "screen-20" never lands on a screen someone named "screen 20".
    if (/^screen-\d+$/i.test(raw) || raw === "main") {
      const byId = all.find((sc) => sc.id === raw);
      return byId ? { screen: byId } : null;
    }
    // A name counts only when one screen has it: two called "Left TV" are asked about, never the first picked.
    const named = all.filter((sc) => plain(sc.name) === want);
    if (named.length === 1) return { screen: named[0] };
    if (named.length > 1) return { choices: named.map((sc) => `${sc.name} (${sc.id})`) };
    const starts = all.filter((sc) => plain(sc.name).startsWith(`${want} `));
    if (starts.length === 1) return { screen: starts[0] };
    return starts.length ? { choices: starts.map((sc) => sc.name) } : null;
  }

  private screenReverts = new Map<string, ReturnType<typeof setTimeout>>();

  /** The hub is stopping: no timer of this session touches its store again (it may be closed or deleted next). */
  private offArtifacts: (() => void) | null = null;
  stop() {
    this.offArtifacts?.();
    this.offArtifacts = null;
    for (const t of [this.lockSweep, this.stageRevert, this.shareSweep, ...this.screenReverts.values(), ...this.screenExpiry.values()]) if (t) clearTimeout(t);
    this.screenExpiry.clear();
    this.screenReverts.clear();
    this.lockSweep = this.stageRevert = this.shareSweep = null;
  }

  /** A big-screen window reported its size; windows that stop reporting drop off after 3 minutes. */
  /** Whether any big-screen window has reported in this process: before that, main is where a share will appear. */
  private screenSeen = false;
  reportScreen(id: string, info: Omit<ScreenInfo, "id" | "stage" | "name" | "role">) {
    this.screenSeen = true;
    // A screen coming back is a different screen to anything decided while it was gone.
    if (!this.bigScreens.has(id)) this.stageRevs.set(id, this.stageRev(id) + 1);
    this.bigScreens.set(id, { id, ...info });
    this.sweepScreens();
    // A screen not heard from for 3 minutes stops being listed: say so then (its stored stage stays for when it returns).
    clearTimeout(this.screenExpiry.get(id));
    const t = setTimeout(() => this.sweepScreens(), Session.SCREEN_LIVE_MS + 100);
    t.unref?.();
    this.screenExpiry.set(id, t);
  }

  static SCREEN_LIVE_MS = 3 * 60_000;
  private screenExpiry = new Map<string, ReturnType<typeof setTimeout>>();
  private liveScreens = { ids: "", shape: "" };
  /** Publishes the screens (and their tiles) when what is listed changed: one appeared, came back, went quiet, or moved or resized. */
  sweepScreens() {
    const live = this.screens();
    const ids = live.map((x) => x.id).sort().join("|");
    const shape = live.map((x) => `${x.id}:${x.width}x${x.height}@${x.screenX},${x.screenY}x${x.dpr}`).sort().join("|");
    if (ids === this.liveScreens.ids && shape === this.liveScreens.shape) return;
    const idsChanged = ids !== this.liveScreens.ids;
    const before = new Set(this.liveScreens.ids.split("|"));
    this.liveScreens = { ids, shape };
    // A screen that just appeared or came back: what it saved is checked, and its return-to-board wait runs again.
    for (const x of live) {
      if (before.has(x.id) || x.id === "main") continue;
      if (!this.screenReverts.has(x.id)) this.armRevert(x.id, this.stage(x.id), 1000);
    }
    if (idsChanged) this.dropDeadExpanded();
    bus.changed("screens");
    if (idsChanged) bus.changed("stageTiles");
  }

  /** A big-screen window closed (the host app says so): it stops being a place to show things now,
   *  not 3 minutes later. The main screen's stage stays, and it counts again once its window reports. */
  removeScreen(id: string) {
    if (!this.bigScreens.delete(id)) return;
    this.stageRevs.set(id, this.stageRev(id) + 1); // what was decided for it before it went is stale
    clearTimeout(this.screenReverts.get(id));
    this.screenReverts.delete(id);
    this.defaultStages.delete(id);
    clearTimeout(this.screenExpiry.get(id));
    this.screenExpiry.delete(id);
    this.sweepScreens();
    // A share only that display showed is off screen from now; a live app on it no longer has drivers (held input is let go).
    this.checkShares(false);
    this.onStageCommit?.();
  }

  screens(): ScreenInfo[] {
    const now = Date.now();
    return [...this.bigScreens.values()]
      .filter((sc) => now - sc.at < Session.SCREEN_LIVE_MS)
      .sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : a.screenX - b.screenX))
      .map((sc, i, all) => {
        const known = this.screenNames()[sc.id];
        // With no names from the host app, a screen is called by where it sits (left to right).
        const name = known?.name ?? (sc.id === "main" ? "Main screen" : `Screen ${i + 1}`);
        return { ...sc, name, role: sc.id === "main" ? ("main" as const) : ("extra" as const), stage: this.stage(sc.id) };
      });
  }

  private defaultStages = new Map<string, { at: number }>();

  stage(screen = "main"): Stage {
    // A screen nothing was ever put on shows a default that stays the same stage between reads (same `since`, and its own `screenId`).
    let first = this.defaultStages.get(screen);
    if (!first) this.defaultStages.set(screen, (first = { at: Date.now() }));
    if (screen !== "main") return this.valid(this.store.setting<Record<string, Stage>>("screenStages", {})[screen], screen) ?? { mode: "board", title: "", caption: "", items: [], pinned: false, since: first.at, by: "JamSesh", screenId: screen };
    return this.valid(this.store.setting<Stage | null>("stage", null), "main") ?? {
      mode: "welcome",
      title: "",
      caption: "",
      items: [],
      pinned: false,
      since: first.at,
      by: "JamSesh",
    };
  }

  private badStageLogged = new Set<string>();
  /** A stored stage that passes the same check a cast does (missing basics filled in), or undefined, logged once, when it doesn't: a bad one is dropped, never served. */
  private valid(raw: Stage | null | undefined, screen: string): Stage | undefined {
    if (!raw) return undefined;
    const r = parseStage(raw);
    if (!r.ok) {
      if (!this.badStageLogged.has(screen)) console.error(`the stored stage of ${screen} is malformed and was dropped: ${r.error}`);
      this.badStageLogged.add(screen);
      return undefined;
    }
    this.badStageLogged.delete(screen);
    return { title: "", caption: "", items: [], pinned: false, since: Date.now(), by: "JamSesh", ...r.stage } as Stage;
  }

  /** How long a brought-up screen stays before the board comes back (tests shorten it). */
  static STAGE_REVERT_MS = 6 * 60_000;

  /** Whether a stage goes back to the board by itself. Not while it shows a live share (the share's end gives the screen back what it hid, and a timer would cut the share first), nor while a person holds it. */
  private revertsToBoard(stage: Stage) {
    if (stage.pinned || stage.lock || stage.mode === "board" || stage.mode === "welcome") return false;
    if (stage.mode === "layout" && stage.layout?.tiles.some((t) => t.kind === "screen" && this.store.get("shares", t.shareId)?.status === "live")) return false;
    if (stage.mode === "layout" && stage.layout?.tiles.some((t) => t.kind === "app")) return false;
    return true;
  }

  /**
   * Expand one tile of a screen's stage to fill the presentation area, or collapse back (`key` null). In place: the stage keeps its age,
   * its history entry and its lock, and a lock doesn't refuse it, since looking closer isn't replacing what the owner put up. Someone is
   * looking at it, so a stage that returns to the board by itself starts its wait again.
   */
  expandTile(key: string | null, screen = "main", claim?: StageClaim): Stage {
    const cur = this.stage(screen);
    const tile = typeof key === "string" ? key.trim() : "";
    if (!this.claimHolds(claim, screen) || cur.mode === "join" || (tile ? cur.expanded === tile : !cur.expanded)) return cur;
    // Only a tile this screen really has can be expanded.
    if (tile && !this.stageTileKeys(screen).some((k) => k.key === tile)) return cur;
    const { expanded: _drop, ...rest } = cur;
    const stage: Stage = tile ? { ...rest, expanded: tile } : rest;
    this.atomically(() => this.commitStage(stage, screen));
    claim?.revs.set(screen, this.stageRev(screen));
    return stage;
  }

  /** An expanded tile whose content is gone (its artifact was deleted) is collapsed, and the screens are told. */
  private dropDeadExpanded() {
    // Every screen with a saved stage, connected or not: one that is unplugged keeps what it showed for when it returns.
    for (const screen of new Set(["main", ...Object.keys(this.store.setting<Record<string, Stage>>("screenStages", {})), ...this.screens().map((x) => x.id)])) {
      const st = this.stage(screen);
      if (!st.expanded || this.stageTileKeys(screen).some((k) => k.key === st.expanded)) continue;
      const { expanded: _gone, ...rest } = st;
      // Cleaning up isn't someone looking at it: the return-to-board wait keeps its saved deadline.
      this.atomically(() => this.commitStage(rest, screen, { keepDeadline: true }));
    }
  }

  /** Every screen's tile keys (`stageTileKeys`), as windows get them: they draw tiles from these and never work keys out themselves. */
  stageTiles(): Record<string, StageTileKey[]> {
    // Every connected screen has tiles, even one nothing was put on yet (its default board).
    // (A disconnected screen keeps its stored stage for when it returns, but isn't listed.)
    const ids = new Set(["main", ...this.screens().map((x) => x.id)]);
    return Object.fromEntries([...ids].map((id) => [id, this.stageTileKeys(id)]));
  }

  /** The keys of the tiles a screen's stage shows, in the order the screen draws them. The one place keys are made. */
  stageTileKeys(screen = "main"): StageTileKey[] {
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
        // Keyed by where each came from (column, place in the stored list) and which artifact it was: when an earlier artifact
        // goes, the others keep their keys and the gone one's key names nothing, so a key never points at different content.
        return (st.columns?.length ? st.columns : [{ label: "", items: st.items }]).flatMap((c, ci) => c.items.flatMap((id, place) => (known.has(id) ? [{ key: `p${ci}.${place}.${id}`, artifactId: id, parity: { column: ci, place } }] : [])));
      case "layout":
        // The place plus a short fingerprint of what is there: a click on the old first tile can't expand a different new one.
        // (A tile for an artifact that no longer exists has nothing to expand.)
        return (st.layout?.tiles ?? []).flatMap((t, i) => (t.kind === "artifact" && !known.has(t.artifactId) ? [] : [{ key: `t${i}.${fingerprint(t)}`, layoutIndex: i, ...(t.kind === "artifact" ? { artifactId: t.artifactId } : {}) }]));
      default:
        return [];
    }
  }

  /** Expand "the second one" or a named artifact's tile, or collapse (neither given). Says why when it can't. */
  expandWhich(ref: { artifactId?: string; position?: number }, screen = "main", claim?: StageClaim): { ok: true; stage: Stage } | { ok: false; error: string } {
    if (!this.claimHolds(claim, screen)) return { ok: false, error: "The screen changed since; look again before expanding." };
    if (ref.artifactId === undefined && ref.position === undefined) return { ok: true, stage: this.expandTile(null, screen, claim) };
    const tiles = this.stageTileKeys(screen);
    if (!tiles.length) return { ok: false, error: "The screen isn't showing tiles to expand." };
    const hit = ref.artifactId !== undefined ? tiles.find((t) => t.artifactId === ref.artifactId) : tiles[Math.trunc(ref.position ?? 0) - 1];
    if (!hit) return { ok: false, error: ref.artifactId !== undefined ? "That isn't on the screen right now." : `The screen has ${tiles.length} tile${tiles.length === 1 ? "" : "s"}.` };
    return { ok: true, stage: this.expandTile(hit.key, screen, claim) };
  }

  /**
   * Put something on a screen. A screen a person locked refuses everything except people (and `override`,
   * for the hub's own housekeeping: a share ending, a request the owner approved): the stage comes back
   * unchanged, and callers that want to explain why ask `lockOf` first. A person's cast takes the lock.
   */
  setStage(next: Partial<Stage> & { mode: Stage["mode"] }, by: string, screen: string, opts: StageOpts): StageResult {
    const refused = (reason: string): StageResult => ({ applied: false, reason });
    // Parse once, at the very top: everything below reads and commits only the cleaned copy, never the raw input.
    const parsed = parseStage(next);
    if (!parsed.ok) return refused(parsed.error);
    // A new stage starts unexpanded (expandTile is what sets it).
    const { expanded: _x, revertAt: _r, ...clean } = parsed.stage;
    next = clean;
    // The lock is looked at first (a lapse is a change too), then the claim: a decision made before the lapse doesn't land after it.
    const held = this.lockOf(screen);
    if (!this.claimHolds(opts.claim, screen)) return refused("The screen changed since this was decided.");
    // Nothing is put on a screen whose window has gone (a build finishing after it closed); the hub's own cleanup (override) still may.
    if (!opts.override && !this.screenUsable(screen)) return refused("That screen isn't connected any more.");
    // The lock's owner asked for this very write: it replaces their lock in the same step (nothing is released ahead of it).
    if (!opts.person && !opts.override && held && !(opts.mayReplaceLock && opts.mayReplaceLock === held.personId)) return refused(`${held.by} has this screen locked.`);
    // A share is shown only while it's live: an ended one's tile is dropped, and a layout that was only ended shares isn't put up.
    if (next.mode === "layout" && next.layout?.tiles.length) {
      const tiles = next.layout.tiles.filter((t) => t.kind !== "screen" || this.store.get("shares", t.shareId)?.status === "live");
      if (!tiles.length) return refused("Every share in that layout has ended.");
      if (tiles.length !== next.layout.tiles.length) next = { ...next, layout: { ...next.layout, tiles, grid: undefined } };
    }
    const now = Date.now();
    const quiet = next.mode === "board" || next.mode === "welcome";
    // An owner who re-casts while driving keeps driving the new stage; anyone they handed control to is cut off.
    const cur = this.stage(screen);
    const keeps = opts.person?.id && cur.lock?.personId === opts.person.id && cur.lock.drivers?.includes(opts.person.id);
    const lock: StageLock | undefined = quiet ? undefined : opts.keepLock ?? (opts.person && !opts.noLock ? { id: newId("lk"), by: opts.person.name, personId: opts.person.id, since: now, lastActive: now, ...(keeps ? { drivers: [opts.person.id!] } : {}) } : undefined);
    const { lock: _drop, ...rest } = next;
    const stage: Stage = { title: "", caption: "", items: [], pinned: false, ...rest, since: now, by, screenId: screen, ...(lock ? { lock } : {}) };
    // The checks every stage passes before it is stored, whoever wrote it: what the read path would reject, or what would draw nothing, isn't written.
    const gone = this.unrenderable(stage);
    if (gone) return refused(gone);
    const checked = parseStage(stage);
    if (!checked.ok) {
      console.error(`refused a stage for ${screen}: ${checked.error}`);
      return refused(checked.error);
    }
    // Who pinned it, by identity (never by name): only a person with an id of their own is recorded.
    if (stage.pinned && opts.person) stage.pinnedById = opts.person.id ?? "";
    else if (!stage.pinned || opts.person) delete stage.pinnedById;
    // The stage, the questions it expires and its history entry are one write; a caller's claim moves on only once it committed.
    // A share newly on this screen gets the screens' earlier stages saved, so its end gives them back (once per share).
    const had = new Set(this.stage(screen).layout?.tiles.flatMap((t) => (t.kind === "screen" ? [t.shareId] : [])) ?? []);
    this.atomically(() => {
      if (stage.mode === "layout") for (const t of stage.layout?.tiles ?? []) if (t.kind === "screen" && !had.has(t.shareId)) this.rememberStageFor(t.shareId, screen);
      this.commitStage(stage, screen);
      this.recordHistory(stage, screen);
    });
    opts.claim?.revs.set(screen, this.stageRev(screen));
    return { applied: true, stage };
  }

  /** Whether this person's direct request may replace the lock on a screen: they own it, and nothing changed it since the claim. Releases nothing. */
  mayReplaceLock(screen: string, owner: string, claim: StageClaim): boolean {
    const lock = this.lockOf(screen);
    return !lock || (this.claimHolds(claim, screen) && !!lock.personId && lock.personId === owner);
  }

  /** Counts every change to a screen's stage or its lock (cast, expand, unlock, lapse), in this process. */
  private stageRevs = new Map<string, number>();
  stageRev(screen = "main") {
    return this.stageRevs.get(screen) ?? 0;
  }

  /** Every screen's revision now, for work that will write later (see StageClaim). A screen not seen yet is at 0. */
  stageClaim(): StageClaim {
    return { revs: new Map(this.stageRevs) };
  }

  /** No claim (a person or upkeep acting now), or nothing has changed the screen since the claim was taken. */
  private claimHolds(claim: StageClaim | undefined, screen: string) {
    return !claim || (claim.revs.get(screen) ?? 0) === this.stageRev(screen);
  }

  /** Effects (sends, timers, sweeps) a stage write has beyond the store; inside `atomically` they wait for the commit. */
  private effects: (() => void)[] | null = null;
  private after(fn: () => void) {
    if (this.effects) this.effects.push(fn);
    else fn();
  }

  /**
   * One store transaction whose in-memory side (stage revisions, shown-share marks) is put back if it fails, and whose
   * effects (sends, timers) run only after it commits. A rollback runs none of them.
   */
  private atomically<T>(fn: () => T): T {
    if (this.effects) return fn();
    const revs = new Map(this.stageRevs);
    const shown = new Set(this.sharesShown);
    this.effects = [];
    let out: T;
    try {
      out = this.store.atomic(fn);
    } catch (e) {
      // Nothing committed: the in-memory side goes back and no effect runs.
      this.effects = null;
      this.stageRevs = revs;
      this.sharesShown = shown;
      throw e;
    }
    // Committed. An effect that throws is logged and never touches the committed state or the effects after it.
    const run = this.effects;
    this.effects = null;
    for (const f of run) {
      try {
        f();
      } catch (e) {
        console.error("effect after a committed write failed:", e);
      }
    }
    return out;
  }

  /** Called after any screen's stage, lock or drivers change (live app tiles let go of presses whose driver is out). */
  onStageCommit?: () => void;

  /**
   * Stores a stage and tells everyone. Every stage write is part of a transaction (the revision, the questions it expires
   * and the store move together or not at all). The return-to-board deadline is saved with the stage: a write that
   * restarts the wait sets it fresh; `keepDeadline` (cleanup that isn't someone looking) carries the old one.
   */
  private commitStage(stage: Stage, screen: string, opts: { keepDeadline?: boolean } = {}) {
    if (!this.effects) throw new Error("commitStage outside Session.atomically");
    stage.revertAt = opts.keepDeadline ? stage.revertAt ?? stage.since + Session.STAGE_REVERT_MS : Date.now() + Session.STAGE_REVERT_MS;
    this.stageRevs.set(screen, this.stageRev(screen) + 1);
    this.expireAsksFor(screen, stage.lock);
    this.after(() => {
      bus.changed("stageTiles");
      // A live app tile on this screen is driven by whoever the lock says drives.
      bus.changed("liveApps");
      this.onStageCommit?.();
    });
    if (screen !== "main") {
      this.store.setSetting("screenStages", { ...this.store.setting<Record<string, Stage>>("screenStages", {}), [screen]: stage });
      this.after(() => {
        bus.changed("screens");
        this.checkShares(false);
        this.armRevert(screen, stage);
      });
      return;
    }
    this.store.setSetting("stage", stage);
    this.after(() => {
      bus.send({ type: "stage", stage });
      this.checkShares(false);
      if (this.bigScreens.size > 1) bus.changed("screens");
      // Anything the brain brought up returns to the live board after a while.
      this.armRevert("main", stage);
    });
  }

  /** Sets the screen's return-to-board timer from the stage's saved deadline (none when it stays up). */
  private armRevert(screen: string, st: Stage, minDelay = 0) {
    if (screen === "main") {
      if (this.stageRevert) clearTimeout(this.stageRevert);
      this.stageRevert = null;
    } else {
      clearTimeout(this.screenReverts.get(screen));
      this.screenReverts.delete(screen);
    }
    if (!this.revertsToBoard(st)) return;
    // A stage saved before deadlines were kept falls back to its age.
    const delay = Math.max(minDelay, (st.revertAt ?? st.since + Session.STAGE_REVERT_MS) - Date.now());
    const t = setTimeout(() => this.revertToBoard(screen, st.since), delay);
    t.unref?.();
    if (screen === "main") this.stageRevert = t;
    else this.screenReverts.set(screen, t);
  }

  /** How long to wait before trying again when putting the board back failed (the store said no). */
  static REVERT_RETRY_MS = 5_000;
  /** The timer's write: a storage error is reported and tried again later (only if the stage is still the one that timed out), never thrown into the process. */
  private revertToBoard(screen: string, since: number) {
    try {
      if (this.stage(screen).since !== since) return;
      void this.setStage({ mode: "board" }, "JamSesh", screen, { override: true });
    } catch (e) {
      console.error(`putting the board back on ${screen} failed; trying again:`, e);
      const t = setTimeout(() => this.revertToBoard(screen, since), Session.REVERT_RETRY_MS);
      t.unref?.();
      if (screen === "main") this.stageRevert = t;
      else this.screenReverts.set(screen, t);
    }
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
      this.dropLock(screen);
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

  /** Lets go of a screen's lock; what it shows stays. It returns to the board on the usual timer from here. Only lapsing and `releaseLock` call it. */
  private dropLock(screen: string) {
    const cur = this.stage(screen);
    if (!cur.lock) return;
    // The lock goes and so does the claim a person's pin had on the screen.
    const { lock: _drop, pinnedById: _pin, ...rest } = cur;
    // The lock goes together with the questions about it: all of it, or none.
    this.atomically(() => this.commitStage({ ...rest, pinned: false }, screen));
  }

  /** A person's yes to the lock question counts this long after it was asked. */
  static UNLOCK_ASK_MS = 3 * 60_000;
  /** The question JamSesh asked the room about replacing a screen's lock: its id, which lock (its `since`), and when. */
  private lockQuestions = new Map<string, { id: string; key: string; at: number }>();

  /** JamSesh just asked the room whether to replace this screen's current lock (the brain's ask_to_replace_screen). */
  askedAboutLock(screen: string) {
    const lock = this.lockOf(screen);
    if (lock) this.lockQuestions.set(screen, { id: newId("lq"), key: lockKey(lock), at: Date.now() });
  }

  /**
   * Every open yes-or-no question a person's plain answer could be meant for: host build approvals (anyone in the room
   * may answer), show requests addressed to them (they own the lock), and lock questions put to the whole room (about a
   * lock that hasn't changed, still in time). A spoken bare yes or no settles a question only when it is the only one
   * open for that person, of any kind; with two, it settles none. Every voice path asks here.
   */
  openQuestionsFor(personId: string | null): ({ kind: "build"; id: string; label: string } | { kind: "show"; id: string; screen: string; label: string } | { kind: "lock"; id: string; screen: string })[] {
    const now = Date.now();
    const builds = this.buildRequests()
      .filter((r) => r.status === "pending")
      .map((r) => ({ kind: "build" as const, id: r.id, label: `${r.agentName}'s build` }));
    const shows = this.showRequests()
      .filter((r) => r.status === "pending" && !!personId && r.ownerId === personId)
      .map((r) => ({ kind: "show" as const, id: r.id, screen: r.screen, label: r.label }));
    const locks = [...this.lockQuestions.entries()]
      .filter(([screen, q]) => now - q.at < Session.UNLOCK_ASK_MS && lockKey(this.lockOf(screen)) === q.key)
      .map(([screen, q]) => ({ kind: "lock" as const, id: q.id, screen }));
    return [...builds, ...shows, ...locks];
  }

  /**
   * The one way a lock is let go on purpose (lapsing is the other), for every caller: Unlock, the brain, anything later.
   * - `owner`: the lock's owner, by their own window's credential or in their own words to JamSesh.
   * - `hostWindow`: the host's own windows, which carry no person's credential, only for a lock held by no one in
   *   particular or by the person at the host. A name a host window sends doesn't count.
   * - `answeredAt`: a person's yes to the question asked about this very lock (`askedAboutLock`), said after it and in time,
   *   when that is the only question open for them (`openQuestionsFor`); used once.
   * Anything else leaves the lock as it is. Returns whether the screen is unlocked now.
   */
  releaseLock(screen: string, consent: { owner: string | null } | { hostWindow: true } | { answeredAt: number; by: string | null }, claim?: StageClaim): boolean {
    // Work that decided earlier lets go only of the lock it saw.
    if (!this.claimHolds(claim, screen)) return false;
    const lock = this.lockOf(screen);
    if (!lock) return true;
    const q = this.lockQuestions.get(screen);
    // An answer settles this lock's question only when it is the one question open for the person who said it.
    const only = (by: string | null) => {
      const open = this.openQuestionsFor(by);
      return open.length === 1 && open[0].kind === "lock" && open[0].id === q?.id;
    };
    const ok =
      "owner" in consent
        ? !!consent.owner && consent.owner === lock.personId
        : "hostWindow" in consent
          ? !lock.personId || lock.personId === this.store.setting<string>("hostPersonId", "")
          : !!q && q.key === lockKey(lock) && consent.answeredAt >= q.at && consent.answeredAt - q.at < Session.UNLOCK_ASK_MS && Date.now() - q.at < Session.UNLOCK_ASK_MS && only(consent.by);
    if (!ok) return false;
    this.dropLock(screen);
    // The question is used up only once the lock is really gone: a failed write leaves it to answer again.
    this.lockQuestions.delete(screen);
    claim?.revs.set(screen, this.stageRev(screen));
    return true;
  }

  /** Whether a stage may be put on this screen: its window is there (before any has reported, only main is, as the place one will appear). */
  private screenUsable(screen: string): boolean {
    if (screen === "main") return this.mainAvailable();
    return !this.screenSeen || this.screens().some((x) => x.id === screen);
  }

  /** Main can be put to use unless its window has reported and then closed (before any window has reported, it is where one will appear). */
  mainAvailable(): boolean {
    return !this.screenSeen || this.screens().some((x) => x.id === "main");
  }

  /** The screen a caller means: none named is the main one; an id or a name that isn't there now is null, never some other screen. */
  screenRef(ref?: unknown): string | null {
    const r = this.screenOf(ref);
    return "id" in r ? r.id : null;
  }

  /** `screenRef`, saying why not: no such screen, or which ones the name could mean (to ask which). */
  screenOf(ref?: unknown): { id: string } | { error: string; choices?: string[] } {
    if (ref === undefined || ref === null || ref === "" || ref === "main") return this.mainAvailable() ? { id: "main" } : { error: "That screen isn't connected any more." };
    const m = typeof ref === "string" ? this.screenMatch(ref) : null;
    if (m && "screen" in m) return { id: m.screen.id };
    if (m) return { error: `Which screen: ${m.choices.join(" or ")}?`, choices: m.choices };
    return { error: "That screen isn't connected any more." };
  }

  /** A person takes a free screen's lock, driving it, without changing what it shows (they start recording on it). */
  holdScreen(screen: string, person: { id: string; name: string }) {
    const cur = this.stage(screen);
    if (cur.lock) return;
    const now = Date.now();
    this.atomically(() => this.commitStage({ ...cur, lock: { id: newId("lk"), by: person.name, personId: person.id, since: now, lastActive: now, drivers: [person.id] } }, screen));
  }

  /** The owner did something with their screen: it counts as activity. */
  touchLock(screen = "main") {
    const cur = this.stage(screen);
    const lock = cur.lock;
    if (!lock) return;
    this.atomically(() => this.commitStage({ ...cur, lock: { ...lock, lastActive: Date.now() } }, screen));
  }

  // ---- driving: a cursor of your own on the big screen (6.1) ----

  /** Whether a person has a window open right now (the host's own window counts for the person at the host). */
  personOnline(personId: string) {
    const atHost = personId === this.store.setting<string>("hostPersonId", "");
    return this.store.all("devices").some((d) => (d.personId === personId || (atHost && d.kind === "host")) && this.deviceOnline(d.id));
  }

  /** The people with a window open right now. */
  onlinePeople(): string[] {
    return this.people().filter((p) => this.personOnline(p.id)).map((p) => p.id);
  }

  /** Who is driving a screen: always a subset of the lock's owner and whoever they handed control to. */
  driversOf(screen = "main"): string[] {
    return this.lockOf(screen)?.drivers ?? [];
  }

  private setDrivers(screen: string, drivers: string[]) {
    const cur = this.stage(screen);
    if (!cur.lock) return;
    const { drivers: _old, ...lock } = cur.lock;
    this.atomically(() => this.commitStage({ ...cur, lock: { ...lock, lastActive: Date.now(), ...(drivers.length ? { drivers } : {}) } }, screen));
  }

  /**
   * Start, stop, pass or share driving. `by` is the person asking. Only the lock's owner starts, passes or shares; anyone driving
   * can stop themselves, and the owner can stop anyone. Says why when it can't.
   */
  drive(action: "start" | "stop" | "pass" | "together", screen: string, by: string | null, to?: string | null): { ok: true; drivers: string[] } | { ok: false; error: string; status: number } {
    const lock = this.lockOf(screen);
    const no = (error: string, status = 403) => ({ ok: false as const, error, status });
    if (!by || !this.person(by)) return no("Pick who you are in this window first.");
    if (!lock) return no("Put something on the screen first; driving belongs to whoever holds it.", 409);
    const drivers = lock.drivers ?? [];
    const owner = lock.personId === by;
    if (action === "stop") {
      const who = to && owner ? to : by;
      if (who !== by && !owner) return no(`Only ${lock.by} can stop someone else.`);
      this.setDrivers(screen, drivers.filter((d) => d !== who));
      return { ok: true, drivers: this.driversOf(screen) };
    }
    if (!owner) return no(`Only ${lock.by}, who holds the screen, can ${action === "start" ? "start driving it" : action === "pass" ? "pass control" : "drive together"}.`);
    if (action === "start") {
      if (!drivers.includes(by)) this.setDrivers(screen, [...drivers, by]);
      return { ok: true, drivers: this.driversOf(screen) };
    }
    const target = to ? this.person(to) : undefined;
    if (!target) return no("Pass it to a person in the room.", 404);
    if (target.id === by) return no("That's you already.", 400);
    if (!this.personOnline(target.id)) return no(`${target.name} isn't in the room right now.`, 409);
    this.setDrivers(screen, action === "pass" ? [target.id] : [...new Set([...drivers, by, target.id])]);
    return { ok: true, drivers: this.driversOf(screen) };
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
  showReady(id: string, who: ShowWho): StageResult {
    try {
      return this.atomically(() => this.showReadyIn(id, who));
    } catch (e) {
      if (e instanceof NotShown) return { applied: false, reason: e.message };
      throw e;
    }
  }

  /**
   * Why a stage would draw nothing, or null when it has something to draw: the one check for a cast, a queued item
   * and an approval. Content modes need at least one artifact that still exists (it may have been deleted while the
   * item waited); parity needs one in its columns or items.
   */
  unrenderable(st: Partial<Stage> & { mode: Stage["mode"] }): string | null {
    const known = new Set(this.artifacts().map((a) => a.id));
    const has = (ids: string[] | undefined) => (ids ?? []).some((i) => known.has(i));
    switch (st.mode) {
      case "spotlight":
      case "compare":
        return has(st.items) ? null : "None of the artifacts it shows exist any more.";
      case "parity":
        // What the screen draws: the columns when there are any, else the items (as stageTileKeys has it).
        return (st.columns?.length ? st.columns.some((c) => has(c.items)) : has(st.items)) ? null : "Neither side has an artifact that exists any more.";
      case "layout":
        return (st.layout?.tiles ?? []).some((t) => t.kind !== "artifact" || known.has(t.artifactId)) ? null : "Every artifact in that layout is gone.";
      default:
        return null;
    }
  }

  /** `showReady` inside a transaction: the item leaves the queue only if the stage really changed, else NotShown undoes it all. */
  private showReadyIn(id: string, who: ShowWho): StageResult & { applied: true } {
    const item = this.readyToShow().find((r) => r.id === id);
    if (!item) throw new NotShown("That item isn't waiting any more.");
    if ("claim" in who && !this.claimHolds(who.claim, item.screen)) throw new NotShown("The screen changed since; look again.");
    const wanted = parseStage(item.stage);
    if (!wanted.ok) throw new NotShown(wanted.error);
    const gone = this.unrenderable(wanted.stage);
    if (gone) throw new NotShown(gone);
    // A display that was unplugged since the item queued has no one looking at it.
    if (item.screen !== "main" && !this.screens().some((x) => x.id === item.screen)) throw new NotShown("That display isn't connected any more.");
    this.dismissReady(id);
    const r = this.setStage(wanted.stage, "person" in who ? who.person.name : item.agentName, item.screen, "person" in who ? who : "claim" in who ? { override: true, claim: who.claim, mayReplaceLock: who.mayReplaceLock } : who);
    if (!r.applied) throw new NotShown(r.reason);
    return r;
  }

  dismissReady(id: string) {
    this.store.setSetting("readyToShow", this.readyToShow().filter((r) => r.id !== id));
    this.after(() => bus.changed("readyToShow"));
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
      lockKey: lockKey(lock),
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
    if (!lock || lockKey(lock) !== (req.lockKey ?? `s${req.lockSince}`) || lock.personId !== req.ownerId || (approve && !waiting)) return this.expireShowRequest(req);
    const done: ShowRequest = { ...req, status: approve ? "approved" : "denied", decidedBy: by, at: approve ? req.at : Date.now() };
    // The approval, the item leaving the queue and the stage write happen together or not at all.
    try {
      this.atomically(() => {
        this.store.setSetting("showRequests", this.showRequests().map((r) => (r.id === id ? done : r)));
        if (approve) this.showReadyIn(req.readyId, { override: true });
        else this.touchLock(req.screen);
        this.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: approve ? `${by} said yes: ${req.agentName}'s ${req.label} is on the big screen.` : `${by} is keeping their screen up. ${req.agentName}'s ${req.label} waits in the queue.`, relevance: "work", data: { showRequest: id } });
        this.after(() => bus.changed("showRequests"));
      });
    } catch (e) {
      if (e instanceof NotShown) return this.expireShowRequest(req);
      throw e;
    }
    return done;
  }

  private expireShowRequest(req: ShowRequest): ShowRequest {
    const gone: ShowRequest = { ...req, status: "expired" };
    this.store.setSetting("showRequests", this.showRequests().map((r) => (r.id === req.id ? gone : r)));
    this.after(() => bus.changed("showRequests"));
    return gone;
  }

  /** A screen's lock changed: questions about the lock it had are over (their items stay queued). */
  private expireAsksFor(screen: string, lock: StageLock | undefined) {
    for (const r of this.store.setting<ShowRequest[]>("showRequests", []))
      if (r.screen === screen && r.status === "pending" && (!lock || lockKey(lock) !== (r.lockKey ?? `s${r.lockSince}`))) this.expireShowRequest(r);
  }

  // ---- history: what each screen showed (3.6) ----

  static HISTORY_MAX = 20;

  /** What a screen showed recently, newest first, with who put it up. */
  stageHistory(screen?: string): Record<string, StageHistoryEntry[]> {
    const raw = this.store.setting<unknown>("stageHistory", {});
    // Stored data is only trusted after a look: a record that isn't an entry with a stage that parses is skipped.
    const all: Record<string, StageHistoryEntry[]> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [k, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        all[k] = list.filter((e): e is StageHistoryEntry => !!e && typeof e === "object" && typeof (e as any).id === "string" && typeof (e as any).at === "number" && typeof (e as any).label === "string" && typeof (e as any).by === "string" && parseStage((e as any).stage).ok);
      }
    return screen ? { [screen]: all[screen] ?? [] } : all;
  }

  private recordHistory(stage: Stage, screen: string) {
    if (stage.mode === "board" || stage.mode === "welcome" || stage.mode === "join") return;
    // A share ends on its own, so a screen showing one can't be brought back.
    if (stage.mode === "layout" && stage.layout?.tiles.some((t) => t.kind === "screen")) return;
    const { lock: _l, since: _s, by: _b, revertAt: _r, ...snap } = stage;
    const sig = JSON.stringify(snap);
    const all = this.stageHistory();
    const mine = (all[screen] ?? []).filter((e) => JSON.stringify(e.stage) !== sig);
    const entry: StageHistoryEntry = { id: newId("his"), screen, at: stage.since, by: stage.by, label: stageLabel(stage, (id) => this.store.get("artifacts", id)?.title), stage: snap };
    this.store.setSetting("stageHistory", { ...all, [screen]: [entry, ...mine].slice(0, Session.HISTORY_MAX) });
    this.after(() => bus.changed("stageHistory"));
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
  restoreHistory(id: string, screen: string, who: { person: { id: string | null; name: string }; claim?: StageClaim; mayReplaceLock?: string } | { claim: StageClaim; mayReplaceLock?: string }, by = "JamSesh"): StageResult {
    const entry = (this.stageHistory(screen)[screen] ?? []).find((e) => e.id === id);
    if (!entry) return { applied: false, reason: "That screen is no longer in the history." };
    // The screen changed since the caller decided: nothing is restored, and the caller is told so.
    if (who.claim && !this.claimHolds(who.claim, screen)) return { applied: false, reason: "The screen changed since; look again." };
    const old = parseStage(entry.stage);
    if (!old.ok) return { applied: false, reason: old.error };
    const gone = this.unrenderable(old.stage);
    if (gone) return { applied: false, reason: gone };
    return this.setStage({ ...old.stage, pinned: false }, "person" in who ? who.person.name : by, screen, who);
  }
}

/**
 * What a piece of work saw of the screens when it decided (`Session.stageClaim`): each screen's revision then. A write
 * carrying it lands only on a screen still at that revision (compare-and-set), and moves the claim on, so the same
 * work's next write still lands. Anything that decides and writes later than the moment it acts on (the brain, whose
 * model takes seconds; an agent) carries one.
 */
/** What a stage write came to. A refused write changed nothing; callers must say so (there is no stage to read off a refusal). */
export type StageResult = { applied: true; stage: Stage } | { applied: false; reason: string };

type ShowWho = { person: { id: string | null; name: string }; claim?: StageClaim; mayReplaceLock?: string } | { override: true } | { claim: StageClaim; mayReplaceLock?: string };

/** Thrown inside a transaction when a queued item couldn't actually go up: everything the attempt wrote is undone. */
class NotShown extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/** A short fingerprint of a layout tile's content (for tile keys). */
function fingerprint(t: unknown): string {
  return createHash("sha256").update(JSON.stringify(t) ?? "").digest("hex").slice(0, 24);
}

/** A lock's identity for questions about it: its id, or (for one stored before ids) its start time. */
export function lockKey(lock: StageLock | null | undefined): string {
  return lock ? lock.id ?? `s${lock.since}` : "";
}

export interface StageClaim {
  revs: Map<string, number>;
}

interface StageOptsBase {
  person?: { id: string | null; name: string };
  /** Housekeeping that must happen whatever is locked: a share ending, an approved request, a timer. */
  override?: boolean;
  /** A person's action that shouldn't hold the screen (a share they started has its own hold). */
  noLock?: boolean;
  /** The new stage keeps this lock: the owner's own share over their cast, and that cast coming back when it ends. */
  keepLock?: StageLock;
  claim?: StageClaim;
  /** The write may replace the lock this person owns, and does so only if it lands. */
  mayReplaceLock?: string;
}

/**
 * How a setStage call says who is acting. Every write says one of: a person acting now (who may replace a lock and takes
 * one), the hub's own upkeep acting now, or a claim for work decided earlier. There is no write without one.
 */
export type StageOpts = StageOptsBase & ({ person: { id: string | null; name: string } } | { override: true } | { claim: StageClaim });

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

/** "Mobile nav / B: bottom tabs" → group "Mobile nav", variant "B". */
export function splitTitle(title: string): { group: string; variant: string } {
  const parts = title.split(/\s+\/\s+|\s+—\s+(?=[A-Z0-9]\b)/);
  if (parts.length < 2) return { group: title.trim(), variant: "" };
  const variant = parts.slice(1).join(" / ").trim();
  const letter = variant.match(/^(?:variant\s+|option\s+|direction\s+)?([A-Z0-9]{1,2})\b/i);
  return { group: parts[0].trim(), variant: letter ? letter[1].toUpperCase() : variant };
}
