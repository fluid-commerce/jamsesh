// The session: people, devices, agents, workstreams, directives, artifacts and the
// stage. Every other part of the hub (brain, audio, canvas, MCP, HTTP) goes through it.
import { bus } from "./bus";
import { config } from "./config";
import { newId, PALETTE, Store } from "./store";
import type {
  Agent,
  Annotation,
  Artifact,
  Fact,
  CanvasInfo,
  Device,
  DevServer,
  Directive,
  DirectiveMode,
  HubState,
  JamEvent,
  Person,
  Platform,
  Settings,
  Share,
  Stage,
  Workstream,
} from "./types";

export const DEFAULT_MODELS: Settings["models"] = {
  triage: "google/gemini-3.5-flash-lite",
  router: "anthropic/claude-sonnet-5.5",
  presenter: "anthropic/claude-sonnet-5.5",
  digest: "google/gemini-3.5-flash",
  speech: "openai/tts-1",
  transcribe: "openai/gpt-transcribe",
};

export type UpdateKind = "progress" | "done" | "question" | "blocked" | "handoff" | "decision" | "shipped";

type Waiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> };

export class Session {
  store: Store;
  code: string;
  startedAt = Date.now();
  canvas: CanvasInfo = { status: "off", editLink: null, viewLink: null, wsEdit: null, wsView: null, reason: null };
  brainStatus: HubState["brain"] = { status: "ready", lastError: null };
  private waiters = new Map<string, Set<Waiter>>();
  private stageRevert: ReturnType<typeof setTimeout> | null = null;
  /** Hooks for other modules (set by index.ts) so the session stays dependency-free. */
  onDirective: ((d: Directive) => void) | null = null;
  onUpdate: ((agent: Agent, kind: UpdateKind, text: string, ev: JamEvent) => void) | null = null;

