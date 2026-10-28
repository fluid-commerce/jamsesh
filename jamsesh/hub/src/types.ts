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
  platform: Platform;
  focus: string;
  status: AgentStatus;
  activity: string;
  lastSeen: number;
  joinedAt: number;
  canvas: "none" | "joining" | "live" | "failed";
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

export type DirectiveMode = "explore" | "implement" | "present" | "answer" | "coordinate";
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
}

export type StageMode = "board" | "spotlight" | "compare" | "parity" | "agents" | "canvas" | "custom" | "layout" | "welcome";

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
  pinned: boolean;
  since: number;
  by: string;
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
  eventId: number | null;
  engine: string;
}

export interface Settings {
  sessionName: string;
  /** What the room calls the brain; saying it addresses the brain directly. */
  brainName: string;
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
  gatewayKeySet: boolean;
  gatewayKeySource: "settings" | "env" | "none";
}

export interface HubState {
  session: { name: string; code: string; startedAt: number; hubUrl: string; canvas: CanvasInfo };
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
  digest: string;
  brain: { status: "ready" | "thinking" | "offline" | "no-key"; lastError: string | null };
}

export interface CanvasInfo {
  status: "starting" | "live" | "failed" | "off";
  editLink: string | null;
  viewLink: string | null;
  wsEdit: string | null;
  wsView: string | null;
  reason: string | null;
}

export type BusMessage =
  | { type: "state"; state: HubState }
  | { type: "event"; event: JamEvent }
  | { type: "patch"; key: keyof HubState; value: any }
  | { type: "utterance"; utterance: Utterance }
  | { type: "stage"; stage: Stage }
  | { type: "toast"; text: string; tone: "info" | "directive" | "decision" | "warn"; detail?: string }
  | { type: "speak"; audio: string | null; text: string; mime: string }
  | { type: "level"; deviceId: string; level: number }
  | { type: "thinking"; on: boolean; label?: string }
  | { type: "rtc"; from: string; to: string; data: any }
  | { type: "chime"; deviceId: string | null }
  | { type: "share-request"; shareId: string; deviceIds: string[]; kind: "screen" | "camera"; reason: string; by: string };
