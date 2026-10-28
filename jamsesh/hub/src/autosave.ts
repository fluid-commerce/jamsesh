// Autosave. Everything is already durable as it happens: the context store is SQLite
// (WAL), and figcraft-server writes every canvas change to its log before anyone sees
// it. On top of that, JamSesh keeps versioned snapshots a person can open or hand
// around: the canvas as a .figcraft file, the session's context as JSON, and readable
// session notes. One every few minutes while something changes, one on request, and
// one when the host stops.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";

const EVERY_MS = 5 * 60_000;
const KEEP_AUTO = 36;

export interface SnapshotInfo {
  id: string;
  label: string;
  at: number;
  canvas: boolean;
  dir: string;
}

export class Autosave {
  dir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEventId = -1;
  private lastCanvasKey = "";
  private saving: Promise<SnapshotInfo | null> | null = null;

  constructor(private hub: Hub, dataDir: string) {
    this.dir = join(dataDir, "snapshots");
    mkdirSync(this.dir, { recursive: true });
  }

  start() {
    this.timer = setInterval(() => this.save("", { onlyIfChanged: true }).catch((e) => console.error("autosave:", e)), EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The canvas key changes whenever any frame was re-rendered (a cheap change signal). */
  private canvasKey() {
    return this.hub.session
      .artifacts()
      .filter((a) => a.kind === "frame")
      .map((a) => `${a.nodeId}:${a.image}`)
      .sort()
      .join("|");
  }

  async save(label = "", opts: { onlyIfChanged?: boolean } = {}): Promise<SnapshotInfo | null> {
    if (this.saving) return this.saving;
    const run = async () => {
      const s = this.hub.session;
      const lastEvent = s.store.lastEventId();
      const canvasKey = this.canvasKey();
      if (opts.onlyIfChanged && lastEvent === this.lastEventId && canvasKey === this.lastCanvasKey) return null;
      const at = Date.now();
      const stamp = new Date(at).toISOString().replace(/[:T]/g, "-").slice(0, 16);
      const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const id = `${stamp}${slug ? `-${slug}` : ""}`;
      const dir = join(this.dir, id);
      mkdirSync(dir, { recursive: true });

      const canvas = await this.hub.canvas.saveCopy(join(dir, "canvas.figcraft")).catch((e) => {
        console.error("autosave canvas:", e instanceof Error ? e.message : e);
        return false;
      });
      const state = s.state();
      const context = {
        savedAt: new Date(at).toISOString(),
        label,
        session: { name: state.settings.sessionName, brainName: state.settings.brainName, brainNotes: state.settings.brainNotes },
        people: state.people.map(({ id, name, role, weight }) => ({ id, name, title: role, weight })),
        agents: state.agents.map(({ id, name, ownerName, harness, repo, branch, platform, focus }) => ({ id, name, ownerName, harness, repo, branch, platform, focus })),
        workstreams: state.workstreams,
        facts: state.facts,
        decisions: s.store.recentEvents({ kinds: ["decision"], limit: 500 }),
        directives: s.directives(),
        artifacts: s.artifacts(),
        annotations: s.store.all("annotations"),
        stage: state.stage,
        layouts: s.savedLayouts(),
        digest: state.digest,
      };
      writeFileSync(join(dir, "context.json"), JSON.stringify(context, null, 2));
      writeFileSync(join(dir, "notes.md"), notes(context));
      this.lastEventId = lastEvent;
      this.lastCanvasKey = canvasKey;
      this.prune();
      return { id, label, at, canvas, dir };
    };
    this.saving = run().finally(() => (this.saving = null));
    return this.saving;
  }

  list(): SnapshotInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((d) => statSync(join(this.dir, d)).isDirectory())
      .map((id) => ({
        id,
        label: id.slice(17).replace(/-/g, " "),
        at: statSync(join(this.dir, id)).mtimeMs,
        canvas: existsSync(join(this.dir, id, "canvas.figcraft")),
        dir: join(this.dir, id),
      }))
      .sort((a, b) => b.at - a.at);
  }

  /** Unlabelled snapshots rotate; labelled ones (saved on purpose) are kept. */
  private prune() {
    const auto = this.list().filter((x) => !x.label);
    for (const old of auto.slice(KEEP_AUTO)) rmSync(old.dir, { recursive: true, force: true });
  }
}

function notes(c: any): string {
  const when = new Date(c.savedAt).toLocaleString();
  const lines = [`# ${c.session.name}`, "", `Saved ${when}${c.label ? ` · ${c.label}` : ""}`, ""];
  const by = (k: string) => c.facts.filter((f: any) => f.status === "active" && f.kind === k);
  const section = (title: string, items: string[]) => (items.length ? [`## ${title}`, "", ...items.map((i) => `- ${i}`), ""] : []);
  lines.push(...section("Decisions", by("decision").map((f: any) => `${f.text}${f.by ? ` (${f.by})` : ""}`)));
  lines.push(...section("Requirements and constraints", [...by("requirement"), ...by("constraint")].map((f: any) => f.text)));
  lines.push(...section("Open questions", by("question").map((f: any) => f.text)));
  lines.push(...section("Who was here", [...c.people.map((p: any) => `${p.name}${p.title ? `, ${p.title}` : ""}`), ...c.agents.map((a: any) => `${a.name} (${a.platform}, ${a.repo})`)]));
  lines.push(...section("Work in progress", c.directives.filter((d: any) => d.status !== "done" && d.status !== "cancelled").map((d: any) => `[${d.mode}] ${d.text}`)));
  lines.push(...section("What was made", c.artifacts.map((a: any) => `${a.stage === "built" ? "Built" : "Mockup"}: ${a.title}${a.agentName ? ` (${a.agentName})` : ""}${a.url ? ` ${a.url}` : ""}`)));
  if (c.digest) lines.push("## Session brief", "", c.digest, "");
  lines.push("The canvas is in canvas.figcraft (open it in FigCraft), and everything else is in context.json.");
  return lines.join("\n");
}

export function copyIfExists(from: string, to: string) {
  if (existsSync(from)) copyFileSync(from, to);
}
