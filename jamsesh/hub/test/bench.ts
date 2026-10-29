// Scenario bench for the room brain: builds a fresh Hub per scenario, seeds a room
// (people, agents, artifacts), feeds lines, waits for the brain to go idle and exposes
// structured outcomes to assert on. Results are collected for a pass/fail table.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { hooksOf } from "./hooks";
import type { Agent, Artifact, Directive, JamEvent, Person, Stage, TriageCard } from "../src/types";

process.env.JAMSESH_SILENT = "1";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Room {
  hub: Hub;
  people: { chey: Person; jonathan: Person; felipe: Person; britain: Person };
  /** desktop = Jonathan's Claude, mobile = Chey's Claude, design = Britain's Codex */
  agents: { desktop: Agent; mobile: Agent; design: Agent };
  art: { navA: Artifact; navB: Artifact; onbA: Artifact };
  /** Put the two nav variants on the big screen. */
  stageNav(): void;
  say(who: keyof Room["people"], text: string): JamEvent;
  /** A prompt a person typed to their own agent (the UserPromptSubmit hook). */
  prompt(agent: keyof Room["agents"], text: string): void;
  /** Wait until the brain has no pending lines, no running pass and no side passes. */
  settle(timeoutMs?: number): Promise<void>;
  directives(): Directive[];
  /** Cards waiting on the Tasks board: what was overheard and not yet sent or added. */
  cards(): TriageCard[];
  /** Directives created after the baseline (seeded ones excluded). */
  newDirectives(): Directive[];
  decisions(): JamEvent[];
  spoken(): JamEvent[];
  stage(): Stage;
  targetsOf(d: Directive[]): Set<string>;
  dump(): string;
  stop(): void;
}

