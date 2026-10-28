// Control of the host machine for the room brain: open apps and URLs, place windows,
// drive the iOS Simulator, and run shell commands. Only the brain on the host can
// use this; client agents never reach it.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus";
import { config } from "./config";
import type { Session } from "./session";
import type { BuildRequest } from "./types";

const REQUEST_TTL_MS = 10 * 60_000;

export interface HostAction {
  action: "open_app" | "open_url" | "arrange" | "simulator" | "shell" | "focus_jamsesh" | "windows";
  app?: string;
  url?: string;
  device?: string;
  command?: string;
  layout?: "left-right" | "grid" | "full";
  /** For arrange: a display name (or part of one), "main", or "big screen" (the default). */
  display?: string;
}

/** A display attached to the host, in points, top-left origin (what window positions use). */
export interface Display {
  name: string;
  main: boolean;
  frame: { x: number; y: number; width: number; height: number };
  /** Without the menu bar and the Dock: where windows can go. */
  visible: { x: number; y: number; width: number; height: number };
  scale: number;
}

/** What the big screen window reports about itself. */
export interface BigScreen {
  width: number;
  height: number;
  dpr: number;
  screenX: number;
  screenY: number;
  at: number;
}

const RATIOS: [string, number][] = [["16:9", 16 / 9], ["16:10", 16 / 10], ["21:9", 64 / 27], ["32:9", 32 / 9], ["4:3", 4 / 3], ["3:2", 3 / 2], ["5:4", 5 / 4], ["1:1", 1]];
export function aspect(w: number, h: number) {
  const r = w / h;
  const portrait = r < 1;
  const x = portrait ? 1 / r : r;
  const near = RATIOS.find(([, v]) => Math.abs(v - x) / v < 0.03);
  const name = near ? near[0] : `${x.toFixed(2)}:1`;
  return portrait ? `${name.split(":").reverse().join(":")} portrait` : name;
}

const DISPLAYS_JXA = `ObjC.import("AppKit");
const s = $.NSScreen.screens.js;
const mainH = s.length ? s[0].frame.size.height : 0;
const box = (r) => ({ x: r.origin.x, y: mainH - (r.origin.y + r.size.height), width: r.size.width, height: r.size.height });
JSON.stringify(s.map((x, i) => ({ name: x.localizedName ? x.localizedName.js : "Display " + (i + 1), main: i === 0, frame: box(x.frame), visible: box(x.visibleFrame), scale: x.backingScaleFactor })));`;

const WINDOWS_JXA = `const se = Application("System Events");
const out = [];
for (const p of se.processes.whose({ visible: true })()) {
  try { for (const w of p.windows()) { const pos = w.position(), size = w.size(); out.push({ app: p.name(), title: w.name() || "", x: pos[0], y: pos[1], width: size[0], height: size[1] }); } } catch (e) {}
}
JSON.stringify(out);`;

async function run(cmd: string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: (out + (err ? `\n${err}` : "")).trim() };
}

const osa = (script: string) => run(["osascript", "-e", script]);
const jxa = (script: string) => run(["osascript", "-l", "JavaScript", "-e", script]);

/** "Accessibility" or "Automation" problems, worded as what to do about them. */
function permissionHint(out: string) {
  if (/assistive|accessibility|-1719|-25211/i.test(out)) return "The host Mac hasn't allowed Accessibility for JamSesh yet: open JamSesh's menu bar menu > Set up this Mac.";
  if (/-1743|not authorized|not allowed to send/i.test(out)) return "The host Mac hasn't allowed JamSesh to control System Events yet: open JamSesh's menu bar menu > Set up this Mac.";
  return null;
}

export class HostControl {
  /** The host's displays, refreshed in the background so the brain can read them any time. */
  displays: Display[] = [];
  bigScreen: BigScreen | null = null;
  private builds = new Map<string, { started: number; label: string }>();
  private requests = new Map<string, BuildRequest>();
  /** Set by the hub: tell the room and the agent when a request arrives or is decided. */
  onRequest: (r: BuildRequest) => void = () => {};

  constructor(private session: Session) {
    if (process.platform === "darwin") {
      const refresh = () => this.readDisplays().catch(() => {});
      refresh();
      setInterval(refresh, 30_000).unref?.();
    }
  }

  async readDisplays() {
    const r = await jxa(DISPLAYS_JXA);
    if (!r.code) this.displays = JSON.parse(r.out) as Display[];
    return this.displays;
  }

