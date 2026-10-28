// The room brain. It reads the room (speech and typed lines), separates banter from
// work, turns real requests into directives for the right agents, keeps the big
// screen on what matters, and keeps the shared digests current.
import { generateText, isStepCount, Output, tool } from "ai";
import { z } from "zod";
import { bus } from "../bus";
import type { Session, UpdateKind } from "../session";
import { shortRepo } from "../session";
import type { Agent, Artifact, JamEvent, Relevance, Share, Tile } from "../types";
import { describeError, model } from "./llm";
import { chime, speak, type SpeechSource } from "./speech";
import { newId } from "../store";
import { affinity, historyBrief, oneAgentPerRepo, terms } from "./affinity";
import type { HostControl } from "../hostctl";

const TRIAGE_DEBOUNCE_MS = 1400;
const DIGEST_EVERY_MS = 75_000;

const triageSchema = z.object({
  lines: z.array(
    z.object({
      id: z.number().describe("The event id of the line"),
      relevance: z.enum(["banter", "chatter", "discussion", "work"]),
      intent: z
        .enum(["none", "directive", "decision", "present", "question", "introduce", "relabel"])
        .describe("What the line asks of the room or its agents"),
      confidence: z.number().min(0).max(1),
    }),
  ),
  actionable: z.boolean().describe("True when the router should act on these lines now"),
  introductions: z
    .array(z.object({ name: z.string(), role: z.string() }))
    .describe("People whose name and role were stated, by themselves ('I'm Felipe, I run product') or by someone else ('this is Dana, she runs support')"),
});

export type Triage = z.infer<typeof triageSchema>;

export class Brain {
  private pending: JamEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private lastDigestAt = 0;
  private digestTimer: ReturnType<typeof setInterval>;
  private lastRoomStageAt = 0;
  /** Set by the hub: the canvas pages. */
  pages: () => { name: string; frames: number }[] = () => [];
  /** Set by the hub. */
  autosave: import("../autosave").Autosave | null = null;
  /** Set by the hub: reassigns a transcribed line to a person and teaches their voiceprint. */
  relabel: ((eventId: number, personName: string) => string) | null = null;

  constructor(
    private session: Session,
    private host: HostControl,
  ) {
    this.digestTimer = setInterval(() => this.digest().catch(() => {}), 20_000);
    this.refreshStatus();
  }

  private stopped = false;

  stop() {
    this.stopped = true;
    clearInterval(this.digestTimer);
    if (this.timer) clearTimeout(this.timer);
    if (this.shipTimer) clearTimeout(this.shipTimer);
    this.timer = null;
    this.shipTimer = null;
  }

  refreshStatus() {
    const s = this.session;
    if (!s.settings().brainEnabled) s.setBrain("offline");
    else if (!s.gatewayKey()) s.setBrain("no-key");
    else s.setBrain("ready");
  }