export function makeRoom(opts: { seed?: boolean } = {}): Room {
  const dataDir = mkdtempSync(join(tmpdir(), "jamsesh-bench-"));
  const hub = new Hub({ canvas: false, whisper: false, dataDir });
  hub.brain.shipWindowMs = 300;
  const s = hub.session;
  s.updateSettings({ voiceReplies: false, hostControl: false });

  const chey = s.upsertPerson({ name: "Chey", role: "designer" });
  const jonathan = s.upsertPerson({ name: "Jonathan", role: "engineer" });
  const felipe = s.upsertPerson({ name: "Felipe", role: "CPO" });
  const britain = s.upsertPerson({ name: "Britain", role: "designer" });

  const reg = (ownerName: string, harness: Agent["harness"], repo: string, platform: Agent["platform"], focus: string, machine: string) =>
    s.registerAgent({ ownerName, harness, repo, platform, focus, machine, cwd: `/work/${repo}`, branch: "main" }).agent;
  const desktop = reg("Jonathan", "claude-code", "acme/desktop", "desktop", "Electron desktop app", "jon-mbp");
  const mobile = reg("Chey", "claude-code", "acme/mobile", "mobile", "Expo mobile app", "chey-mbp");
  const design = reg("Britain", "codex", "design/web", "design", "Design canvas and web mockups", "britain-mbp");

  const frame = (title: string, agent: Agent, note: string) => s.upsertArtifact({ kind: "frame", stage: "mockup", title, agentId: agent.id, note });
  const navA = frame("Nav / A: bottom tabs", design, "Bottom tab bar with five icons");
  const navB = frame("Nav / B: sidebar", design, "Collapsible left sidebar");
  const onbA = frame("Onboarding / A: three-step carousel", design, "Swipe carousel");
  void opts;

  const baseline = new Set(s.directives().map((d) => d.id));
  const inflight = { n: 0 };
  const brain = hub.brain as any;
  const origConsider = brain.consider.bind(brain);
  brain.consider = async (...args: unknown[]) => {
    inflight.n++;
    try {
      return await origConsider(...args);
    } finally {
      inflight.n--;
    }
  };
  // Trace every router tool call so failures show what the model actually did.
  // Every pass (triage, route, direct) runs through brain.exclusive; count them so settle() sees a flushed batch as busy.
  const origExclusive = brain.exclusive.bind(brain);
  brain.exclusive = async (fn: () => Promise<unknown>) => {
    inflight.n++;
    try {
      return await origExclusive(fn);
    } finally {
      inflight.n--;
    }
  };
  const trace: string[] = [];
  const origTools = brain.tools.bind(brain);
  const traced = (tools: Record<string, any>) => {
    for (const [name, t] of Object.entries<any>(tools)) {
      const exec = t.execute;
      t.execute = async (input: any, o: any) => {
        trace.push(`${name} ${JSON.stringify(input).slice(0, 200)}`);
        return exec(input, o);
      };
    }
    return tools;
  };
  // Forward the person/agent scope: an agent's words get the reduced tool set in production too.
  brain.tools = (batch: JamEvent[], pass: { effects: number }, ...rest: unknown[]) => traced(origTools(batch, pass, ...rest));
  const origParity = brain.parityTools.bind(brain);
  brain.parityTools = (batch: unknown) => traced(origParity(batch));
  const origErr = console.error;
  console.error = (...a: any[]) => {
    trace.push(`console.error ${a.map(String).join(" ").slice(0, 200)}`);
    origErr(...a);
  };
  const nameOf = (id: string) => s.agent(id)?.name ?? id;

  const room: Room = {
    hub,
    people: { chey, jonathan, felipe, britain },
    agents: { desktop, mobile, design },
    art: { navA, navB, onbA },
    stageNav: () => {
      s.setStage({ mode: "compare", title: "Nav", items: [navA.id, navB.id], pinned: false }, "JamSesh");
    },
    say: (who, text) => hub.typed(room.people[who].id, text),
    prompt: (agent, text) => {
      hooksOf(hub).prompt(room.agents[agent], { prompt: text });
    },
    async settle(timeoutMs = 90_000) {
      const t0 = Date.now();
      await sleep(50);
      // Idle means no debounce timer, nothing pending, and the pass queue (brain.exclusive) drained.
      while (brain.timer || brain.shipTimer || brain.pending.length || inflight.n) {
        if (Date.now() - t0 > timeoutMs) throw new Error("brain never went idle");
        await sleep(150);
      }
      await brain.queue;
    },
    directives: () => s.directives(),
    cards: () => s.board.open(),
    // Routing is what the scenarios judge: a task the brain proposed on the Tasks board counts like one it sent.
    newDirectives: () => [
      ...s.directives().filter((d) => !baseline.has(d.id)),
      ...s.board.open().filter((c) => c.type === "task" && !c.overruled && !c.cancels).map((c) => ({ id: c.id, ts: c.ts, text: c.text, mode: c.mode, targets: c.targets, rationale: `proposed on the Tasks board, from ${c.by}`, requestedBy: c.by }) as unknown as Directive),
    ],
    decisions: () => [
      ...s.store.recentEvents({ kinds: ["decision"], limit: 50 }).filter((e) => e.authorType === "brain"),
      ...s.board.open().filter((c) => c.type === "context" && c.kind === "decision").map((c) => ({ id: 0, text: c.text, authorType: "brain" }) as unknown as JamEvent),
    ],
    spoken: () => s.store.recentEvents({ kinds: ["brain"], limit: 20 }),
    stage: () => s.stage(),
    targetsOf: (ds) => new Set(ds.flatMap((d) => d.targets)),
    dump() {
      const ds = room.newDirectives().map((d) => `  - [${d.mode}] -> ${d.targets.map(nameOf).join(", ")} :: ${d.text.slice(0, 160)} || why: ${d.rationale.slice(0, 120)}`);
      const st = room.stage();
      const dec = room.decisions().map((e) => `  - ${e.text.slice(0, 140)}`);
      return `directives(${ds.length}), cards(${room.cards().length}):\n${ds.join("\n") || "  (none)"}\ndecisions(${dec.length}):\n${dec.join("\n") || "  (none)"}\ntools: ${trace.join(" ;; ") || "(none called)"}\nstage: ${st.mode} items=[${st.items.map((i) => s.store.get("artifacts", i)?.title ?? i).join(" | ")}] pinned=${st.pinned}\nbrain: ${hub.session.brainStatus.status}${hub.session.brainStatus.lastError ? ` err=${hub.session.brainStatus.lastError}` : ""}`;
    },
    stop() {
      hub.stop();
      console.error = origErr;
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    },
  };
  return room;
}

// ---------- result collection ----------

export interface Result {
  name: string;
  behaviours: number[];
  ok: boolean;
  ms: number;
  note: string;
}
export const results: Result[] = [];

/** Runs one scenario in a fresh room, records pass/fail and latency, rethrows failures. */
export async function runScenario(name: string, behaviours: number[], body: (r: Room, mark: () => void) => Promise<void>) {
  const r = makeRoom();
  let t0 = Date.now();
  let end = 0;
  try {
    await body(r, () => {
      t0 = Date.now();
    });
    const err = r.hub.session.brainStatus.lastError;
    if (err) throw new Error(`brain reported an error: ${err}`);
    end = Date.now() - t0;
    results.push({ name, behaviours, ok: true, ms: end, note: "" });
  } catch (e: any) {
    end = Date.now() - t0;
    const msg = `${e?.message ?? e}\n--- room state ---\n${r.dump()}`;
    results.push({ name, behaviours, ok: false, ms: end, note: String(e?.message ?? e).split("\n")[0].slice(0, 110) });
    throw new Error(msg);
  } finally {
    r.stop();
  }
}

export function printTable(title: string) {
  if (!results.length) return;
  const w = Math.max(...results.map((r) => r.name.length), 8);
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  [${r.behaviours.join(",")}]`.padEnd(w + 24) + `${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.note}`);
  const pass = results.filter((r) => r.ok).length;
  const avg = results.reduce((a, r) => a + r.ms, 0) / results.length / 1000;
  console.log(`\n=== ${title}: ${pass}/${results.length} passed, avg ${avg.toFixed(1)}s ===\n${lines.join("\n")}\n`);
}