  constructor(store: Store) {
    this.store = store;
    this.code = store.setting("sessionCode", "") || makeCode();
    store.setSetting("sessionCode", this.code);
    // Agents outlive a hub restart: they reconnect on their next call, and directives wait in their inbox.
    for (const a of store.all("agents")) if (a.status !== "offline") store.put("agents", { ...a, status: "idle", canvas: "none" }, false);
    for (const d of store.all("devices")) store.put("devices", { ...d, micOn: false, level: 0 }, false);
    bus.resolver = (key) => this.resolve(key);
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
      brainNotes: s.setting<string[]>("brainNotes", []),
      brainEnabled: s.setting("brainEnabled", true),
      voiceReplies: s.setting("voiceReplies", true),
      voice: s.setting("voice", "nova"),
      models: { ...DEFAULT_MODELS, ...s.setting<Partial<Settings["models"]>>("models", {}) },
      transcription: s.setting("transcription", "auto"),
      hostControl: s.setting("hostControl", true),
      gatewayKeySet: keyInSettings || !!config.envGatewayKey,
      gatewayKeySource: keyInSettings ? "settings" : config.envGatewayKey ? "env" : "none",
    };
  }

  gatewayKey(): string | undefined {
    return this.store.setting<string>("gatewayKey", "") || config.envGatewayKey || undefined;
  }

  updateSettings(patch: Partial<Settings> & { gatewayKey?: string }) {
    const allowed = ["sessionName", "brainName", "brainNotes", "brainEnabled", "voiceReplies", "voice", "transcription", "hostControl"] as const;
    for (const k of allowed) if (patch[k] !== undefined) this.store.setSetting(k, patch[k]);
    if (patch.models) this.store.setSetting("models", { ...this.store.setting("models", {}), ...patch.models });
    if (patch.gatewayKey !== undefined) this.store.setSetting("gatewayKey", patch.gatewayKey.trim());
    bus.changed("settings");
    bus.changed("session");
  }

  // ---- state for the views ----

  state(): HubState {
    return {
      session: { name: this.settings().sessionName, code: this.code, startedAt: this.startedAt, hubUrl: this.hubUrl, canvas: this.canvas },
      settings: this.settings(),
      people: this.people(),
      devices: this.store.all("devices"),
      agents: this.agents(),
      workstreams: this.store.all("workstreams").sort((a, b) => b.updatedAt - a.updatedAt),
      directives: this.directives().slice(0, 60),
      artifacts: this.artifacts().slice(0, 120),
      devservers: this.store.all("devservers"),
      events: this.store.recentEvents({ limit: 250 }).map(publicEvent),
      utterances: this.store.all("utterances").sort((a, b) => a.t0 - b.t0).slice(-200),
      stage: this.stage(),
      shares: this.shares(),
      annotations: this.annotations(),
      facts: this.facts(),
      digest: this.store.digest("session")?.text ?? "",
      brain: this.brainStatus,
    };
  }

  private resolve(key: string): { key: any; value: any } | null {
    switch (key) {
      case "people":
        return { key, value: this.people() };
      case "devices":
        return { key, value: this.store.all("devices") };
      case "agents":
        return { key, value: this.agents() };
      case "workstreams":
        return { key, value: this.store.all("workstreams").sort((a, b) => b.updatedAt - a.updatedAt) };
      case "directives":
        return { key, value: this.directives().slice(0, 60) };
      case "artifacts":
        return { key, value: this.artifacts().slice(0, 120) };
      case "devservers":
        return { key, value: this.store.all("devservers") };
      case "utterances":
        return { key, value: this.store.all("utterances").sort((a, b) => a.t0 - b.t0).slice(-200) };
      case "digest":
        return { key, value: this.store.digest("session")?.text ?? "" };
      case "shares":
        return { key, value: this.shares() };
      case "annotations":
        return { key, value: this.annotations() };
      case "facts":
        return { key, value: this.facts() };
      case "settings":
        return { key, value: this.settings() };
      case "session":
      case "canvas":
        return { key: "session", value: this.state().session };
      case "brain":
        return { key, value: this.brainStatus };
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
    return (
      all.find((p) => p.name.toLowerCase() === n) ??
      all.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]) ??
      all.find((p) => p.name.toLowerCase().startsWith(n))
    );
  }

  upsertPerson(fields: { id?: string; name: string; role?: string; weight?: number }): Person {
    const existing = fields.id ? this.store.get("people", fields.id) : this.personByName(fields.name);
    if (existing) {
      return this.store.put("people", {
        ...existing,
        name: fields.name.trim() || existing.name,
        role: fields.role ?? existing.role,
        weight: fields.weight ?? existing.weight,
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
      micOn: fields.micOn ?? cur?.micOn ?? false,
      level: fields.level ?? cur?.level ?? 0,
      lastSeen: Date.now(),
    };
    const changed = !cur || cur.label !== d.label || cur.personId !== d.personId || cur.micOn !== d.micOn || cur.kind !== d.kind;
    this.store.put("devices", d, changed);
    return d;
  }

  // ---- agents ----

  agents(): Agent[] {
    const now = Date.now();
    return this.store
      .all("agents")
      .map((a) => (a.status !== "offline" && now - a.lastSeen > 20 * 60_000 ? { ...a, status: "offline" as const } : a))
      .sort((a, b) => a.joinedAt - b.joinedAt);
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
  }): { agent: Agent; resumed: boolean } {
    const owner = this.personByName(info.ownerName) ?? (info.ownerName ? this.upsertPerson({ name: info.ownerName }) : undefined);
    const existing = this.store
      .all("agents")
      .find((a) => a.machine === info.machine && (info.cwd ? a.cwd === info.cwd : a.repo === info.repo) && a.harness === info.harness);
    const harnessLabel = info.harness === "codex" ? "Codex" : info.harness === "claude-code" ? "Claude" : "Agent";
    const ownerFirst = (owner?.name ?? info.ownerName ?? "Someone").split(/\s+/)[0];
    const sameOwner = this.store.all("agents").filter((a) => a.ownerId === owner?.id && a.id !== existing?.id && a.harness === info.harness);
    const baseName = info.name?.trim() || `${ownerFirst}'s ${harnessLabel}${sameOwner.length ? ` (${shortRepo(info.repo)})` : ""}`;
    const agent: Agent = {
      id: existing?.id ?? newId("a"),
      name: existing && !info.name ? existing.name : baseName,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? info.ownerName,
      harness: info.harness,
      repo: info.repo,
      branch: info.branch ?? existing?.branch ?? "",
      cwd: info.cwd ?? existing?.cwd ?? "",
      machine: info.machine,
      platform: info.platform ?? existing?.platform ?? "other",
      focus: info.focus ?? existing?.focus ?? "",
      status: "idle",
      activity: existing ? "Back in the session" : "Just joined",
      lastSeen: Date.now(),
      joinedAt: existing?.joinedAt ?? Date.now(),
      canvas: existing?.canvas ?? "none",
    };
    this.store.put("agents", agent);
    this.store.addEvent({
      kind: "system",
      authorType: "agent",
      authorId: agent.id,
      authorName: agent.name,
      text: `${agent.name} ${existing ? "rejoined" : "joined"}: ${shortRepo(agent.repo)}${agent.branch ? ` @ ${agent.branch}` : ""}${agent.focus ? `, ${agent.focus}` : ""}.`,
      data: { platform: agent.platform },
    });
    return { agent, resumed: !!existing };
  }

  touchAgent(id: string, fields: Partial<Agent> = {}) {
    const a = this.store.get("agents", id);
    if (!a) return;
    const status = fields.status ?? (a.status === "offline" ? "idle" : a.status);
    const next = { ...a, ...fields, status, lastSeen: Date.now() };
    const visible = a.status !== next.status || a.activity !== next.activity || a.canvas !== next.canvas || a.focus !== next.focus;
    this.store.put("agents", next, visible);
  }

  findAgentByCwd(cwd: string, machine?: string): Agent | undefined {
    const want = normalizePath(cwd);
    const agents = this.store.all("agents").filter((a) => a.cwd);
    const all = agents.filter((a) => {
      const have = normalizePath(a.cwd);
      return want === have || want.startsWith(have + "/");
    });
    const exact = (machine && all.find((a) => a.machine === machine)) || all.sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (exact) return exact;
    // Same folder name on the same machine (the agent may have reported its path another way).
    const base = want.split("/").pop();
    const byName = agents.filter((a) => a.machine === machine && normalizePath(a.cwd).split("/").pop() === base);
    return byName.length === 1 ? byName[0] : undefined;
  }

  postUpdate(agentId: string, kind: UpdateKind, text: string, extra: { workstream?: string; data?: Record<string, any> } = {}) {
    const agent = this.agent(agentId);
    if (!agent) throw new Error("Unknown agent; call jam_join first.");
    const ws = extra.workstream ? this.claim(agentId, extra.workstream, { quiet: true }).workstream : undefined;
    const ev = this.store.addEvent({
      kind: kind === "decision" ? "decision" : "update",
      authorType: "agent",
      authorId: agentId,
      authorName: agent.name,
      text,
      workstreamId: ws?.id ?? null,
      relevance: "work",
      data: { updateKind: kind, ...(extra.data ?? {}) },
    });
    const status = kind === "blocked" || kind === "question" ? "blocked" : kind === "done" || kind === "shipped" ? "idle" : "working";
    this.touchAgent(agentId, { status, activity: text.slice(0, 140) });
    if (kind === "question" || kind === "blocked") bus.send({ type: "toast", tone: "warn", text: `${agent.name} needs the room`, detail: text });
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
      const owner = this.agent(existing.ownerAgentId);
      if (owner && owner.status !== "offline") {
        return { workstream: existing, conflict: owner };
      }
    }
    const ws: Workstream = existing
      ? { ...existing, ownerAgentId: agentId, status: "active", updatedAt: Date.now() }
      : { id: newId("w"), title: t, ownerAgentId: agentId, status: "active", brief: "", updatedAt: Date.now() };
    this.store.put("workstreams", ws);
    if (!opts.quiet && agent) {
      this.store.addEvent({ kind: "system", authorType: "agent", authorId: agentId, authorName: agent.name, text: `${agent.name} took "${ws.title}".`, workstreamId: ws.id });
    }
    return { workstream: ws, conflict: null as Agent | null };
  }

  // ---- directives ----

  directives(): Directive[] {
    return this.store.all("directives").sort((a, b) => b.ts - a.ts);
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
  }): Directive {
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
    this.onDirective?.(directive);
    return directive;
  }

  setDirective(id: string, fields: Partial<Directive>) {
    return this.store.patch("directives", id, { ...fields, updatedAt: Date.now() });
  }

  /** One agent's progress on a directive; the directive's status follows the slowest target. */
  setDirectiveFor(id: string, agentId: string, status: Directive["status"], result?: string) {
    const d = this.store.get("directives", id);
    if (!d) return undefined;
    const progress = { ...(d.progress ?? Object.fromEntries(d.targets.map((t) => [t, d.status]))), [agentId]: status };
    const order: Directive["status"][] = ["pending", "delivered", "acked", "done", "cancelled"];
    const states = d.targets.map((t) => progress[t] ?? "pending");
    const finished = states.every((x) => x === "done" || x === "cancelled");
    const overall = finished ? (states.includes("done") ? "done" : "cancelled") : states.map((x) => order.indexOf(x)).reduce((a, b) => Math.min(a, b)) >= 2 ? "acked" : states.some((x) => x !== "pending") ? "delivered" : "pending";
    const res = result ? [d.result, `${this.agent(agentId)?.name ?? agentId}: ${result}`].filter(Boolean).join("\n") : d.result;
    return this.setDirective(id, { progress, status: overall as Directive["status"], result: res });
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
    const messages = this.store
      .recentEvents({ kinds: ["message"], afterId: lastRead, limit: 50 })
      .filter((e) => e.data.to === agentId || (e.data.to === "all" && e.authorId !== agentId));
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

  sendMessage(fromAgentId: string, to: string, text: string, data: Record<string, any> = {}) {
    const from = this.agent(fromAgentId);
    if (!from) throw new Error("Unknown agent; call jam_join first.");
    const target = to === "all" ? null : this.agent(to) ?? this.store.all("agents").find((a) => a.name.toLowerCase() === to.toLowerCase());
    if (to !== "all" && !target) throw new Error(`No agent named ${to}. Call jam_agents to see who is here.`);
    const ev = this.store.addEvent({
      kind: "message",
      authorType: "agent",
      authorId: from.id,
      authorName: from.name,
      text,
      relevance: "work",
      data: { to: target?.id ?? "all", toName: target?.name ?? "everyone", ...data },
    });
    if (target) this.wake(target.id);
    else for (const a of this.store.all("agents")) if (a.id !== from.id) this.wake(a.id);
    return ev;
  }

  // ---- artifacts ----

  artifacts(): Artifact[] {
    return this.store.all("artifacts").sort((a, b) => b.updatedAt - a.updatedAt);
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

  // ---- screen and camera shares ----

  shares(): Share[] {
    return this.store.all("shares").filter((x) => x.status === "live" || (x.status === "requested" && Date.now() - x.startedAt < 120_000)).sort((a, b) => a.startedAt - b.startedAt);
  }

  devicesOf(personId: string) {
    return this.store.all("devices").filter((d) => d.personId === personId && d.kind === "client" && Date.now() - d.lastSeen < 10 * 60_000);
  }

  /** The host asks someone to share; their JamSesh window asks them first. */
  requestShare(personId: string, kind: Share["kind"], reason: string, by: string): Share | null {
    const person = this.person(personId);
    const devices = this.devicesOf(personId);
    if (!person || !devices.length) return null;
    const share: Share = { id: newId("sh"), deviceId: devices[0].id, personId, personName: person.name, kind, label: `${person.name}'s ${kind}`, status: "requested", reason, startedAt: Date.now() };
    this.store.put("shares", share);
    bus.send({ type: "share-request", shareId: share.id, deviceIds: devices.map((d) => d.id), kind, reason, by });
    return share;
  }

  /** A device starts sharing, on its own or in answer to a request. */
  startShare(deviceId: string, kind: Share["kind"], shareId?: string, label?: string): Share {
    const device = this.store.get("devices", deviceId);
    const person = this.person(device?.personId);
    const existing = shareId ? this.store.get("shares", shareId) : undefined;
    const share: Share = {
      id: existing?.id ?? newId("sh"),
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
    return share;
  }

  endShare(id: string, status: Share["status"] = "ended") {
    const sh = this.store.get("shares", id);
    if (!sh) return;
    this.store.put("shares", { ...sh, status });
    const st = this.stage();
    if (st.mode === "layout" && st.layout?.tiles.some((t) => t.kind === "screen" && t.shareId === id)) {
      const tiles = st.layout.tiles.filter((t) => !(t.kind === "screen" && t.shareId === id));
      this.setStage(tiles.length ? { ...st, layout: { tiles } } : { mode: "board" }, "JamSesh");
    }
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

  stage(): Stage {
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

  setStage(next: Partial<Stage> & { mode: Stage["mode"] }, by: string) {
    const stage: Stage = { title: "", caption: "", items: [], pinned: false, ...next, since: Date.now(), by };
    this.store.setSetting("stage", stage);
    bus.send({ type: "stage", stage });
    if (this.stageRevert) clearTimeout(this.stageRevert);
    this.stageRevert = null;
    if (!stage.pinned && stage.mode !== "board" && stage.mode !== "welcome") {
      // Anything the brain brought up returns to the live board after a while.
      this.stageRevert = setTimeout(() => this.setStage({ mode: "board" }, "JamSesh"), 6 * 60_000);
    }
    return stage;
  }
}

export function publicEvent(e: JamEvent): JamEvent {
  if (!e.data?.embedding) return e;
  const { embedding: _drop, ...data } = e.data;
  return { ...e, data };
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
  if (/\b(lead|principal|staff|manager|pm|product)\b/.test(r)) return 2;
  return 1;
}

export function shortRepo(repo: string) {
  return repo.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? repo;
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Mobile nav / B: bottom tabs" → group "Mobile nav", variant "B". */
export function splitTitle(title: string): { group: string; variant: string } {
  const parts = title.split(/\s+\/\s+|\s+—\s+(?=[A-Z0-9]\b)/);
  if (parts.length < 2) return { group: title.trim(), variant: "" };
  const variant = parts.slice(1).join(" / ").trim();
  const letter = variant.match(/^(?:variant\s+|option\s+|direction\s+)?([A-Z0-9]{1,2})\b/i);
  return { group: parts[0].trim(), variant: letter ? letter[1].toUpperCase() : variant };
}
