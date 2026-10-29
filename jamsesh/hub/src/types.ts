// Shapes shared by the hub, the host view, and the client view.

export interface Person {
  id: string;
  name: string;
  role: string;
  /** How much this person's call counts when instructions conflict (1 = default). */
  weight: number;
  color: string;
  hasVoiceprint: boolean;
  voiceSamples: number;
  createdAt: number;
  /** Profile photo URL (from the person's camera), or null. */
  photo?: string | null;
}

export interface Device {
  id: string;
  label: string;
  personId: string | null;
  kind: "host" | "client";
  /** In the room with the host, or joining from somewhere else. */
  location: "room" | "remote";
  micOn: boolean;
  level: number;
  lastSeen: number;
}

export type Harness = "claude-code" | "codex" | "other";
export type Platform = "desktop" | "mobile" | "web" | "design" | "backend" | "other";
export type AgentStatus = "idle" | "working" | "waiting" | "blocked" | "offline";

export interface Agent {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string;
  harness: Harness;
  repo: string;
  branch: string;
  cwd: string;
  machine: string;
  /** The chat this agent is: Claude Code's session id (what its hooks carry) or the MCP connection. A second chat in the same folder is a different agent. */
  chatId?: string;
  platform: Platform;
  focus: string;
  status: AgentStatus;
  activity: string;
  lastSeen: number;
  joinedAt: number;
  canvas: "none" | "joining" | "live" | "failed";
  /** What this agent's repository is, as the agent describes it. */
  card?: RepoCard | null;
  /** An observer only watches: no repository, never routed product tasks. Absent means a worker. */
  role?: "worker" | "observer";
  /** An observer can opt out of room-wide messages (to "all"); absent means it gets them. */
  broadcasts?: boolean;
}

export interface RepoCard {
  stack: string;
  designSystem: string;
  components: string;
  branch: string;
  recentChanges: string;
  notes: string;
  updatedAt: number;
}

export interface Workstream {
  id: string;
  title: string;
  ownerAgentId: string | null;
  status: "active" | "paused" | "done";
  brief: string;
  updatedAt: number;
}

export type EventKind =
  | "speech"
  | "prompt"
  | "update"
  | "directive"
  | "decision"
  | "artifact"
  | "canvas"
  | "message"
  | "brain"
  | "join"
  | "system";

/** How the brain judged a room line. */
export type Relevance = "banter" | "chatter" | "discussion" | "work";

export interface JamEvent {
  id: number;
  ts: number;
  kind: EventKind;
  authorType: "person" | "agent" | "brain" | "system";
  authorId: string | null;
  authorName: string;
  text: string;
  relevance: Relevance | null;
  workstreamId: string | null;
  data: Record<string, any>;
}

export type DirectiveMode = "explore" | "implement" | "present" | "answer" | "coordinate" | "note";
export type DirectiveStatus = "pending" | "delivered" | "acked" | "done" | "cancelled";

export interface Directive {
  id: string;
  ts: number;
  text: string;
  mode: DirectiveMode;
  rationale: string;
  targets: string[];
  status: DirectiveStatus;
  /** Each target agent's own progress; status is done only when every target is. */
  progress: Record<string, DirectiveStatus>;
  priority: number;
  requestedBy: string;
  sourceEventIds: number[];
  workstreamId: string | null;
  result: string;
  deliveredAt: number | null;
  updatedAt: number;
  /** When JamSesh asked each target how it's going (an open task with no progress for a while). */
  nudgedAt?: Record<string, number>;
  /** When the room was offered a reassignment; the tile shows a Reassign button until the task moves. */
  reassignOfferedAt?: number;
}

export type ArtifactKind = "frame" | "screenshot" | "devserver" | "html" | "note";

export interface Artifact {
  id: string;
  ts: number;
  updatedAt: number;
  kind: ArtifactKind;
  /** Mockup = canvas design, Built = running code. */
  stage: "mockup" | "built";
  agentId: string | null;
  agentName: string;
  title: string;
  group: string;
  variant: string;
  platform: Platform | null;
  nodeId: string | null;
  url: string | null;
  image: string | null;
  width: number | null;
  height: number | null;
  workstreamId: string | null;
  note: string;
  /** Canvas page the frame is on. */
  page?: string;
  /** Which build of this screen this is; later builds of the same screen replace the image in place (3.5). */
  version?: number;
  /** The earlier builds, oldest first. They stay retrievable; only the newest shows. */
  versions?: ArtifactVersion[];
}

/** One earlier build of an artifact. */
export interface ArtifactVersion {
  version: number;
  at: number;
  title: string;
  image: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  note: string;
}

