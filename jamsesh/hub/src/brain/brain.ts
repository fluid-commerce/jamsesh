// The room brain. It reads the room (speech and typed lines), separates banter from
// work, turns real requests into directives for the right agents, keeps the big
// screen on what matters, and keeps the shared digests current.
import { generateText, isStepCount, Output, tool } from "ai";
import { z } from "zod";
import { bus } from "../bus";
import type { Session, UpdateKind } from "../session";
import { shortRepo } from "../session";
import type { Agent, Artifact, JamEvent, Relevance } from "../types";
import { describeError, model } from "./llm";
import { speak } from "./speech";
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
  /** Set by the hub: reassigns a transcribed line to a person and teaches their voiceprint. */
  relabel: ((eventId: number, personName: string) => string) | null = null;

  constructor(
    private session: Session,
    private host: HostControl,
  ) {
    this.digestTimer = setInterval(() => this.digest().catch(() => {}), 20_000);
    this.refreshStatus();
  }

  stop() {
    clearInterval(this.digestTimer);
  }

  refreshStatus() {
    const s = this.session;
    if (!s.settings().brainEnabled) s.setBrain("offline");
    else if (!s.gatewayKey()) s.setBrain("no-key");
    else s.setBrain("ready");
  }

  /** A new room line (speech or typed). Batches lines that arrive together. */
  hear(ev: JamEvent) {
    if (!this.session.settings().brainEnabled) return;
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
        system: ROUTER_SYSTEM,
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

  /** Something happened outside the room that may need coordination, such as a shipped change. */
  async consider(note: string) {
    const m = model(this.session, "router");
    if (!m || !this.session.settings().brainEnabled) return;
    try {
      await generateText({
        model: m,
        system: ROUTER_SYSTEM,
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
      `## People\n${people.map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ""} (weight ${p.weight})`).join("\n") || "(nobody named yet)"}`,
      `## Agents\n${agents.filter((a) => a.status !== "offline").map(fmtAgent).join("\n") || "(no agents connected)"}`,
      `## Workstreams\n${workstreams.map((w) => `- ${w.title} (owner ${s.agent(w.ownerAgentId)?.name ?? "nobody"})`).join("\n") || "(none)"}`,
      `## Open directives\n${open.map((d) => `- ${d.id} [${d.mode}, ${d.status}] → ${d.targets.map((t) => s.agent(t)?.name).join(", ")}: ${d.text}`).join("\n") || "(none)"}`,
      digest ? `## Session brief\n${digest}` : "",
      `## Recent agent activity\n${updates.map((e) => `- ${e.authorName}: ${e.text.slice(0, 220)}`).join("\n") || "(none)"}`,
      `## Recent artifacts (newest first)\n${artifacts.map((a) => `- ${a.id}: [${a.stage}] ${a.title}${a.agentName ? ` by ${a.agentName}` : ""}${a.platform ? ` (${a.platform})` : ""}`).join("\n") || "(none)"}`,
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
          const targets = i.targets.filter((t) => known.has(t));
          if (!targets.length) return "No valid agent ids. Use the ids from the Agents list.";
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
          return `Directive ${d.id} sent.`;
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
        description: "Speak a short reply out loud on the room speaker. Use sparingly: answers to direct questions to the room brain, or confirming a big action. One or two sentences.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          await speak(s, text);
          return "Said.";
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
      const targets = (named.length ? named : agents).map((a) => a.id);
      const mode = /\b(build|implement|ship|for real|in the (app|repo|code))\b/.test(lower) ? "implement" : "explore";
      s.createDirective({ text, mode, targets, requestedBy: ev.authorName, sourceEventIds: [ev.id], rationale: "Routed by keyword (the brain has no gateway key)." });
    }
  }

  // ---------- reacting to agents ----------

  agentUpdated(agent: Agent, kind: UpdateKind, text: string) {
    // Only implemented changes need parity in other repositories; finished mockups don't.
    if (kind !== "shipped") return;
    const others = this.session.agents().filter((a) => a.id !== agent.id && a.status !== "offline" && a.platform !== agent.platform && a.platform !== "design");
    if (!others.length) return;
    this.consider(
      `${agent.name} (${agent.platform}, ${shortRepo(agent.repo)}) reported "${kind}": ${text}\nOther platforms in the session: ${others.map((o) => `${o.name} (${o.platform}, ${shortRepo(o.repo)})`).join(", ")}. Shipped work should reach every platform by default, adapted to that platform's conventions (a desktop sidebar becomes tabs or a drawer on mobile; the feature and information architecture stay the same). Don't wait for the room to ask for parity or to pick a direction. Send one 'coordinate' directive to each other platform's agent and one to ${agent.name}, asking them to align through jam_message, post renders, and compare side by side. Call no_action only when the change is clearly specific to ${agent.platform} (an OS-only integration) or is an internal refactor with no visible result. Put a parity view on screen when both sides have artifacts.`,
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
      await this.workstreamBriefs(lastId);
    } catch (e) {
      console.error("digest:", describeError(e));
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
- Pick targets by ownership: the agent already working on that workstream, or on the platform or repository the request is about. Name an owner's agent when a person says "my agent" or "Chey's". If the request applies to desktop and mobile, send it to both and ask them to coordinate.
- When people disagree, weigh by role weight (higher wins) and say whose call it was in the rationale. Don't silently drop the other view: mention it.
- A decision ("I like B", "go with direction A") should usually do three things: record_decision, then an implement directive to the agent that owns it (mentioning the chosen artifact by title), and spotlight the chosen artifact.
- "Bring that up", "show me", "pull up" = show_on_screen. Use search_artifacts if the ids aren't obvious. "That one" usually means what is on screen or the latest artifact.
- If an agent asked the room a question and someone answered, send an 'answer' directive to that agent.
- Write directives as complete instructions an agent can act on without hearing the room: include counts, names, constraints, and which mockup.
- Use host_action only when the room asks to see something outside the board (a native app, a simulator, side-by-side windows).
- Lines marked "(typed to their agent)" are prompts a person gave their own agent, which is already on it. Don't route them back to that agent. Act on them only when they affect other agents (for example "and tell the mobile agent to match"), or record a decision they state.
- When one platform ships something visible (an agent posts "shipped" or "done"), the other platforms' agents should get a 'coordinate' directive so desktop and mobile stay in parity, adapted to each platform. Include the shipping agent in it.
- Don't repeat a directive that is already open. Don't route banter. If nothing needs doing, call no_action.
- "That was Felipe" / "Britain said that" right after a line means fix_speaker on that line. It is not banter even if phrased casually.
- Speak (say_to_room) only when someone addresses you directly ("hey brain", "JamSesh, ...") or asks a question only you can answer. Keep it to one sentence.`;

const DIGEST_SYSTEM = `You keep the running brief of a live design-and-build session, for agents that join late or start a new leg of work. Update the previous brief with the new events. Structure:
GOAL: one line.
DECISIONS: bullet list, newest last, with who decided.
IN PROGRESS: who (agent) is on what, mocked or built.
OPEN QUESTIONS: bullets.
PEOPLE: name, role, what they care about.
Drop banter. Keep it under 300 words. Plain text.`;
