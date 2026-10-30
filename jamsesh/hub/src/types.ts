// Shapes shared by the hub, the host view, and the client view.

export type AttachmentKind = "image" | "pdf" | "text";

/** A file or image added to a message; fetched from /api/attachments/<id>. */
export interface AttachmentRef {
  id: string;
  name: string;
  /** What the bytes are, from sniffing: image/png, application/pdf, text/plain... */
  type: string;
  kind: AttachmentKind;
  size: number;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  /** How much this person's call counts when instructions conflict (1 = default). */
  weight: number;
  color: string;
  hasVoiceprint: boolean;
  voiceSamples: number;
  /** What the voiceprint was learned from: reads aloud, corrections, lines heard. */
  voiceLearned?: { read: number; corrections: number; heard: number };
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
  /** The window that registered it: its pairing id, or "host" for the host's own windows. Only that window starts or ends its shares. */
  pairedId?: string;
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
  /** The chat this agent is: Claude Code's session id (what its hooks carry) or the MCP connection. A second Claude Code chat in the same folder is a different agent; Codex chats are keyed by machine and folder, so two in one folder are one agent. */
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

/** A chat the room removed (Session.removedChats): kept out until a person lets it back in. */
export interface RemovedChat {
  id: string;
  agentId: string;
  chatId: string | null;
  machine: string;
  /** Its folder and harness: a join that can't name its chat (a fresh MCP session) from there is this chat as far as anyone can tell. */
  cwd?: string;
  harness?: Agent["harness"];
  name: string;
  ownerName: string;
  at: number;
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
  carriedFrom?: CarriedFrom;
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
  /** The agents a coordinate directive's target compares with: finishing it needs a reply from one of them. */
  counterparts?: string[];
  status: DirectiveStatus;
  /** Set when the directive is made for something that must happen once (a recording's notes for one agent): a repeat finds this one. */
  key?: string;
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
  /** Per target: when it last showed progress on this task (delivery, ack, a linked update, a status change). */
  signs?: Record<string, number>;
  /** Per target: when the room was offered a reassignment; that target's tile shows a Reassign button until it resumes or the task moves. */
  reassignOfferedAt?: Record<string, number>;
  /** Files and images that came with the request; agents fetch them from /api/attachments/<id>. */
  attachments?: AttachmentRef[];
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
  /** What people said about it right after it went up ("this is cool"), saved by the room brain (4.2). */
  reactions?: ArtifactReaction[];
  /** The task it was made for: the one its agent was working on when it first went up, when that was only one. */
  directiveId?: string | null;
}

export interface ArtifactReaction {
  by: string;
  text: string;
  at: number;
  eventId: number;
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
  /** Goes up each time it is registered again (same id), so a check of an earlier registration is told apart. */
  generation?: number;
  up: boolean;
  /** Why it isn't answering, in words for the tile ("Chey's Context Gatherer stopped this build"). */
  problem?: string;
  /** Since when it hasn't answered; the tile clears itself a few minutes after. */
  downSince?: number;
  /** Where an HTTPS page reaches it (the hub's dev subdomain), when the hub serves one; absent through a tunnel or without remote access. */
  publicUrl?: string;
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
  | { kind: "feed"; label?: string }
  | { kind: "app"; appId: string; label?: string };

export interface Layout {
  tiles: Tile[];
  /** CSS grid; omitted = JamSesh picks a bento for the tile count. */
  grid?: { columns: string; rows: string; areas: string[] };
}

/** An iPhone build in the Simulator, or a Mac app, streaming live from the host (6.3). */
export interface LiveApp {
  id: string;
  kind: "ios" | "mac";
  name: string;
  status: "live" | "gone";
  /** The screen in points (a Mac app's window; 0 until its first frame). Taps are mapped onto this. */
  width: number;
  height: number;
  orientation: "portrait" | "landscape-left";
  appearance: "light" | "dark" | null;
  /** iOS: how the picture is captured: the Simulator's window at 30 fps, or screenshots (about 8 to 15 fps). */
  capture?: "window" | "screenshots";
  /** One line on how to get the faster capture, when it isn't on. */
  hint?: string;
  /** Whether taps can reach it. Watching works without. */
  canTap: boolean;
  /** Who is driving: one person at a time. */
  controller: { personId: string | null; name: string; since: number } | null;
  /** On a locked big screen the screen's drivers (6.1) drive the tile, not its own controller: who they are, and which screen. */
  drivers?: { personId: string; name: string }[];
  viaScreen?: string;
  startedBy: string;
  startedAt: number;
  /** Why it can't be driven, or why it ended, in words for the tile. */
  note?: string;
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
  /** Ended because its window lost the hub (or the hub restarted), not by anyone: only such a share is registered again. */
  lost?: boolean;
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
  /** Set when the project's context carried this over from an earlier session (SPEC 12.7). */
  carriedFrom?: CarriedFrom;
}

export interface CarriedFrom {
  sessionId: string;
  at: number;
  /** The item's id in the project's context (carryover.ts), so a change to it here updates that row. */
  id?: string;
}

/** One line the card came from: what was heard, who said it, and the transcript moment it links to. */
export interface TriageSource {
  eventId: number | null;
  authorName: string;
  text: string;
  ts: number;
}

/**
 * A proposal waiting for a person on the Tasks board (4.1): a task the room seemed to ask for, or a piece
 * of context (a decision, a constraint…) JamSesh heard or an agent reported. Nothing reaches the agents
 * until someone sends or adds it. Cards never expire; they only leave the board when someone acts.
 */
export interface TriageCard {
  id: string;
  ts: number;
  updatedAt: number;
  type: "task" | "context";
  status: "open" | "sent" | "added" | "merged" | "replaced" | "dismissed";
  /** Overheard in the room, reported by an agent, or taken from a document someone attached. */
  origin: "overheard" | "agent" | "document";
  /** The wording now (a person may have changed it); `original` is what was proposed. */
  text: string;
  original: string;
  /** The person (or agent) it came from. */
  by: string;
  /** Task: how to work, and who. */
  mode: DirectiveMode;
  targets: string[];
  /** For a comparison: the agents the targets compare with (other targets count too). */
  counterparts?: string[];
  /** Context: what kind of knowledge it is. */
  kind: Fact["kind"];
  workstream: string;
  /** Context that disagrees with a saved fact: Replace puts this one in its place. */
  conflictsWith: string | null;
  /** A card that only retires the saved fact it names (answered, or replaced by something not worded yet). */
  retire?: "superseded" | "resolved";
  /** Files that came with it (a document sent with no request). */
  attachments?: AttachmentRef[];
  /** Its wording is only a placeholder (a file with no text JamSesh could read): a person writes the fact before Add. */
  needsWording?: boolean;
  /** Files offered with the request past the six a card holds: they were not added, and the card says so. */
  extraFiles?: number;
  /** Ids of the room lines this card has taken in (the last 2000), kept apart from the dozen it shows, so a replay isn't counted again. */
  seen?: number[];
  /** A task card that cancels this directive when a person sends it; its text is the reason the agents read. */
  cancels?: string;
  /** A later line in the room overruled this proposal; it waits for a person to dismiss it like any other. */
  overruled?: string;
  /** Every overrule of it: why, who, when, and the lines it came from. Never cleared; the same ask said again makes a new card. */
  vetoes?: { reason: string; by: string; at: number; eventIds: number[] }[];
  /** The targets' names when they were chosen. */
  targetNames?: Record<string, string>;
  /** Agents a Send found gone or only watching (their names): nothing was sent; a person changes the agents with Edit. */
  unavailable?: string[];
  /** This card asks again for a proposal that was overruled (that card's id), which keeps its veto. */
  renews?: string;
  sources: TriageSource[];
  /** How many times it was proposed: repeats join this card. */
  count: number;
  edits: { by: string; at: number; fields: string[] }[];
  resolvedBy: string;
  resolvedAt: number | null;
  /** What accepting it made. */
  directiveId: string | null;
  factId: string | null;
  /** When JamSesh last mentioned it out loud as waiting. */
  mentionedAt: number | null;
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
    /** The page of the build or canvas it was on when pinned. */
    page?: string | null;
  };
  /** Scroll position of the page or viewer at the moment it was pinned. */
  scroll?: { x: number; y: number } | null;
  /** Set when pinned from a recording on a big screen: which one. */
  screenId?: string | null;
  /** The recording this pin came from, and its note, so a repeated send never doubles it. */
  recordingId?: string;
  noteId?: string;
  /** A picture of the spot (a crop of the item), when one could be made. */
  crop?: string | null;
  /** Position inside the target, 0..1. */
  x: number;
  y: number;
  text: string;
  source: "pin" | "pointer";
  status: "open" | "sent" | "done";
  promptEventId: number | null;
}

/** One pointer moment in a recording (after CursorCap's dwell/click model), with where it happened. */
export interface RecordMark {
  t: number;
  kind: "dwell" | "click" | "drag" | "move";
  x: number;
  y: number;
  dur?: number;
  target: Annotation["target"];
  /** Who was pointing, when more than one person drives the same screen. */
  driverId?: string | null;
  scroll?: { x: number; y: number } | null;
  word?: string;
}

/** What a note is pinned to. */
export interface NotePin {
  target: Annotation["target"];
  x: number;
  y: number;
  kind: RecordMark["kind"];
  scroll?: { x: number; y: number } | null;
}

/** A thing said while pointing, ready to tidy and send. */
export interface RecordNote {
  id: string;
  text: string;
  t0: number;
  t1: number;
  personId: string | null;
  pin: NotePin | null;
  /** The big screen it was said on, or none for the person's own screen. */
  screenId?: string | null;
  /** Who gets it: the agent that owns the item pinned, or null (the room brain decides). */
  ownerId?: string | null;
  ownerName?: string | null;
}

/** A recording in progress, so every window can show who is recording and where. */
export interface ActiveRecording {
  id: string;
  deviceId: string;
  personId: string | null;
  personName: string;
  /** The big screen being recorded, or null for the person's own screen. */
  screenId: string | null;
  since: number;
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
  /** The person who pinned it (their id); unset when no identified person did. */
  pinnedById?: string;
  /** When a brought-up screen goes back to the board by itself (ms). Saved with the stage in the same write as every action that restarts the wait, so a restart or a returning screen resumes the same deadline. */
  revertAt?: number;
  since: number;
  by: string;
  /** Which big screen this is the stage of ("main", or "screen-2"...); a stage with none is the main screen's. */
  screenId?: string;
  /** Set when a person put this up: agents and the brain don't replace it until it's unlocked (3.1). */
  lock?: StageLock;
}

/** A person's hold on a screen. It ends when they unlock, leave, or 20 minutes pass without them touching it. */
/** A tile of a screen's stage that can be expanded: its key, and what it shows (an artifact, or the nth tile of a layout). */
export interface StageTileKey {
  key: string;
  artifactId?: string;
  layoutIndex?: number;
  /** A parity tile's source: its column and its place in that column's stored list (before missing artifacts are skipped). */
  parity?: { column: number; place: number };
}

export interface StageLock {
  /** Tells this lock from any other, even one made in the same millisecond; questions about a lock are bound to it. Locks stored before it existed have none (see lockKey). */
  id?: string;
  by: string;
  personId: string | null;
  since: number;
  lastActive: number;
  /** People driving this screen right now (6.1): the owner, and whoever they passed control to. Ends with the lock. */
  drivers?: string[];
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
  /** The lock asked about (its `since`): an answer counts only while that same lock holds the screen. */
  lockSince: number;
  /** The lock this was asked about (`lockKey`); `lockSince` alone is how older requests name it. */
  lockKey?: string;
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
    digest: string;
    speech: string;
    transcribe: string;
  };
  transcription: "auto" | "local" | "gateway";
  hostControl: boolean;
  /** Spoken language for transcription: an ISO code ("en" by default) or "auto". */
  language: string;
  /** The opt-in faster engine (Parakeet, English only, a 482 MB download and about 2 GB of memory). */
  fastEngine: boolean;
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

/** A font the room can draw with. Names and counts only: the bytes are served to canvases and never listed. */
export interface FontInfo {
  key: string;
  family: string;
  /** "open": an OFL or Apache font fetched for the repositories; "borrowed": lent by one person for the session. */
  kind: "open" | "borrowed";
  source: string;
  license: string | null;
  faces: number;
  bytes: number;
  lenderId?: string;
  lender?: string;
}

/** A family some canvas shows in a substitute, and who has been asked. */
export interface FontWant {
  key: string;
  family: string;
  askedBy: string[];
  declinedBy: string[];
  since: number;
}

export interface FontsState {
  available: FontInfo[];
  wanted: FontWant[];
}

export interface HubState {
  session: { roomId: string; name: string; code: string; silent: boolean; startedAt: number; hubUrl: string; canvas: CanvasInfo; addresses: { label: string; url: string; reachable?: "yes" | "no" | "unknown" }[] };
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
  /** Recordings running now. */
  recordings: ActiveRecording[];
  facts: Fact[];
  /** Cards on the Tasks board: every open one, and the last few that were acted on. */
  triage: TriageCard[];
  buildRequests: BuildRequest[];
  /** Simulator and Mac apps streaming live from the host (6.3). */
  liveApps: LiveApp[];
  /** The fonts canvases draw with, and the ones nobody has yet (SPEC 12.4). */
  fonts: FontsState;
  /** Every big-screen window that has reported in (user-less hosts have one per display). */
  screens: ScreenInfo[];
  /** Agents' items waiting because a screen was locked (3.1). */
  readyToShow: ReadyItem[];
  /** Questions to a lock's owner that are still open. */
  showRequests: ShowRequest[];
  /** What each screen showed recently, newest first (3.6). */
  stageHistory: Record<string, StageHistoryEntry[]>;
  /** Each screen's expandable tiles, in the order the screen draws them. The hub alone decides their keys; windows draw from this. */
  stageTiles: Record<string, StageTileKey[]>;
  digest: string;
  /** How much the session holds in all; the lists above carry only the newest, /api/history/<what> pages the rest. */
  totals: { events: number; utterances: number; directives: number; artifacts: number };
  brain: { status: "ready" | "thinking" | "offline" | "no-key"; lastError: string | null };
  /** Voice matching labels lines by voice; off when the speaker model or its native library fails to load. */
  voiceprints: { available: boolean; reason: string; code: string; fix: string; enrolled: number; lines: number; byVoice: number; neverUsed: boolean };
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

/** One bit of a driver's input, positions as fractions 0..1 of the screen's stage area (SPEC 10.6). */
export type DriveEvent =
  | { k: "move"; x: number; y: number }
  | { k: "down" | "up"; x: number; y: number; b?: number; n?: number }
  | { k: "wheel"; x: number; y: number; dx: number; dy: number; ctrl?: boolean }
  | { k: "key"; key: string; code?: string; down: boolean; mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } }
  | { k: "leave" };

export type BusMessage =
  | { type: "state"; state: HubState }
  | { type: "event"; event: JamEvent }
  | { type: "events-removed"; ids: number[] }
  /** The list of removed chats changed (a chat removed, or allowed again): windows showing it reload. */
  | { type: "removed-chats" }
  | { type: "patch"; key: keyof HubState; value: any }
  | { type: "utterance"; utterance: Utterance }
  | { type: "stage"; stage: Stage }
  | { type: "toast"; text: string; tone: "info" | "directive" | "decision" | "warn"; detail?: string }
  | { type: "speak"; audio: string | null; text: string; mime: string }
  | { type: "level"; deviceId: string; level: number }
  | { type: "thinking"; on: boolean; label?: string }
  | { type: "rtc"; from: string; to: string; data: any }
  | { type: "drive"; screen: string; personId: string; name: string; color: string; ev: DriveEvent; t: number }
  | { type: "chime"; deviceId: string | null }
  | { type: "share-ended"; shareId: string; deviceId: string; text: string }
  | { type: "share-request"; shareId: string; deviceIds: string[]; kind: "screen" | "camera"; reason: string; by: string };