/** A long message or update, stored once; the feed and other agents' inboxes carry a short pointer to it. */
export interface Document {
  id: string;
  ts: number;
  authorId: string | null;
  authorName: string;
  title: string;
  text: string;
}

export interface DevServer {
  id: string;
  agentId: string;
  name: string;
  target: string;
  hostPort: number;
  url: string;
  platform: Platform | null;
  createdAt: number;
  up: boolean;
  /** Why it isn't answering, in words for the tile ("Chey's Context Gatherer stopped this build"). */
  problem?: string;
  /** Since when it hasn't answered; the tile clears itself a few minutes after. */
  downSince?: number;
}

export type StageMode = "board" | "spotlight" | "compare" | "parity" | "agents" | "canvas" | "custom" | "layout" | "welcome" | "join";

/** One cell of a layout the brain (or a person) puts on the big screen. */
export type Tile =
  | { kind: "artifact"; artifactId: string; label?: string }
  | { kind: "canvas"; follow?: string | null; page?: string | null; label?: string }
  | { kind: "web"; url: string; label?: string }
  | { kind: "screen"; shareId: string; label?: string }
  | { kind: "agent"; agentId: string; label?: string }
  | { kind: "html"; html: string; label?: string }
  | { kind: "feed"; label?: string };

export interface Layout {
  tiles: Tile[];
  /** CSS grid; omitted = JamSesh picks a bento for the tile count. */
  grid?: { columns: string; rows: string; areas: string[] };
}

/** A live screen or camera someone shares from their device. */
export interface Share {
  id: string;
  deviceId: string;
  personId: string | null;
  personName: string;
  kind: "screen" | "camera";
  label: string;
  status: "requested" | "live" | "ended" | "declined";
  reason: string;
  startedAt: number;
}

/** One curated piece of session knowledge the brain keeps current. */
export interface Fact {
  id: string;
  ts: number;
  updatedAt: number;
  kind: "decision" | "requirement" | "constraint" | "preference" | "question" | "fact";
  text: string;
  workstream: string;
  by: string;
  status: "active" | "resolved" | "superseded";
  note: string;
  sourceEventIds: number[];
}

export interface Annotation {
  id: string;
  ts: number;
  personId: string | null;
  authorName: string;
  target: {
    kind: "canvas" | "artifact" | "web" | "screen";
    /** artifact id, URL, or share id; for canvas, the frame name when known. */
    ref: string;
    label: string;
    nodeId?: string | null;
    canvasX?: number | null;
    canvasY?: number | null;
  };
  /** Position inside the target, 0..1. */
  x: number;
  y: number;
  text: string;
  source: "pin" | "pointer";
  status: "open" | "sent" | "done";
  promptEventId: number | null;
}

export interface Stage {
  mode: StageMode;
  title: string;
  caption: string;
  items: string[];
  /** For parity: [left items, right items]. */
  columns?: { label: string; items: string[] }[];
  layout?: Layout;
  html?: string;
  /** Canvas mode: follow a person's viewport, or open a page. */
  follow?: string | null;
  page?: string | null;
  /** The key of the tile filling the presentation area (the rest become a strip of thumbnails); unset when none is. */
  expanded?: string;
  pinned: boolean;
  since: number;
  by: string;
  /** Which big screen this is the stage of ("main", or "screen-2"...); a stage with none is the main screen's. */
  screenId?: string;
  /** Set when a person put this up: agents and the brain don't replace it until it's unlocked (3.1). */
  lock?: StageLock;
}

/** A person's hold on a screen. It ends when they unlock, leave, or 20 minutes pass without them touching it. */
export interface StageLock {
  by: string;
  personId: string | null;
  since: number;
  lastActive: number;
}

/** What an agent wanted to show while a screen was locked; it waits here until someone shows or dismisses it. */
export interface ReadyItem {
  id: string;
  at: number;
  screen: string;
  agentId: string;
  agentName: string;
  /** What it is, in words for the queue ("Checkout build"). */
  label: string;
  stage: Partial<Stage> & { mode: StageMode };
}

/** JamSesh asking a lock's owner whether an agent's item may replace their screen. */
export interface ShowRequest {
  id: string;
  at: number;
  screen: string;
  ownerId: string | null;
  ownerName: string;
  agentName: string;
  /** Whose agent it is ("Felipe"), for the question: "Felipe's agent has the checkout build ready". */
  agentOwner: string;
  label: string;
  readyId: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedBy?: string;
}

/** One thing a screen showed, and who put it up. */
export interface StageHistoryEntry {
  id: string;
  screen: string;
  at: number;
  by: string;
  /** Short words for the strip ("Checkout build", "3 screens"). */
  label: string;
  stage: Partial<Stage> & { mode: StageMode };
}