  /** A new room line (speech or typed). Batches lines that arrive together. */
  hear(ev: JamEvent) {
    if (this.stopped || !this.session.settings().brainEnabled) return;
    if (addressesBrain(ev.text, this.session.settings().brainName)) {
      const marked = this.session.store.updateEvent(ev.id, { relevance: "work", data: { direct: true } }) ?? { ...ev, data: { ...ev.data, direct: true } };
      return void this.direct(marked);
    }
    this.pending.push(ev);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), TRIAGE_DEBOUNCE_MS);
  }

  private async flush() {
    this.timer = null;
    if (this.busy) {
      this.timer = setTimeout(() => this.flush(), 400);
      return;
    }
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    this.busy = true;
    try {
      const triage = await this.triage(batch);
      for (const line of triage.lines) {
        const ev = batch.find((e) => e.id === line.id);
        if (ev) this.session.store.updateEvent(ev.id, { relevance: line.relevance, data: { intent: line.intent, confidence: line.confidence } });
      }
      for (const intro of triage.introductions) {
        if (intro.name) this.session.upsertPerson({ name: intro.name, role: intro.role || undefined });
      }
      if (triage.actionable) await this.route(batch, triage);
    } catch (e) {
      this.session.setBrain("ready", describeError(e));
      console.error("brain:", describeError(e));
    } finally {
      this.busy = false;
    }
  }

  // ---------- triage ----------

  async triage(batch: JamEvent[]): Promise<Triage> {
    const m = model(this.session, "triage");
    if (!m) return ruleTriage(batch);
    const recent = this.session.store
      .recentEvents({ kinds: ["speech", "prompt", "directive"], limit: 14 })
      .filter((e) => !batch.some((b) => b.id === e.id));
    const agents = this.session.agents().filter((a) => a.status !== "offline");
    const { output } = await generateText({
      model: m,
      output: Output.object({ schema: triageSchema }),
      system: TRIAGE_SYSTEM,
      prompt: [
        `Agents in the session: ${agents.map((a) => `${a.name} (${a.platform}, ${shortRepo(a.repo)}${a.focus ? `, ${a.focus}` : ""})`).join("; ") || "none yet"}.`,
        `Earlier lines:\n${recent.map((e) => `- ${e.authorName}: ${e.text}`).join("\n") || "(none)"}`,
        `New lines to judge:\n${batch.map((e) => `[${e.id}] ${e.authorName}${roleOf(this.session, e)}: ${e.text}`).join("\n")}`,
      ].join("\n\n"),
    });
    return output ?? ruleTriage(batch);
  }

  // ---------- routing ----------

  async route(batch: JamEvent[], triage: Triage) {
    const m = model(this.session, "router");
    if (!m) return this.ruleRoute(batch, triage);
    this.session.setBrain("thinking");
    bus.send({ type: "thinking", on: true, label: "Working out who should take that" });
    try {
      const tools = this.tools(batch);
      await generateText({
        model: m,
        system: this.system(),
        prompt: this.situation(batch, triage),
        tools,
        stopWhen: isStepCount(6),
      });
      this.session.setBrain("ready");
    } catch (e) {
      this.session.setBrain("ready", describeError(e));
      console.error("router:", describeError(e));
      this.ruleRoute(batch, triage);
    } finally {
      bus.send({ type: "thinking", on: false });
    }
  }

  /** Someone spoke to the brain directly (its name, Ask, or a recorded prompt). Always acts or answers. */
  async direct(ev: JamEvent, extra = "") {
    if (this.stopped) return;
    // Heard you: an instant chime for spoken requests, before any thinking.
    if (!ev.data.typed) chime(this.session, ev.data.deviceId);
    const m = model(this.session, "router");
    if (!m) return this.ruleRoute([ev], ruleTriage([ev]));
    // Wait out a pass already running, so two passes don't act on the same lines.
    for (let i = 0; this.busy && i < 60; i++) await Bun.sleep(250);
    this.busy = true;
    this.session.setBrain("thinking");
    bus.send({ type: "thinking", on: true, label: `${this.session.settings().brainName} is on it` });
    try {
      await generateText({
        model: m,
        system: this.system(),
        prompt: `${this.situation([ev], null)}\n\n## Addressed to you directly\n${ev.authorName} spoke to you (not just to the room): "${ev.text}"${extra ? `\n\n${extra}` : ""}\n\nDo what they ask with your tools. If it's a question, answer with say_to_room (kind answer). If it's feedback about how you behave, call remember_feedback. Always do something visible: act on the screen or with a directive, answer, or use say_to_room (kind problem) to say briefly why you can't. Don't add a spoken confirmation of an action that is already visible.`,
        tools: this.tools([ev]),
        stopWhen: isStepCount(8),
      });
      this.session.setBrain("ready");
    } catch (e) {
      this.session.setBrain("ready", describeError(e));
      console.error("direct:", describeError(e));
    } finally {
      this.busy = false;
      bus.send({ type: "thinking", on: false });
    }
  }

  /** Someone started sharing a screen or camera: find it a place on the big screen. */
  async placeShare(share: Share) {
    const s = this.session;
    const stage = s.stage();
    if (stage.pinned && stage.by !== "Room brain" && stage.by !== "JamSesh") {
      bus.send({ type: "toast", tone: "info", text: `${share.personName} is sharing their ${share.kind}`, detail: "The screen is pinned; unpin it or ask the brain to show the share." });
      return;
    }
    const m = model(s, "presenter");
    const fallback = () => {
      const keep: Tile[] = stage.mode === "layout" ? stage.layout?.tiles ?? [] : stage.items.slice(0, 2).map((id): Tile => ({ kind: "artifact", artifactId: id }));
      s.setStage({ mode: "layout", title: stage.title, layout: { tiles: ([{ kind: "screen", shareId: share.id, label: share.label }] as Tile[]).concat(keep).slice(0, 4) } }, "JamSesh");
    };
    if (!m) return fallback();
    try {
      const r = await generateText({
        model: m,
        system: this.system(),
        prompt: `${this.situation([], null)}\n\n## New ${share.kind} share\n${share.personName} just started sharing their ${share.kind} (share id ${share.id})${share.reason ? `, because: ${share.reason}` : ""}. Put it on the big screen with set_layout, next to whatever it's most useful beside (for example the mockup it should match, or the other platform's build). Keep it big enough to read.`,
        tools: { set_layout: this.tools([]).set_layout },
        stopWhen: isStepCount(2),
      });
      if (!r.steps.some((st) => st.toolCalls.length)) fallback();
    } catch {
      fallback();
    }
  }

  /** The system prompt: the router's rules, the brain's name, and what the room told it about itself. */
  system() {
    const { brainName, brainNotes } = this.session.settings();
    return `${ROUTER_SYSTEM.replaceAll("JamSesh", brainName === "JamSesh" ? "JamSesh" : `JamSesh (the room calls you "${brainName}")`)}${brainNotes.length ? `\n\nWhat this room has told you about how to behave (follow it):\n${brainNotes.map((n) => `- ${n}`).join("\n")}` : ""}`;
  }

  /** Something happened outside the room that may need coordination, such as a shipped change. */
  async consider(note: string) {
    const m = model(this.session, "router");
    if (!m || !this.session.settings().brainEnabled) return;
    try {
      await generateText({
        model: m,
        system: this.system(),
        prompt: `${this.situation([], null)}\n\n## Event to consider\n${note}\n\nAct only if this needs coordination between agents (for example the same change in another repository). Otherwise call no_action.`,
        tools: this.tools([]),
        stopWhen: isStepCount(4),
      });
    } catch (e) {
      console.error("consider:", describeError(e));
    }
  }

  situation(batch: JamEvent[], triage: Triage | null): string {
    const s = this.session;
    const people = s.people();
    const agents = s.agents();
    const workstreams = s.store.all("workstreams").filter((w) => w.status === "active");
    const open = s.directives().filter((d) => d.status !== "done" && d.status !== "cancelled").slice(0, 12);
    const room = s.store.recentEvents({ kinds: ["speech", "prompt"], limit: 40 });
    const updates = s.store.recentEvents({ kinds: ["update", "decision", "message", "artifact"], limit: 18 });
    const artifacts = s.artifacts().slice(0, 30);
    const stage = s.stage();
    const digest = s.store.digest("session")?.text;
    const fmtAgent = (a: Agent) =>
      `- ${a.id}: ${a.name}, owner ${a.ownerName}, ${a.harness}, repo ${shortRepo(a.repo)}${a.branch ? `@${a.branch}` : ""}, platform ${a.platform}, status ${a.status}${a.focus ? `, focus: ${a.focus}` : ""}${a.activity ? `, doing: ${a.activity}` : ""}${s.isWaiting(a.id) ? " (idle, waiting for work)" : ""}`;
    return [
      `## People\n${people.map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ""} (weight ${p.weight})${s.store.all("devices").some((d) => d.personId === p.id && d.location === "remote") ? ", remote (sees the big screen in their Screen tab, hears your voice on their laptop)" : ""}`).join("\n") || "(nobody named yet)"}`,
      `## Agents\n${agents.filter((a) => a.status !== "offline").map(fmtAgent).join("\n") || "(no agents connected)"}`,
      historyBrief(s, batch.map((e) => e.text).join(" ")),
      `## Workstreams\n${workstreams.map((w) => `- ${w.title} (owner ${s.agent(w.ownerAgentId)?.name ?? "nobody"})`).join("\n") || "(none)"}`,
      `## Open directives\n${open.map((d) => `- ${d.id} [${d.mode}, ${d.status}] → ${d.targets.map((t) => s.agent(t)?.name).join(", ")}: ${d.text}`).join("\n") || "(none)"}`,
      digest ? `## Session brief\n${digest}` : "",
      s.facts().some((f) => f.status === "active")
        ? `## Curated knowledge (respect decisions, requirements and constraints when routing)\n${s.facts().filter((f) => f.status === "active").slice(0, 40).map((f) => `- [${f.kind}${f.workstream ? `, ${f.workstream}` : ""}] ${f.text}`).join("\n")}`
        : "",
      `## Recent agent activity\n${updates.map((e) => `- ${e.authorName}: ${e.text.slice(0, 220)}`).join("\n") || "(none)"}`,
      `## Recent artifacts (newest first)\n${artifacts.map((a) => `- ${a.id}: [${a.stage}] ${a.title}${a.agentName ? ` by ${a.agentName}` : ""}${a.platform ? ` (${a.platform})` : ""}${a.page ? `, page ${a.page}` : ""}`).join("\n") || "(none)"}`,
      `## Live shares\n${s.shares().filter((x) => x.status === "live").map((x) => `- ${x.id}: ${x.label}`).join("\n") || "(none)"}`,
      `## Dev servers on the host\n${s.devservers().map((d) => `- ${d.name}: ${d.url}${d.up ? "" : " (down)"}`).join("\n") || "(none)"}`,
      `## Canvas pages (one per workstream)\n${this.pages().map((p) => `- ${p.name} (${p.frames} frames)`).join("\n") || "(starter page only)"}`,
      `## Saved layouts\n${Object.keys(s.savedLayouts()).join(", ") || "(none)"}`,
      `## Big screen now\n${stage.mode}${stage.title ? `: ${stage.title}` : ""}${stage.pinned ? " (pinned by a person)" : ""}`,
      `## Room transcript (oldest first)\n${room.map((e) => `[${e.id}] ${e.authorName}${roleOf(s, e)}${e.kind === "prompt" ? " (typed to their agent)" : ""}${e.relevance ? ` {${e.relevance}}` : ""}: ${e.text}`).join("\n")}`,
      batch.length
        ? `## Lines to act on now\n${batch
            .map((e) => {
              const t = triage?.lines.find((l) => l.id === e.id);
              return `[${e.id}] ${e.authorName}${roleOf(s, e)}: ${e.text}${t ? `  (triage: ${t.relevance}/${t.intent})` : ""}`;
            })
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  tools(batch: JamEvent[]) {
    const s = this.session;
    const sourceIds = batch.map((e) => e.id);
    const source = speechSource(batch);
    const requester = batch[batch.length - 1]?.authorName ?? "JamSesh";
    const agentIds = () => new Set(s.agents().map((a) => a.id));
    const artifactIds = () => new Set(s.artifacts().map((a) => a.id));
    const host = this.host;
    return {
      create_directive: tool({
        description:
          "Send an instruction to one or more agents. Use mode 'explore' for canvas mockups and variants, 'implement' for real code in the agent's repository, 'coordinate' for agent-to-agent alignment such as parity between desktop and mobile, 'answer' when an agent asked the room a question.",
        inputSchema: z.object({
          targets: z.array(z.string()).describe("Agent ids"),
          mode: z.enum(["explore", "implement", "coordinate", "answer"]),
          text: z.string().describe("The instruction, self-contained, in imperative form, with any specifics the room gave (counts, names, constraints)"),
          rationale: z.string().describe("One short sentence: why these agents, and whose call it was if people disagreed"),
          workstream: z.string().optional().describe("Workstream title this belongs to"),
          priority: z.number().int().min(1).max(3).optional(),
        }),
        execute: async (i) => {
          const known = agentIds();
          const valid = i.targets.filter((t) => known.has(t));
          if (!valid.length) return "No valid agent ids. Use the ids from the Agents list.";
          // One request, one agent per repository: the one that already has the context.
          const { kept: targets, dropped } = oneAgentPerRepo(s, valid, i.text);
          // The same instruction twice (two tool calls in one pass, or a repeated ask) is sent once.
          const dupe = s.directives().find(
            (d) => Date.now() - d.ts < 5 * 60_000 && d.status !== "done" && d.status !== "cancelled" && d.targets.slice().sort().join() === targets.slice().sort().join() && similar(d.text, i.text) > 0.6,
          );
          if (dupe) return `Already sent as ${dupe.id}; not sending it again.`;
          const ws = i.workstream ? s.store.all("workstreams").find((w) => w.title.toLowerCase() === i.workstream!.toLowerCase()) : undefined;
          const d = s.createDirective({
            text: i.text,
            mode: i.mode,
            rationale: i.rationale,
            targets,
            priority: i.priority,
            requestedBy: requester,
            sourceEventIds: sourceIds,
            workstreamId: ws?.id ?? null,
          });
          return `Directive ${d.id} sent to ${targets.map((t) => s.agent(t)?.name).join(", ")}.${dropped.length ? ` Not sent to ${dropped.map((a) => a.name).join(", ")}: same repository as an agent with more related history.` : ""}`;
        },
      }),
      record_decision: tool({
        description: "Record a decision the team made, such as choosing a direction, so every agent sees it.",
        inputSchema: z.object({ text: z.string(), workstream: z.string().optional(), artifactIds: z.array(z.string()).optional() }),
        execute: async (i) => {
          s.store.addEvent({
            kind: "decision",
            authorType: "brain",
            authorName: "Room decision",
            text: i.text,
            relevance: "work",
            data: { requestedBy: requester, artifactIds: i.artifactIds ?? [], sourceEventIds: sourceIds },
          });
          bus.send({ type: "toast", tone: "decision", text: "Decision", detail: i.text });
          // Decisions reach the curated knowledge (and every agent's context) right away.
          setTimeout(() => this.digest(true).catch(() => {}), 3000);
          return "Recorded.";
        },
      }),
      show_on_screen: tool({
        description:
          "Change the big screen. 'board' = live bento of newest work; 'spotlight' = one or two artifacts large; 'compare' = variants side by side (labelled A, B, C); 'parity' = columns, for example desktop beside mobile; 'agents' = every agent's live activity; 'canvas' = the live shared canvas with everyone's cursors; 'custom' = your own HTML (use build_custom_view instead).",
        inputSchema: z.object({
          mode: z.enum(["board", "spotlight", "compare", "parity", "agents", "canvas"]),
          title: z.string().optional(),
          caption: z.string().optional(),
          artifactIds: z.array(z.string()).optional(),
          columns: z.array(z.object({ label: z.string(), artifactIds: z.array(z.string()) })).optional(),
          pin: z.boolean().optional().describe("Keep it up until someone changes it"),
        }),
        execute: async (i) => {
          const known = artifactIds();
          const items = (i.artifactIds ?? []).filter((a) => known.has(a));
          if ((i.mode === "spotlight" || i.mode === "compare") && !items.length) return "Those artifact ids don't exist. Use ids from the Recent artifacts list, or search_artifacts.";
          this.lastRoomStageAt = Date.now();
          s.setStage(
            {
              mode: i.mode,
              title: i.title ?? "",
              caption: i.caption ?? "",
              items,
              columns: i.columns?.map((c) => ({ label: c.label, items: c.artifactIds.filter((a) => known.has(a)) })),
              pinned: i.pin ?? false,
            },
            "Room brain",
          );
          return "On screen.";
        },
      }),
      search_artifacts: tool({
        description: "Find artifacts (canvas frames, screenshots, dev servers) by words in their title or note.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const hits = s
            .artifacts()
            .map((a) => ({ a, score: words.filter((w) => `${a.title} ${a.note} ${a.agentName} ${a.platform}`.toLowerCase().includes(w)).length }))
            .filter((h) => h.score > 0)
            .sort((x, y) => y.score - x.score || y.a.updatedAt - x.a.updatedAt)
            .slice(0, 12);
          return hits.map((h) => `${h.a.id}: [${h.a.stage}] ${h.a.title} (${h.a.agentName || "canvas"})`).join("\n") || "Nothing matches.";
        },
      }),
      build_custom_view: tool({
        description:
          "Build a custom full-screen view for the big screen as self-contained HTML (inline CSS and JS, no external requests). It receives window.JAM = {state} with agents, artifacts (with image URLs), events, and updates live through a 'jam' message event. Use it for requests no built-in mode covers, for example a four-way split of what each agent is doing.",
        inputSchema: z.object({ title: z.string(), html: z.string() }),
        execute: async (i) => {
          s.setStage({ mode: "custom", title: i.title, html: i.html, pinned: false }, "Room brain");
          return "Showing the custom view.";
        },
      }),
      say_to_room: tool({
        description:
          "Reply to the room. kind 'answer' for a question someone asked you, 'problem' when you can't do what was asked or a person must act, 'confirm' for anything else. JamSesh decides whether it is spoken or shown as text (typed and overheard requests get text; visible actions stay silent). One or two short sentences; never narrate what you're doing.",
        inputSchema: z.object({ text: z.string(), kind: z.enum(["answer", "problem", "confirm"]) }),
        execute: async ({ text, kind }) => {
          const how = await speak(s, text, { source, kind });
          return how === "spoken" ? "Said out loud." : "Shown as text.";
        },
      }),
      host_action: tool({
        description:
          "Act on the host machine (the Mac on the big screen): open an app or URL, place windows side by side, boot an iOS Simulator and open a URL or app in it, or run a shell command. Use it when the room asks to see something the board can't show, such as a native desktop app beside an Expo app.",
        inputSchema: z.object({
          action: z.enum(["open_app", "open_url", "arrange", "simulator", "shell", "focus_jamsesh"]),
          app: z.string().optional().describe("App name for open_app, or comma-separated apps for arrange"),
          url: z.string().optional(),
          device: z.string().optional().describe("Simulator device name, for example 'iPhone 17 Pro'"),
          command: z.string().optional().describe("Shell command for 'shell'"),
          layout: z.enum(["left-right", "grid", "full"]).optional(),
        }),
        execute: async (i) => {
          if (!s.settings().hostControl) return "Host control is turned off in Settings.";
          return host.act(i);
        },
      }),
      fix_speaker: tool({
        description:
          "Someone said who spoke a line ('that was Felipe', 'no, Britain said that'). Reassign that transcript line (by its [id]) to the person; JamSesh learns their voice from it. Usually the line just before the correction.",
        inputSchema: z.object({ lineId: z.number().int(), person: z.string().describe("The person's name") }),
        execute: async ({ lineId, person }) => this.relabel?.(lineId, person) ?? "Speaker fixing isn't available.",
      }),
      set_layout: tool({
        description:
          "Design the big screen yourself: a grid of tiles. Tile kinds: artifact (an artifact id), canvas (the live canvas, optionally following a person or agent by name so it shows what they're looking at), web (any URL: a dev server on the host, a reference site the room asked for), screen (a live screen or camera share by share id), agent (one agent's live activity), feed (the room transcript), html (your own self-contained HTML). Leave grid out and JamSesh picks a bento for the tile count; give grid (CSS columns, rows, and one grid-area per tile) for a specific arrangement.",
        inputSchema: z.object({
          title: z.string().optional(),
          caption: z.string().optional(),
          tiles: z
            .array(
              z.object({
                kind: z.enum(["artifact", "canvas", "web", "screen", "agent", "feed", "html"]),
                ref: z.string().optional().describe("artifact id, share id, agent id, or URL"),
                follow: z.string().optional().describe("canvas: name of the person or agent to follow"),
                page: z.string().optional().describe("canvas: page to show (pages are named after workstreams)"),
                html: z.string().optional(),
                label: z.string().optional(),
              }),
            )
            .min(1)
            .max(9),
          grid: z.object({ columns: z.string(), rows: z.string(), areas: z.array(z.string()) }).optional(),
          pin: z.boolean().optional(),
        }),
        execute: async (i) => {
          const tiles: Tile[] = [];
          for (const t of i.tiles) {
            if (t.kind === "artifact" && t.ref && s.store.get("artifacts", t.ref)) tiles.push({ kind: "artifact", artifactId: t.ref, label: t.label });
            else if (t.kind === "canvas") tiles.push({ kind: "canvas", follow: t.follow ?? null, page: t.page ?? null, label: t.label });
            else if (t.kind === "web" && t.ref && /^https?:\/\//.test(t.ref)) {
              // Local addresses must be dev servers the agents registered; don't guess ports.
              const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/.test(t.ref);
              if (local && !s.devservers().some((d) => t.ref!.startsWith(d.url))) continue;
              tiles.push({ kind: "web", url: t.ref, label: t.label });
            }
            else if (t.kind === "screen" && t.ref && s.store.get("shares", t.ref)) tiles.push({ kind: "screen", shareId: t.ref, label: t.label });
            else if (t.kind === "agent" && t.ref && s.agent(t.ref)) tiles.push({ kind: "agent", agentId: t.ref, label: t.label });
            else if (t.kind === "feed") tiles.push({ kind: "feed", label: t.label });
            else if (t.kind === "html" && t.html) tiles.push({ kind: "html", html: t.html, label: t.label });
          }
          if (!tiles.length) return "None of those tiles resolved. Use artifact ids, share ids and agent ids from the lists, dev server URLs from 'Dev servers on the host', or full public URLs.";
          const grid = i.grid && i.grid.areas.length === tiles.length ? i.grid : undefined;
          this.lastRoomStageAt = Date.now();
          s.setStage({ mode: "layout", title: i.title ?? "", caption: i.caption ?? "", layout: { tiles, grid }, pinned: i.pin ?? false }, "Room brain");
          return `On screen: ${tiles.length} tile(s).${i.tiles.length !== tiles.length ? ` ${i.tiles.length - tiles.length} didn't resolve and were left out (local URLs must be registered dev servers). If the room asked for something that isn't available, tell them briefly.` : ""}`;
        },
      }),
      request_share: tool({
        description: "Ask someone to share their screen or camera from their JamSesh window (they confirm on their device). Use it when the room wants to see something on a person's machine.",
        inputSchema: z.object({ person: z.string(), kind: z.enum(["screen", "camera"]), reason: z.string() }),
        execute: async ({ person, kind, reason }) => {
          const p = s.personByName(person);
          if (!p) return `No one named ${person}.`;
          const share = s.requestShare(p.id, kind, reason, "Room brain");
          return share ? `Asked ${p.name}; it appears on screen when they accept.` : `${p.name} has no JamSesh window open.`;
        },
      }),
      remember_feedback: tool({
        description: "Someone gave you feedback about how you behave (talk less, be bolder, don't interrupt, call me Chey, always ask before building). Save it as a short instruction to yourself; it applies for the rest of the session.",
        inputSchema: z.object({ note: z.string().describe("An instruction to yourself, imperative, one line") }),
        execute: async ({ note }) => {
          const notes = [...s.settings().brainNotes, note.trim()].slice(-30);
          s.updateSettings({ brainNotes: notes });
          return "Noted.";
        },
      }),
      forget_feedback: tool({
        description: "Remove a saved behavior note that someone takes back.",
        inputSchema: z.object({ contains: z.string().describe("Words from the note to drop") }),
        execute: async ({ contains }) => {
          const before = s.settings().brainNotes;
          const after = before.filter((n) => !n.toLowerCase().includes(contains.toLowerCase()));
          s.updateSettings({ brainNotes: after });
          return before.length === after.length ? "No matching note." : "Dropped.";
        },
      }),
      save_snapshot: tool({
        description: "Save a named snapshot of the whole session now: the canvas file, curated context, layouts and readable notes. Use it when someone says to save, at milestones (a decision shipped), or before something big changes.",
        inputSchema: z.object({ label: z.string().describe("Short name, for example 'nav decided'") }),
        execute: async ({ label }) => {
          const snap = await this.autosave?.save(label);
          return snap ? `Saved "${label}"${snap.canvas ? " with the canvas" : ""}.` : "Nothing to save.";
        },
      }),
      save_layout: tool({
        description: "Save what's on the big screen now under a name, so the room can bring it back later ('save this as the review layout').",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          s.saveLayout(name);
          return `Saved the screen as "${name}".`;
        },
      }),
      show_saved_layout: tool({
        description: "Bring back a saved screen layout by name.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const all = s.savedLayouts();
          const key = Object.keys(all).find((k) => k.toLowerCase() === name.toLowerCase()) ?? Object.keys(all).find((k) => k.toLowerCase().includes(name.toLowerCase()));
          if (!key) return `No saved layout called ${name}. Saved: ${Object.keys(all).join(", ") || "none"}.`;
          this.lastRoomStageAt = Date.now();
          s.setStage({ ...all[key], pinned: false }, "Room brain");
          return `On screen: ${key}.`;
        },
      }),
      no_action: tool({
        description: "Nothing to do: the lines are discussion, banter, or already handled.",
        inputSchema: z.object({ reason: z.string() }),
        execute: async () => "OK",
      }),
    };
  }

  /** Without a key the brain still routes the obvious cases, so the session keeps working. */
  ruleRoute(batch: JamEvent[], triage: Triage) {
    const s = this.session;
    const agents = s.agents().filter((a) => a.status !== "offline");
    for (const line of triage.lines) {
      const ev = batch.find((e) => e.id === line.id);
      if (!ev) continue;
      const text = ev.text;
      if (line.intent === "present") {
        const words = text.toLowerCase().replace(/^.*?(bring up|show( me)?|pull up|put up)\s+/, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
        const hit = s.artifacts().find((a) => words.some((w) => a.title.toLowerCase().includes(w)));
        if (hit) s.setStage({ mode: hit.group ? "compare" : "spotlight", title: hit.group || hit.title, items: s.artifacts().filter((a) => a.group === hit.group).map((a) => a.id) }, "Room brain");
        else if (/agent|everyone|split/.test(text.toLowerCase())) s.setStage({ mode: "agents", title: "What everyone is doing" }, "Room brain");
        else s.setStage({ mode: "board" }, "Room brain");
        continue;
      }
      if (line.intent === "decision") {
        s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text, relevance: "work", data: { requestedBy: ev.authorName } });
        continue;
      }
      if (line.intent !== "directive" || !agents.length) continue;
      const lower = text.toLowerCase();
      const named = agents.filter((a) => lower.includes(a.ownerName.toLowerCase().split(/\s+/)[0]) || lower.includes(a.platform));
      const best = affinity(s, text)[0];
      const pool = named.length ? named : best ? [best.agent] : agents;
      const targets = oneAgentPerRepo(s, pool.map((a) => a.id), text).kept;
      const mode = /\b(build|implement|ship|for real|in the (app|repo|code))\b/.test(lower) ? "implement" : "explore";
      s.createDirective({ text, mode, targets, requestedBy: ev.authorName, sourceEventIds: [ev.id], rationale: "Routed by keyword (the brain has no gateway key)." });
    }
  }

  // ---------- reacting to agents ----------

  /** How long to collect ships before one parity check (tests shorten it). */
  shipWindowMs = 25_000;
  private shipped: { agent: Agent; text: string }[] = [];
  private shipTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ships within a short window (desktop and mobile often land together) are considered once. */
  agentUpdated(agent: Agent, kind: UpdateKind, text: string) {
    if (this.stopped || kind !== "shipped") return;
    this.shipped.push({ agent, text });
    if (this.shipTimer) clearTimeout(this.shipTimer);
    this.shipTimer = setTimeout(() => {
      const batch = this.shipped.splice(0);
      this.shipTimer = null;
      this.shippedBatch(batch);
    }, this.shipWindowMs);
  }

  private shippedBatch(batch: { agent: Agent; text: string }[]) {
    const s = this.session;
    const recentCoordinate = (id: string) =>
      s.directives().some((d) => d.mode === "coordinate" && d.targets.includes(id) && d.status !== "done" && d.status !== "cancelled" && Date.now() - d.ts < 10 * 60_000);
    const ids = new Set(batch.map((b) => b.agent.id));
    const others = s.agents().filter((a) => !ids.has(a.id) && a.status !== "offline" && a.platform !== "design" && !batch.some((b) => b.agent.platform === a.platform));
    const shippedPlatforms = new Set(batch.map((b) => b.agent.platform));
    if (!others.length && shippedPlatforms.size < 2) return;
    if ([...ids, ...others.map((o) => o.id)].every(recentCoordinate)) return;
    this.consider(
      `Shipped just now:\n${batch.map((b) => `- ${b.agent.name} (${b.agent.platform}, ${shortRepo(b.agent.repo)}): ${b.text}`).join("\n")}\n` +
        (others.length
          ? `Other platforms in the session: ${others.map((o) => `${o.name} (${o.platform}, ${shortRepo(o.repo)})`).join(", ")}. If the same change belongs in their apps, send ONE 'coordinate' directive per agent (the other platforms and the shippers), asking them to align through jam_message and post renders.`
          : `Both platforms shipped the same feature. Send ONE 'coordinate' directive per shipper (unless one is already open for them) asking them to compare their builds through jam_message and fix inconsistencies that aren't deliberate platform differences.`) +
        ` Don't send a coordinate directive to an agent that already has an open one. Put a parity view on screen when both platforms have built artifacts.`,
    );
  }

  /** New canvas or built work landed. Bring a finished variant set to the screen. */
  artifactsLanded(arts: Artifact[]) {
    const s = this.session;
    const stage = s.stage();
    if (stage.pinned || Date.now() - this.lastRoomStageAt < 90_000) return;
    if (stage.mode === "welcome") s.setStage({ mode: "board" }, "JamSesh");
    const groups = new Map<string, Artifact[]>();
    for (const a of arts) if (a.group && a.variant) groups.set(a.group, s.artifacts().filter((x) => x.group === a.group && x.variant));
    for (const [group, items] of groups) {
      if (items.length >= 2 && items.length <= 6) {
        const mostRecent = Math.max(...items.map((i) => i.updatedAt));
        if (Date.now() - mostRecent < 60_000) {
          s.setStage({ mode: "compare", title: group, caption: `${items.length} directions from ${[...new Set(items.map((i) => i.agentName))].join(" and ")}`, items: items.sort((a, b) => a.variant.localeCompare(b.variant)).map((i) => i.id) }, "JamSesh");
          return;
        }
      }
    }
  }

  // ---------- digests ----------

  async digest(force = false) {
    const s = this.session;
    if (!force && Date.now() - this.lastDigestAt < DIGEST_EVERY_MS) return;
    const prev = s.store.digest("session");
    const lastId = s.store.lastEventId();
    if (!force && prev && lastId - prev.throughEvent < 6) return;
    const m = model(s, "digest");
    if (!m) return;
    this.lastDigestAt = Date.now();
    const events = s.store
      .recentEvents({ afterId: prev?.throughEvent ?? 0, limit: 400 })
      .filter((e) => e.relevance !== "banter" && e.kind !== "canvas");
    if (!events.length) return;
    try {
      const { text } = await generateText({
        model: m,
        system: DIGEST_SYSTEM,
        prompt: `Previous brief:\n${prev?.text ?? "(none, the session just started)"}\n\nPeople: ${s.people().map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ")}\nAgents: ${s.agents().map((a) => `${a.name} (${a.platform}, ${shortRepo(a.repo)})`).join(", ")}\n\nNew events:\n${events.map((e) => `- [${e.kind}] ${e.authorName}: ${e.text.slice(0, 400)}`).join("\n")}`,
      });
      s.store.setDigest("session", text.trim(), lastId);
      await this.curate(events);
      await this.workstreamBriefs(lastId);
    } catch (e) {
      console.error("digest:", describeError(e));
    }
  }

  /**
   * Curated context: turn what just happened into durable knowledge (decisions,
   * requirements, constraints, preferences, open questions, facts), resolve what was
   * answered, and supersede what changed. Agents get the active set in jam_context.
   */
  async curate(events: JamEvent[]) {
    const s = this.session;
    const m = model(s, "digest");
    if (!m || !events.length) return;
    const active = s.facts().filter((f) => f.status === "active");
    const workstreams = s.store.all("workstreams").map((w) => w.title);
    const { output } = await generateText({
      model: m,
      output: Output.object({ schema: curateSchema }),
      system: CURATE_SYSTEM,
      prompt: [
        `People: ${s.people().map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ") || "(none)"}`,
        `Workstreams: ${workstreams.join(", ") || "(none)"}`,
        `Current knowledge (id: kind, workstream, text):\n${active.map((f) => `${f.id}: ${f.kind}, ${f.workstream || "general"}, ${f.text}`).join("\n") || "(empty)"}`,
        `New events (id, kind, author, text):\n${events.map((e) => `[${e.id}] ${e.kind}${e.relevance ? `/${e.relevance}` : ""} ${e.authorName}: ${e.text.slice(0, 500)}`).join("\n")}`,
      ].join("\n\n"),
    });
    if (!output) return;
    const now = Date.now();
    for (const u of output.update) {
      const f = s.store.get("facts", u.id);
      if (f && f.status === "active") s.store.put("facts", { ...f, text: u.text, note: u.reason, updatedAt: now });
    }
    for (const r of output.resolve) {
      const f = s.store.get("facts", r.id);
      if (f && f.status === "active") s.store.put("facts", { ...f, status: "resolved", note: r.reason, updatedAt: now });
    }
    for (const r of output.supersede) {
      const f = s.store.get("facts", r.id);
      if (f && f.status === "active") s.store.put("facts", { ...f, status: "superseded", note: r.reason, updatedAt: now });
    }
    for (const a of output.add) {
      // Paraphrases of what's already known are duplicates, not new knowledge. Items that
      // differ in their specifics (option A versus B, 16 versus 24 px) never are.
      if ([...active, ...s.facts().filter((f) => f.status === "active")].some((f) => f.kind === a.kind && sameSpecifics(f.text, a.text) && similar(f.text, a.text) > 0.55)) continue;
      s.store.put("facts", {
        id: newId("fact"),
        ts: now,
        updatedAt: now,
        kind: a.kind,
        text: a.text,
        workstream: a.workstream ?? "",
        by: a.by ?? "",
        status: "active",
        note: "",
        sourceEventIds: a.eventIds ?? [],
      });
    }
  }

  private async workstreamBriefs(lastId: number) {
    const s = this.session;
    const m = model(s, "digest");
    if (!m) return;
    for (const ws of s.store.all("workstreams").filter((w) => w.status === "active")) {
      const events = s.store.recentEvents({ limit: 300 }).filter((e) => e.workstreamId === ws.id);
      if (!events.length) continue;
      const { text } = await generateText({
        model: m,
        system: "Write a brief for an engineer picking up this workstream: goal, decisions made, what is built versus only mocked, open questions, next step. Plain text, under 150 words.",
        prompt: `Workstream: ${ws.title}\nPrevious brief: ${ws.brief || "(none)"}\n\nEvents:\n${events.map((e) => `- ${e.authorName}: ${e.text.slice(0, 300)}`).join("\n")}`,
      });
      s.store.put("workstreams", { ...ws, brief: text.trim(), updatedAt: ws.updatedAt });
    }
    void lastId;
  }
}