  /** The display the big screen window is on (by its reported position), or the main one. */
  bigScreenDisplay(): Display | undefined {
    const b = this.bigScreen;
    const inside = (d: Display) => b && b.screenX >= d.frame.x && b.screenX < d.frame.x + d.frame.width && b.screenY >= d.frame.y && b.screenY < d.frame.y + d.frame.height;
    return this.displays.find((d) => inside(d)) ?? this.displays.find((d) => d.main);
  }

  /** For the brain's situation: the screens it can plan layouts for. */
  describeScreens(): string {
    const lines: string[] = [];
    const b = this.bigScreen;
    if (b) lines.push(`- Big screen window: ${b.width}×${b.height} (${aspect(b.width, b.height)}, density ${b.dpr}). Plan set_layout grids for this shape.`);
    const big = this.bigScreenDisplay();
    for (const d of this.displays) {
      const tags = [d.main ? "main" : "", d === big ? "the big screen is on this one" : ""].filter(Boolean).join(", ");
      lines.push(`- Display "${d.name}"${tags ? ` (${tags})` : ""}: ${d.frame.width}×${d.frame.height} points (${aspect(d.frame.width, d.frame.height)}, ${d.scale}x, ${Math.round(d.frame.width * d.scale)}×${Math.round(d.frame.height * d.scale)} pixels); windows fit in ${d.visible.width}×${d.visible.height} at ${d.visible.x},${d.visible.y}.`);
    }
    return lines.join("\n");
  }

  private log(text: string) {
    this.session.store.addEvent({ kind: "system", authorType: "brain", authorName: "Host", text, relevance: "work" });
  }