export interface Utterance {
  id: string;
  t0: number;
  t1: number;
  text: string;
  personId: string | null;
  speakerName: string;
  confidence: number;
  method: string;
  deviceId: string;
  devices: { deviceId: string; level: number; snr: number }[];
  location: "room" | "remote";
  eventId: number | null;
  engine: string;
}

export interface Settings {
  sessionName: string;
  /** What the room calls the brain; saying it addresses the brain directly. */
  brainName: string;
  /** Other names the brain answers to ("Computah", "computer"); each is heard like the display name. */
  brainAliases: string[];
  /** What the room told the brain about how to behave, kept across the session. */
  brainNotes: string[];
  brainEnabled: boolean;
  voiceReplies: boolean;
  voice: string;
  models: {
    triage: string;
    router: string;
    presenter: string;
    digest: string;
    speech: string;
    transcribe: string;
  };
  transcription: "auto" | "local" | "gateway";
  hostControl: boolean;
  /** Spoken language for transcription: an ISO code ("en" by default) or "auto". */
  language: string;
  /** The room's words for transcription (5.2): "Term" or "Term: heard as, heard as" ("Chey: Shay"). */
  vocabulary: string[];
  gatewayKeySet: boolean;
  gatewayKeySource: "settings" | "env" | "none";
}

/** An agent asking to build its branch on the host. Nothing runs until a person approves it. */
export interface BuildRequest {
  id: string;
  agentId: string;
  agentName: string;
  ownerName: string;
  repo: string;
  branch: string;
  command: string;
  /** A build from an agent's repository, or a shell command the brain wants to run. */
  kind?: "build" | "shell";
  open?: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  decidedBy?: string;
}

/** One big-screen window. "main" is the one with the header; user-less hosts add one per display. */
export interface ScreenInfo {
  id: string;
  /** What the room calls it ("Left TV"); the host app sets it (see Session.configureScreens). */
  name: string;
  role: "main" | "extra";
  width: number;
  height: number;
  dpr: number;
  screenX: number;
  screenY: number;
  at: number;
  stage: Stage;
}

export interface HubState {
  session: { name: string; code: string; startedAt: number; hubUrl: string; canvas: CanvasInfo; addresses: { label: string; url: string; reachable?: "yes" | "no" | "unknown" }[] };
  settings: Settings;
  people: Person[];
  devices: Device[];
  agents: Agent[];
  workstreams: Workstream[];
  directives: Directive[];
  artifacts: Artifact[];
  devservers: DevServer[];
  events: JamEvent[];
  utterances: Utterance[];
  stage: Stage;
  shares: Share[];
  annotations: Annotation[];
  facts: Fact[];
  buildRequests: BuildRequest[];
  /** Every big-screen window that has reported in (user-less hosts have one per display). */
  screens: ScreenInfo[];
  /** Agents' items waiting because a screen was locked (3.1). */
  readyToShow: ReadyItem[];
  /** Questions to a lock's owner that are still open. */
  showRequests: ShowRequest[];
  /** What each screen showed recently, newest first (3.6). */
  stageHistory: Record<string, StageHistoryEntry[]>;
  digest: string;
  /** How much the session holds in all; the lists above carry only the newest, /api/history/<what> pages the rest. */
  totals: { events: number; utterances: number; directives: number; artifacts: number };
  brain: { status: "ready" | "thinking" | "offline" | "no-key"; lastError: string | null };
  /** Voice matching labels lines by voice; off when the speaker model or its native library fails to load. */
  voiceprints: { available: boolean; reason: string; enrolled: number };
}

export interface CanvasInfo {
  status: "starting" | "live" | "failed" | "off";
  editLink: string | null;
  viewLink: string | null;
  wsEdit: string | null;
  wsView: string | null;
  reason: string | null;
  /** Goes up each time the canvas is announced (a new file published, or the server restarted):
   * people's canvases fetch their join link again when it changes. */
  generation: number;
}

export type BusMessage =
  | { type: "state"; state: HubState }
  | { type: "event"; event: JamEvent }
  | { type: "events-removed"; ids: number[] }
  | { type: "patch"; key: keyof HubState; value: any }
  | { type: "utterance"; utterance: Utterance }
  | { type: "stage"; stage: Stage }
  | { type: "toast"; text: string; tone: "info" | "directive" | "decision" | "warn"; detail?: string }
  | { type: "speak"; audio: string | null; text: string; mime: string }
  | { type: "level"; deviceId: string; level: number }
  | { type: "thinking"; on: boolean; label?: string }
  | { type: "rtc"; from: string; to: string; data: any }
  | { type: "chime"; deviceId: string | null }
  | { type: "share-ended"; shareId: string; deviceId: string; text: string }
  | { type: "share-request"; shareId: string; deviceIds: string[]; kind: "screen" | "camera"; reason: string; by: string };