const STOPWORDS = new Set(["the", "and", "for", "option", "options", "variant", "variants", "version", "versions", "one", "ones", "all", "that", "this", "our", "real", "quick", "please", "up", "can", "you", "again"]);

/** Where a request came from, which decides whether a reply is spoken. */
export function speechSource(batch: JamEvent[]): SpeechSource {
  const ev = batch[batch.length - 1];
  if (!ev) return "ambient";
  if (ev.data?.typed) return ev.data.direct ? "typed" : "ambient";
  if (ev.data?.recorded) return "recorded";
  if (ev.data?.direct) return "voice";
  return "ambient";
}

/** "JamSesh, …", "hey jam sesh", or the room's own name for the brain anywhere in the line. */
export function addressesBrain(text: string, name: string) {
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = flat(text);
  const n = flat(name);
  if (n.length >= 3 && t.includes(n)) return true;
  return n === "jamsesh" && /\b(jam ?sesh|jam ?session|jamsesh)\b/i.test(text) && /^(hey|ok|okay|yo|so)?\s*,?\s*jam/i.test(text.trim());
}

/** Variant letters, numbers and hex colors: the details that make two similar sentences different. */
export function sameSpecifics(a: string, b: string) {
  const specifics = (t: string) =>
    new Set([...t.matchAll(/(?:\b(?:option|direction|variant|version)\s+([A-Z])\b)|\b([A-Z])\b(?=[:)\s,.])|(#[0-9a-f]{3,8})\b|\b(\d+(?:\.\d+)?)(?=px|pt|%|ms|\b)/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase()));
  const x = specifics(a);
  const y = specifics(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function similar(a: string, b: string) {
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  const inter = [...x].filter((t) => y.has(t)).length;
  return inter / Math.max(1, Math.min(x.size, y.size));
}

function roleOf(s: Session, e: JamEvent) {
  if (e.authorType !== "person") return "";
  const p = s.person(e.authorId);
  return p?.role ? ` (${p.role})` : "";
}

// Rule-based triage, used without a gateway key and as a fallback.
export function ruleTriage(batch: JamEvent[]): Triage {
  const lines = batch.map((e) => {
    const t = e.text.toLowerCase().trim();
    let intent: Triage["lines"][number]["intent"] = "none";
    let relevance: Relevance = "discussion";
    if (/\b(bring up|pull up|put up|show (me|us)|let'?s see|go back to the board)\b/.test(t)) intent = "present";
    else if (/\b(let'?s go with|we('re| are) going with|decided|i like (direction|option|variant) [a-z]\b|go with [a-z]\b)/.test(t)) intent = "decision";
    else if (/\b(can you|could you|let'?s (try|build|make|do|ship|add|explore)|try (a|some|out)|make (a|some)|give (me|us)|build|implement|mock up|variants?|options? for)\b/.test(t)) intent = "directive";
    if (/\b(haha|lol|lmao|dude|bro|shut up|your (mom|shirt|face))\b/.test(t) && intent === "none") relevance = "banter";
    if (t.split(/\s+/).length < 3 && intent === "none") relevance = "chatter";
    if (intent !== "none") relevance = "work";
    return { id: e.id, relevance, intent, confidence: intent === "none" ? 0.5 : 0.6 };
  });
  return { lines, actionable: lines.some((l) => l.intent !== "none"), introductions: [] };
}

const TRIAGE_SYSTEM = `You listen to a room of designers and developers working together with AI coding agents. They are friends and joke around a lot. Speech-to-text can be messy.

For each new line decide:
- relevance: "banter" (jokes, teasing, off-topic), "chatter" (filler, "yeah", "hmm"), "discussion" (talking about the work without asking for anything), "work" (asks for or decides something about the work).
- intent: "directive" (asks the agents or the brain to do something: make variants, try an idea, build, fix, change), "decision" (the team picks a direction: "let's go with B"), "present" (asks to see something on the big screen: "bring up the nav options", "show the mobile version"), "question" (asks the room brain a question), "introduce" (someone says their name or role), "relabel" (someone says who said a previous line: "that was Felipe"), "none".

Be conservative. Sarcasm and jokes are never directives ("let's just delete the whole app lol" is banter). Musing ("I wonder if...") is discussion unless it ends in an ask. A directive addressed to a person, not an agent ("Felipe, can you grab lunch"), is not work.
Introductions: fill "introductions" whenever a name and what the person does come up, whether they say it themselves ("I'm Felipe, I run product") or someone else does ("this is Dana, she runs support"). Use the role they gave, and leave out anyone whose name was only mentioned in passing.
Set actionable to true only when at least one line is a directive, decision, present, question, or relabel with confidence above 0.55.`;

const ROUTER_SYSTEM = `You are the room brain for JamSesh, a live session where several people and their coding agents (Claude Code and Codex, one or more per person) work together. Agents run on people's laptops in different repositories. You route what the room says to the right agents and keep the big screen useful.

How to route:
- Decide between EXPLORE and IMPLEMENT. "Try", "what if", "show me options", "mock up", "let's see a few directions" = explore: the agent makes variants on the shared canvas, named "<Workstream> / <Letter>: <short description>". "Let's do it", "build it", "ship B", "implement that", "do it for real", "in the app" = implement: the agent changes code in its repository, runs its dev server, and checks the build against the chosen mockup.
- Keep similar work with the agent that already has its context. Check "Agent work history" and "Best matches": a follow-up, tweak, or new variant of something an agent already worked on goes to that agent, even if another agent is idle. Never split one request between agents in the same repository; JamSesh keeps only the one with the most related history. Fan a request out only when it spans different repositories or platforms. Give genuinely new work to the agent whose repository it belongs in, preferring one with fewer unfinished directives.
- Pick targets by ownership: the agent already working on that workstream, or on the platform or repository the request is about. Name an owner's agent when a person says "my agent" or "Chey's". If the request applies to desktop and mobile, send it to both and ask them to coordinate.
- When people disagree, weigh by role weight (higher wins) and say whose call it was in the rationale. Don't silently drop the other view: mention it.
- A decision ("I like B", "go with direction A") should usually do three things: record_decision, then an implement directive to the agent that owns it (mentioning the chosen artifact by title), and spotlight the chosen artifact.
- "Bring that up", "show me", "pull up" = show_on_screen. Use search_artifacts if the ids aren't obvious. "That one" usually means what is on screen or the latest artifact.
- If an agent asked the room a question and someone answered, send an 'answer' directive to that agent.
- Write directives as complete instructions an agent can act on without hearing the room: include counts, names, constraints, and which mockup.
- Use host_action only when the room asks to see something outside the board (a native app, a simulator, side-by-side windows).
- Lines marked "(typed to their agent)" are prompts a person gave their own agent, which is already on it. Don't route them back to that agent. Act on them only when they affect other agents (for example "and tell the mobile agent to match"): then target ONLY the other agents (mode implement or explore, not coordinate) and tell them to jam_message the typer's agent to stay aligned. Never include the typer's own agent in that directive. Or record a decision they state.
- When one platform ships something visible (an agent posts "shipped" or "done"), the other platforms' agents should get a 'coordinate' directive so desktop and mobile stay in parity, adapted to each platform. Include the shipping agent in it.
- Don't repeat a directive that is already open. Don't route banter. If nothing needs doing, call no_action.
- "That was Felipe" / "Britain said that" right after a line means fix_speaker on that line. It is not banter even if phrased casually.
- Replies (say_to_room): only when someone addressed you. Use kind 'answer' for their question, 'problem' when you can't do it or a person must act. Don't confirm actions that show on the big screen or as a routed toast; silence plus the visible change is the confirmation. JamSesh decides whether a reply is spoken. Never more than two short sentences.`;

const curateSchema = z.object({
  add: z.array(
    z.object({
      kind: z.enum(["decision", "requirement", "constraint", "preference", "question", "fact"]),
      text: z.string().describe("One self-contained sentence an engineer can act on, with specifics (names, values, screens)"),
      workstream: z.string().optional().describe("Existing workstream title, or empty for session-wide"),
      by: z.string().optional().describe("Who said or decided it"),
      eventIds: z.array(z.number()).optional(),
    }),
  ),
  update: z.array(z.object({ id: z.string(), text: z.string(), reason: z.string() })).describe("Knowledge that still holds but changed in scope or detail (rewrite it whole)"),
  resolve: z.array(z.object({ id: z.string(), reason: z.string() })).describe("Questions answered or requirements met"),
  supersede: z.array(z.object({ id: z.string(), reason: z.string() })).describe("Knowledge a newer event changed (for example the room switched from A to B)"),
});

const CURATE_SYSTEM = `You curate the shared knowledge of a live design-and-build session, so every agent works from the same, current facts. From the new events, record only what will still matter later:
- decision: a direction the team chose ("Settings header uses option A, the big greeting"), with who decided.
- requirement: something the result must do or include.
- constraint: a limit (deadline, platform rule, "don't touch the API").
- preference: how someone likes things (style, tone, "Felipe prefers fewer steps").
- question: an open question nobody answered yet.
- fact: useful project knowledge (token values, URLs of dev servers, where code lives).
Ignore banter, chatter, greetings, and tool noise. Don't restate existing knowledge. When something changed, either update it (same item, new scope or detail, for example "A on both apps" becomes "A on mobile") or supersede it (replaced outright). Never leave two active items that contradict each other. Resolve questions that got answered. Be sparse: most batches add zero to three items.`;

const DIGEST_SYSTEM = `You keep the running brief of a live design-and-build session, for agents that join late or start a new leg of work. Update the previous brief with the new events. Structure:
GOAL: one line.
DECISIONS: bullet list, newest last, with who decided.
IN PROGRESS: who (agent) is on what, mocked or built.
OPEN QUESTIONS: bullets.
PEOPLE: name, role, what they care about.
Drop banter. Keep it under 300 words. Plain text.`;