  async act(a: HostAction): Promise<string> {
    if (process.platform !== "darwin" && a.action !== "shell") return "Host control needs macOS.";
    try {
      switch (a.action) {
        case "open_app": {
          if (!a.app) return "Name the app.";
          const r = await run(["open", "-a", a.app]);
          if (r.code) return `Couldn't open ${a.app}: ${r.out}`;
          this.log(`Opened ${a.app} on the host.`);
          return `Opened ${a.app}.`;
        }
        case "open_url": {
          if (!a.url || !/^(https?|exp|exps):\/\//.test(a.url)) return "Give an http(s) or exp URL.";
          const r = await run(a.app ? ["open", "-a", a.app, a.url] : ["open", a.url]);
          if (r.code) return `Couldn't open it: ${r.out}`;
          this.log(`Opened ${a.url} on the host.`);
          return `Opened ${a.url}.`;
        }
        case "arrange":
          return this.arrange((a.app ?? "").split(",").map((s) => s.trim()).filter(Boolean), a.layout ?? "left-right", a.display);
        case "simulator":
          return this.simulator(a.device, a.url);
        case "shell": {
          if (!a.command) return "Give a command.";
          const r = await run(["/bin/zsh", "-lc", a.command], 60_000);
          this.log(`Ran on the host: ${a.command}`);
          return `exit ${r.code}\n${r.out.slice(-4000)}`;
        }
        case "focus_jamsesh": {
          // The Mac app brings its big screen forward when it's reopened; without the app, a browser.
          const app = await run(["open", "-b", "com.fluidcommerce.jamsesh"]);
          if (app.code) await run(["open", `http://127.0.0.1:${new URL(this.session.hubUrl).port}/host`]);
          return "JamSesh is in front.";
        }
        case "windows":
          return this.windows();
      }
    } catch (e) {
      return `Host action failed: ${e instanceof Error ? e.message : e}`;
    }
    return "Unknown action.";
  }

  /** Which app windows are open on the host, where, and how big. */
  async windows(): Promise<string> {
    const r = await jxa(WINDOWS_JXA);
    if (r.code) return permissionHint(r.out) ?? `Couldn't list windows: ${r.out.slice(0, 200)}`;
    const list = JSON.parse(r.out) as { app: string; title: string; x: number; y: number; width: number; height: number }[];
    if (!list.length) return "No app windows are open.";
    const on = (x: number, y: number) => this.displays.find((d) => x >= d.frame.x && x < d.frame.x + d.frame.width && y >= d.frame.y && y < d.frame.y + d.frame.height)?.name ?? "?";
    return list.map((w) => `${w.app}${w.title ? ` "${w.title.slice(0, 60)}"` : ""}: ${w.width}×${w.height} at ${w.x},${w.y} on ${on(w.x, w.y)}`).join("\n");
  }

  /** Places the front window of each app in columns (or a grid) on one display. */
  async arrange(apps: string[], layout: "left-right" | "grid" | "full", display?: string): Promise<string> {
    if (!apps.length) return "Name the apps to arrange, comma-separated.";
    if (!this.displays.length) await this.readDisplays();
    const want = (display ?? "").toLowerCase();
    const target =
      (want === "main" ? this.displays.find((d) => d.main) : want && !want.includes("big") ? this.displays.find((d) => d.name.toLowerCase().includes(want)) : undefined) ?? this.bigScreenDisplay();
    if (!target) return "Couldn't read the host's displays.";
    const area = target.visible;
    const n = apps.length;
    const cols = layout === "grid" ? Math.ceil(Math.sqrt(n)) : layout === "full" ? 1 : n;
    const rows = Math.ceil(n / cols);
    const w = Math.floor(area.width / cols);
    const h = Math.floor(area.height / rows);
    const problems: string[] = [];
    for (const [i, app] of apps.entries()) {
      const x = area.x + (i % cols) * w;
      const y = area.y + Math.floor(i / cols) * h;
      await run(["open", "-a", app]);
      const r = await osa(
        `tell application "System Events" to tell (first process whose name is "${app.replace(/"/g, "")}")
           set frontmost to true
           set position of window 1 to {${x}, ${y}}
           set size of window 1 to {${w}, ${h}}
         end tell`,
      );
      if (r.code) problems.push(`${app}: ${permissionHint(r.out) ?? r.out}`);
    }
    this.log(`Arranged ${apps.join(", ")} ${layout} on ${target.name}.`);
    return problems.length ? `Arranged with problems: ${problems.join("; ")}` : `Arranged ${apps.join(", ")} on ${target.name} (${w}×${h} each).`;
  }

  /** Requests the room hasn't answered, plus ones decided in the last minute (for the screens). */
  buildRequests(): BuildRequest[] {
    const now = Date.now();
    return [...this.requests.values()].filter((r) => r.status === "pending" || now - r.createdAt < REQUEST_TTL_MS + 60_000).sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingRequests() {
    return [...this.requests.values()].filter((r) => r.status === "pending");
  }

  /** An agent asks to build on the host. Nothing runs until a person approves it. */
  request(r: Omit<BuildRequest, "id" | "status" | "createdAt">): BuildRequest | string {
    if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~-]+$/.test(r.repo)) return "Your repository needs a remote URL (https or git@) the host can clone. Push your branch and join with the remote URL.";
    if (!r.command.trim()) return "Give the build command.";
    const dup = this.pendingRequests().find((p) => p.agentId === r.agentId);
    if (dup) return `You already have a build request waiting for the room (${dup.id}).`;
    const req: BuildRequest = { ...r, id: `build-${Math.random().toString(36).slice(2, 7)}`, status: "pending", createdAt: Date.now() };
    this.requests.set(req.id, req);
    setTimeout(() => {
      if (req.status !== "pending") return;
      req.status = "expired";
      this.onRequest(req);
    }, REQUEST_TTL_MS).unref?.();
    this.onRequest(req);
    return req;
  }

  /**
   * A person approved or denied a request (by voice through the brain, or a button). `saidAt` is
   * when they said it: words only count for requests that were already waiting then.
   */
  decide(id: string, approve: boolean, by: string, saidAt = Date.now()): string {
    const req = this.requests.get(id) ?? this.pendingRequests().find((r) => r.id.endsWith(id));
    if (!req) return "There's no build request with that id.";
    if (req.status !== "pending") return `That request was already ${req.status}.`;
    if (req.createdAt > saidAt) return `${by} spoke before this request arrived, so it's still waiting for an answer.`;
    req.status = approve ? "approved" : "denied";
    req.decidedBy = by;
    this.onRequest(req);
    if (!approve) return `Denied ${req.agentName}'s build.`;
    return this.preview({ repo: req.repo, branch: req.branch, command: req.command, open: req.open, by: `${req.agentName} (approved by ${by})` });
  }

  /**
   * Builds a branch on the host and opens the result, in the background. The checkout lives in
   * ~/.jamsesh/previews and uses the host's own git login. `open` is a path in the checkout to open
   * when the build finishes (a .app, a file, or a URL), or "simulator:<path to .app>" to install and
   * launch an iPhone build in the Simulator.
   */
  preview(o: { repo: string; branch?: string; command: string; open?: string; by: string }): string {
    if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~-]+$/.test(o.repo)) return "I need the repository's remote URL (https or git@) to build it on the host.";
    const name = o.repo.replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
    const branch = o.branch?.trim() || "";
    if (branch && !/^[\w./-]+$/.test(branch)) return "That branch name has characters I won't pass to git.";
    const slug = `${name}${branch ? `-${branch.replace(/[^\w-]+/g, "-")}` : ""}`;
    if (this.builds.has(slug)) return `${name}${branch ? `@${branch}` : ""} is already building on the host.`;
    const dir = join(config.home, "previews", slug);
    const label = `${name}${branch ? `@${branch}` : ""}`;
    this.builds.set(slug, { started: Date.now(), label });
    mkdirSync(join(config.home, "previews"), { recursive: true });
    const q = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
    const sync = existsSync(join(dir, ".git"))
      ? `cd ${q(dir)} && git fetch --quiet origin${branch ? ` && git checkout --quiet ${q(branch)} && git reset --quiet --hard ${q(`origin/${branch}`)}` : " && git pull --quiet --ff-only"}`
      : `git clone --quiet ${branch ? `--branch ${q(branch)} ` : ""}${q(o.repo)} ${q(dir)} && cd ${q(dir)}`;
    this.log(`${o.by} started a preview build of ${label} on the host: ${o.command}`);
    bus.send({ type: "toast", tone: "info", text: `Building ${label} on the host`, detail: o.command.slice(0, 80) });
    void (async () => {
      const r = await run(["/bin/zsh", "-lc", `${sync} && ${o.command}`], 20 * 60_000);
      let result: string;
      if (r.code) {
        result = `The ${label} build failed (exit ${r.code}): ${r.out.slice(-600)}`;
      } else if (o.open?.startsWith("simulator:")) {
        const app = join(dir, o.open.slice("simulator:".length));
        await this.simulator();
        const inst = await run(["xcrun", "simctl", "install", "booted", app], 120_000);
        const id = (await run(["/usr/bin/defaults", "read", join(app, "Info"), "CFBundleIdentifier"])).out.trim();
        const launch = inst.code ? inst : await run(["xcrun", "simctl", "launch", "booted", id]);
        result = launch.code ? `Built ${label}, but the Simulator couldn't run it: ${launch.out.slice(0, 300)}` : `${label} is running in the Simulator.`;
      } else if (o.open) {
        const target = /^https?:\/\//.test(o.open) ? o.open : join(dir, o.open);
        const opened = await run(["open", target]);
        result = opened.code ? `Built ${label}, but couldn't open ${o.open}: ${opened.out.slice(0, 200)}` : `${label} is built and open on the host.`;
      } else {
        result = `${label} is built on the host (${dir}).`;
      }
      this.builds.delete(slug);
      this.log(result);
      bus.send({ type: "toast", tone: r.code ? "warn" : "info", text: result.slice(0, 120) });
    })();
    return `Building ${label} on the host. It opens when the build finishes, and the room sees a note either way.`;
  }

  async simulator(device?: string, url?: string): Promise<string> {
    const list = await run(["xcrun", "simctl", "list", "devices", "available", "-j"]);
    if (list.code) return `Xcode's simctl isn't available: ${list.out.slice(0, 200)}`;
    const devices = Object.values(JSON.parse(list.out).devices as Record<string, any[]>).flat();
    const want = (device ?? "iPhone").toLowerCase();
    const pick =
      devices.find((d) => d.state === "Booted" && d.name.toLowerCase().includes(want)) ??
      devices.filter((d) => d.name.toLowerCase().includes(want)).pop() ??
      devices.find((d) => d.name.startsWith("iPhone"));
    if (!pick) return "No simulator device is installed.";
    if (pick.state !== "Booted") await run(["xcrun", "simctl", "boot", pick.udid], 120_000);
    await run(["open", "-a", "Simulator"]);
    if (url) {
      const r = await run(["xcrun", "simctl", "openurl", pick.udid, url]);
      if (r.code) return `Booted ${pick.name}, but couldn't open ${url}: ${r.out}`;
    }
    this.log(`Simulator: ${pick.name}${url ? ` → ${url}` : ""}.`);
    return `${pick.name} is up${url ? ` with ${url}` : ""}.`;
  }
}
