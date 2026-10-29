// Control of the host machine for the room brain: open apps and URLs, place windows,
// drive the iOS Simulator, and run shell commands. Only the brain on the host can
// use this; client agents never reach it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { bus } from "./bus";
import { config } from "./config";
import type { Session } from "./session";
import type { BuildRequest } from "./types";

const REQUEST_TTL_MS = 10 * 60_000;

export interface HostAction {
  action:
    | "open_app"
    | "open_url"
    | "arrange"
    | "simulator"
    | "shell"
    | "focus_jamsesh"
    | "windows"
    | "screenshot"
    | "click"
    | "type_text"
    | "sim_screenshot"
    | "sim_tap"
    | "sim_swipe"
    | "sim_type"
    | "sim_launch";
  /** App name (open_app, screenshot, click), comma-separated apps (arrange), or a bundle id (sim_launch). */
  app?: string;
  /** click: a point on the host's screen, in points. sim_tap / sim_swipe: pixels of the latest sim_screenshot. */
  x?: number;
  y?: number;
  /** sim_swipe: where the swipe ends. */
  x2?: number;
  y2?: number;
  /** type_text and sim_type. */
  text?: string;
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

/** How much of a command's output is kept: the tail (what ends up in a note), however much it prints. */
const OUTPUT_TAIL = 16_384;

/** Reads a stream into a rolling tail; `done` settles when the stream ends (or fails). */
function collect(stream: ReadableStream<Uint8Array>, max = OUTPUT_TAIL) {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  const acc = { text: "", done: Promise.resolve(), /** Stops reading (a background child may still hold the pipe open). */ cancel: () => void reader.cancel().catch(() => {}) };
  acc.done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      acc.text += dec.decode(value, { stream: true });
      if (acc.text.length > max * 2) acc.text = acc.text.slice(-max);
    }
  })().catch(() => {});
  return acc;
}

/**
 * How a command ended. `stuck` has no exit code on purpose: its process group could not be emptied,
 * so it may still be running. A caller must handle that case (a missed one fails to compile), and the
 * `gone` promise resolves only when the group is seen empty.
 */
function assertNever(x: never): never {
  throw new Error(`unhandled ${JSON.stringify(x)}`);
}

export type RunResult =
  | { status: "ok"; code: 0; out: string }
  | { status: "failed"; code: number; out: string }
  | { status: "stuck"; out: string; gone: Promise<void> };

/**
 * Process-group checks, replaceable in tests. A command runs as the leader of its own group
 * (setsid), so a stop reaches everything it started, background children included.
 */
export const groups = {
  alive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  signal(pgid: number, sig: NodeJS.Signals) {
    try {
      process.kill(-pgid, sig);
    } catch {}
  },
};

async function groupEmpty(pgid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (!groups.alive(pgid)) return true;
  return !groups.alive(pgid);
}

/** TERM to the whole group, then KILL after the grace. True only when the group was seen empty. */
async function stopGroup(pgid: number, graceMs = 1_000): Promise<boolean> {
  if (!groups.alive(pgid)) return true;
  groups.signal(pgid, "SIGTERM");
  if (await groupEmpty(pgid, graceMs)) return true;
  groups.signal(pgid, "SIGKILL");
  return groupEmpty(pgid, graceMs);
}

/** Resolves once the group is seen empty (never rejects, never resolves while it is alive). */
async function waitGone(pgid: number): Promise<void> {
  while (groups.alive(pgid)) await Bun.sleep(500);
}

/** Runs argv (no shell) as its own process group with a deadline. Every wait is bounded; a group that can't be emptied is reported as stuck, never as a finished failure. */
export async function run(cmd: string[], timeoutMs = 30_000, cwd?: string): Promise<RunResult> {
  const p = Bun.spawn(["/usr/bin/perl", "-e", "use POSIX qw(setsid); setsid(); exec @ARGV or exit 127", ...cmd], { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
  const out = collect(p.stdout);
  const err = collect(p.stderr);
  // The readers are cancelled on every way out of here (a background child can hold the pipes open).
  const readers = () => {
    out.cancel();
    err.cancel();
  };
  const text = () => (out.text.slice(-OUTPUT_TAIL) + (err.text ? `\n${err.text.slice(-OUTPUT_TAIL)}` : "")).trim().slice(-OUTPUT_TAIL);
  const finished = (async () => {
    const code = await p.exited;
    // After the command itself is done, give the output a moment, then stop reading.
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(500)]);
    return code;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
  let why = "timed out";
  let code: number | null = null;
  try {
    code = await Promise.race([finished, late]);
  } catch (e) {
    why = `failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
  finished.catch(() => {});
  // Finished or not, whatever is still in the command's group is stopped, and only an empty group counts as done.
  const emptied = await stopGroup(p.pid);
  readers();
  if (!emptied) return { status: "stuck", out: `${code === null ? why : "finished"}; still running, couldn't stop it${text() ? `\n${text()}` : ""}`.trim(), gone: waitGone(p.pid) };
  if (code === null) {
    p.kill();
    return { status: "failed", code: -1, out: why };
  }
  return code === 0 ? { status: "ok", code: 0, out: text() } : { status: "failed", code, out: text() };
}

/** For short helper commands (osascript, open, simctl) where only the exit code and text matter: a command that could not be stopped counts as failed, with that said. */
export async function runShort(cmd: string[], timeoutMs = 30_000, cwd?: string): Promise<{ code: number; out: string }> {
  const r = await run(cmd, timeoutMs, cwd);
  return r.status === "stuck" ? { code: -1, out: r.out } : { code: r.code, out: r.out };
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * One check for every URL in text that is stored, shown to the room, logged or put in a process
 * list: no username, token or password. Each `scheme://` token is cut at the first character that
 * ends an authority, with tabs, newlines and other control characters removed the way a URL parser
 * would, and parsed with the URL class; any `@` in the authority, or a parsed username or password,
 * is refused, as is a URL that will not parse. `single` is for a value that must be one URL or path:
 * it may not contain whitespace or control characters at all. `allowGitUser` lets an ssh remote
 * keep the plain user `git`.
 */
export function urlProblem(text: string, o: { single?: boolean; allowGitUser?: boolean } = {}): string | null {
  const creds = "That has a URL with a username or token in it. Leave the credentials out; the host's own git login does the authenticating.";
  if (typeof text !== "string") return "That isn't valid.";
  if (o.single && (/\s/.test(text) || CONTROL.test(text))) return "That has whitespace or control characters in it.";
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)) {
    const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 2048).replace(/[\u0000-\u001f\u007f]/g, ""); // tabs, newlines and other control characters, which a URL parser drops
    const authority = rest.split(/[/?#\\\s"'`<>|;()&]/)[0];
    if (authority.includes("@")) {
      const user = authority.slice(0, authority.lastIndexOf("@"));
      if (!(o.allowGitUser && user === "git" && m[0].toLowerCase() === "ssh://")) return creds;
      continue;
    }
    try {
      const u = new URL(`${m[0]}${authority}`);
      if (u.username || u.password) return creds;
    } catch {
      return "That has a URL that doesn't parse.";
    }
  }
  return null;
}

/** A remote a build may clone: https, ssh:// or git@, with no credentials in it. */
export function repoProblem(repo: string): string | null {
  if (typeof repo !== "string" || !/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~-]+$/.test(repo)) return "I need the repository's remote URL (https or git@) to build it.";
  if (repo.startsWith("git@")) return (repo.split(":")[0].match(/@/g) ?? []).length === 1 ? null : "That repository URL has a username or token in it.";
  return urlProblem(repo, { single: true, allowGitUser: true });
}

/** Command text that carries a URL with credentials: refused, because command text is shown to the room, logged, and visible in the process list. */
export function commandProblem(command: string): string | null {
  return urlProblem(command);
}

/**
 * What a build may open when it finishes: nothing, an http(s) URL without credentials, a path inside
 * the checkout, or "simulator:<path inside the checkout>". Checked when the request is filed (so the
 * approval card shows exactly what will open) and again, with the real path, when it is used.
 */
export function openProblem(open: string | undefined): string | null {
  if (open == null || open === "") return null;
  if (typeof open !== "string" || open.length > 500) return "The thing to open isn't valid.";
  const leaky = urlProblem(open, { single: true });
  if (leaky) return leaky;
  const target = open.startsWith("simulator:") ? open.slice("simulator:".length) : open;
  if (/^https?:\/\//i.test(target)) return open.startsWith("simulator:") ? "A simulator build needs a path to an .app in the checkout." : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return "I can only open an http(s) address or a path in the checkout.";
  if (target.startsWith("/") || target.startsWith("~") || target.startsWith("-") || target.split(/[\\/]/).includes("..")) return "The thing to open must be a path inside the checkout.";
  return null;
}

/** The real path of `rel` inside `dir` (symlinks resolved), or null when it is missing or escapes the checkout. */
export function confine(dir: string, rel: string): string | null {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(resolve(root, rel));
    return real === root || real.startsWith(`${root}/`) ? real : null;
  } catch {
    return null;
  }
}

/** Any URL's credentials removed, for anything the room can see. */
export function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

const osa = (script: string) => runShort(["osascript", "-e", script]);
const jxa = (script: string) => runShort(["osascript", "-l", "JavaScript", "-e", script]);

/** "Accessibility" or "Automation" problems, worded as what to do about them. */
function permissionHint(out: string) {
  if (/assistive|accessibility|-1719|-25211/i.test(out)) return "The host Mac hasn't allowed Accessibility for JamSesh yet: open JamSesh's menu bar menu > Set up this Mac.";
  if (/-1743|not authorized|not allowed to send/i.test(out)) return "The host Mac hasn't allowed JamSesh to control System Events yet: open JamSesh's menu bar menu > Set up this Mac.";
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The process behind an app name (or bundle id) and how many windows it has; null when it isn't running. */
const FIND_PROC_JXA = `function run(argv) {
  const [want, bid] = argv;
  const lc = want.toLowerCase();
  const se = Application("System Events");
  let best = null, bestScore = 0;
  for (const p of se.processes.whose({ backgroundOnly: false })()) {
    let n = "", b = "";
    try { n = p.name(); b = p.bundleIdentifier() || ""; } catch (e) { continue; }
    const nl = n.toLowerCase();
    const score = (bid && b === bid) || nl === lc ? 3 : nl.length >= 3 && (nl.includes(lc) || lc.includes(nl)) ? 1 : 0;
    if (score <= bestScore) continue;
    let windows = 0;
    try { windows = p.windows().filter((w) => { const s = w.size(); return s[0] > 60 && s[1] > 60; }).length; } catch (e) {}
    best = { name: n, windows }; bestScore = score;
  }
  return JSON.stringify(best);
}`;

/** On-screen windows of one app with their ids and bounds (CoreGraphics: needs no Accessibility). */
const APP_WINDOWS_JXA = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
function run(argv) {
  const owner = argv[0].toLowerCase();
  const raw = $.CGWindowListCopyWindowInfo(1, 0);
  const out = [];
  for (let i = 0, n = $.CFArrayGetCount(raw); i < n; i++) {
    const w = ObjC.deepUnwrap(ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i)));
    if (w.kCGWindowLayer !== 0 || !String(w.kCGWindowOwnerName).toLowerCase().includes(owner)) continue;
    const b = w.kCGWindowBounds;
    if (b.Width > 60 && b.Height > 60) out.push({ id: w.kCGWindowNumber, x: b.X, y: b.Y, width: b.Width, height: b.Height });
  }
  return JSON.stringify(out);
}`;

/** A left click, or a drag from (x, y) to (x2, y2) over ms. Reports when Accessibility isn't allowed. */
const MOUSE_JXA = `ObjC.import("CoreGraphics"); ObjC.import("ApplicationServices");
function run(argv) {
  if (!$.AXIsProcessTrusted()) return "noaccess";
  const [x, y, x2, y2, ms] = argv.map(Number);
  const post = (type, px, py) => $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, $.CGPointMake(px, py), $.kCGMouseButtonLeft));
  post($.kCGEventMouseMoved, x, y); delay(0.08);
  post($.kCGEventLeftMouseDown, x, y); delay(0.06);
  const drag = Math.abs(x2 - x) + Math.abs(y2 - y) > 4;
  if (drag) {
    const steps = 14;
    for (let i = 1; i <= steps; i++) { post($.kCGEventLeftMouseDragged, x + (x2 - x) * i / steps, y + (y2 - y) * i / steps); delay(ms / 1000 / steps); }
  }
  post($.kCGEventLeftMouseUp, drag ? x2 : x, drag ? y2 : y);
  return "ok";
}`;

/**
 * Where a simulator's screen is inside its window, in the window's global points. The window holds
 * a title bar and a device bezel around the screen (at a uniform margin), at some scale; the title
 * bar height varies by macOS, so each likely height is tried and the one that gives a round scale
 * (100%, 75%, 50%...) wins. px and py are the screenshot's pixel size, dpr the device's density.
 */
export function simScreenRect(win: { x: number; y: number; width: number; height: number }, px: number, py: number, dpr: number) {
  const r = px / py;
  const sw = px / dpr;
  const round = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
  let best: { x: number; y: number; width: number; height: number; err: number } | null = null;
  for (const t of [44, 28, 52, 0]) {
    const cw = win.width;
    const ch = win.height - t;
    const m = Math.abs(1 - r) < 0.001 ? 0 : (cw - r * ch) / (1 - r);
    if (m < -1 || cw - m <= 0 || ch - m <= 0) continue;
    const scale = (cw - Math.max(m, 0)) / sw;
    const err = Math.min(...round.map((v) => Math.abs(scale - v) / v));
    if (!best || err < best.err - 1e-6) best = { x: win.x + Math.max(m, 0) / 2, y: win.y + t + Math.max(m, 0) / 2, width: cw - Math.max(m, 0), height: ch - Math.max(m, 0), err };
  }
  return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
}

function pngSize(file: string): { width: number; height: number } | null {
  try {
    const b = readFileSync(file);
    return b.length > 24 && b[1] === 0x50 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  } catch {
    return null;
  }
}

export class HostControl {
  /** Deadlines for fetching the code and for the approved build command. */
  static GIT_MS = 5 * 60_000;
  static BUILD_MS = 20 * 60_000;
  /** Deadline for the short steps after a build (open, defaults, simctl launch). */
  static STEP_MS = 30_000;
  /** The host's displays, refreshed in the background so the brain can read them any time. */
  displays: Display[] = [];
  bigScreen: BigScreen | null = null;
  private builds = new Map<string, { started: number; label: string }>();
  private requests = new Map<string, BuildRequest>();
  /** Set by the hub: tell the room and the agent when a request arrives or is decided. */
  onRequest: (r: BuildRequest) => void = () => {};
  /** Set by the hub: a screenshot of the host or the Simulator that the room should see. */
  onImage: (path: string, title: string) => void = () => {};
  /** Set by the hub: a preview build finished (opened, or failed), so the brain can arrange the result. */
  onBuilt: (label: string, ok: boolean, text: string) => void = () => {};
  /** The latest Simulator screenshot: taps and swipes are given in its pixels. */
  private simShot: { udid: string; name: string; px: number; py: number } | null = null;

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
          const r = await runShort(["open", "-a", a.app]);
          if (r.code) return `Couldn't open ${a.app}: ${r.out}`;
          this.log(`Opened ${a.app} on the host.`);
          return `Opened ${a.app}.`;
        }
        case "open_url": {
          if (!a.url || !/^(https?|exp|exps):\/\//.test(a.url)) return "Give an http(s) or exp URL.";
          const r = await runShort(a.app ? ["open", "-a", a.app, a.url] : ["open", a.url]);
          if (r.code) return `Couldn't open it: ${r.out}`;
          this.log(`Opened ${a.url} on the host.`);
          return `Opened ${a.url}.`;
        }
        case "arrange":
          return this.arrange((a.app ?? "").split(",").map((s) => s.trim()).filter(Boolean), a.layout ?? "left-right", a.display);
        case "simulator":
          return this.simulator(a.device, a.url);
        case "sim_screenshot":
          return this.simScreenshot(a.device);
        case "sim_tap":
          return this.simPoint(a.device, a.x, a.y, a.x, a.y, 0);
        case "sim_swipe":
          return this.simPoint(a.device, a.x, a.y, a.x2, a.y2, 350);
        case "sim_type":
          return this.typeText(a.text, "Simulator");
        case "sim_launch": {
          if (!a.app) return "Give the app's bundle id (for example com.apple.mobilesafari).";
          const sim = await this.pickSim(a.device);
          if (typeof sim === "string") return sim;
          const r = await runShort(["xcrun", "simctl", "launch", sim.udid, a.app]);
          return r.code ? `Couldn't launch ${a.app} in ${sim.name}: ${r.out.slice(0, 200)}` : `Launched ${a.app} in ${sim.name}.`;
        }
        case "screenshot":
          return this.screenshot(a.app);
        case "click":
          return this.click(a.x, a.y, a.app);
        case "type_text":
          return this.typeText(a.text, a.app);
        case "shell":
          // Never directly: a shell command waits for a person's approval (requestShell, then decide).
          return "Shell commands run only after a person in the room approves them.";
        case "focus_jamsesh": {
          // The Mac app brings its big screen forward when it's reopened; without the app, a browser.
          const app = await runShort(["open", "-b", "com.fluidcommerce.jamsesh"]);
          if (app.code) await runShort(["open", `http://127.0.0.1:${new URL(this.session.hubUrl).port}/host`]);
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

  /** The running process for an app name (or its bundle id), with how many real windows it has. */
  private async findProc(app: string, bundleId: string): Promise<{ name: string; windows: number } | null | "error"> {
    const r = await runShort(["osascript", "-l", "JavaScript", "-e", FIND_PROC_JXA, app, bundleId]);
    if (r.code) return "error";
    try {
      return JSON.parse(r.out);
    } catch {
      return "error";
    }
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
    // Start them all first: a freshly launched app takes seconds to show a window, and its
    // process name often differs from the name it was opened by (Electron, Code).
    const bundles = await Promise.all(
      apps.map(async (app) => {
        const [opened, id] = await Promise.all([runShort(["open", "-a", app]), osa(`id of app "${app.replace(/["\\]/g, "")}"`)]);
        return { opened: opened.code === 0, id: id.code ? "" : id.out.trim() };
      }),
    );
    const problems: string[] = [];
    const placed: string[] = [];
    for (const [i, app] of apps.entries()) {
      const x = area.x + (i % cols) * w;
      const y = area.y + Math.floor(i / cols) * h;
      const r = await this.placeWindow(app, bundles[i].id, { x, y, w, h }, bundles[i].opened);
      if (r.ok) placed.push(r.note ? `${app} (${r.note})` : app);
      else problems.push(`${app}: ${r.error}`);
    }
    if (placed.length) this.log(`Arranged ${placed.join(", ")} ${layout} on ${target.name}.`);
    if (problems.length) return `${placed.length ? `Arranged ${placed.join(", ")} on ${target.name}, but ` : "Couldn't arrange: "}${problems.join("; ")}`;
    return `Arranged ${apps.join(", ")} on ${target.name} (${w}×${h} each).`;
  }

  /** Waits (up to ~15 seconds) for an app to have a window, then puts it in the rectangle. */
  private async placeWindow(app: string, bundleId: string, at: { x: number; y: number; w: number; h: number }, opened: boolean): Promise<{ ok: true; note?: string } | { ok: false; error: string }> {
    let proc: { name: string; windows: number } | null = null;
    for (let i = 0; i < 30; i++) {
      const found = await this.findProc(app, bundleId);
      if (found === "error") {
        const probe = await jxa(`Application("System Events").processes.length`);
        return { ok: false, error: permissionHint(probe.out) ?? "couldn't look at the host's windows." };
      }
      proc = found;
      if (proc && proc.windows > 0) break;
      await sleep(500);
    }
    if (!proc) return { ok: false, error: opened ? "it isn't running (it may not have started)." : `no app called "${app}" is installed or running.` };
    if (!proc.windows) return { ok: false, error: `${proc.name} is running but hasn't opened a window yet.` };
    const name = proc.name.replace(/["\\]/g, "");
    const set = `tell application "System Events" to tell process "${name}"
         set frontmost to true
         set position of window 1 to {${at.x}, ${at.y}}
         set size of window 1 to {${at.w}, ${at.h}}
         set position of window 1 to {${at.x}, ${at.y}}
         set sz to size of window 1
         return ((item 1 of sz) as text) & "," & ((item 2 of sz) as text)
       end tell`;
    let r = await osa(set);
    if (r.code) {
      await sleep(800); // a window that just appeared can still be settling
      r = await osa(set);
    }
    if (r.code) return { ok: false, error: permissionHint(r.out) ?? r.out.slice(0, 160) };
    const [gotW, gotH] = r.out.split(",").map((v) => Number(v.trim()));
    const note = gotW && gotH && (Math.abs(gotW - at.w) > 8 || Math.abs(gotH - at.h) > 8) ? `its smallest size is ${gotW}×${gotH}` : undefined;
    return { ok: true, note };
  }

  /** Requests the room hasn't answered, plus ones decided in the last minute (for the screens). */
  buildRequests(): BuildRequest[] {
    const now = Date.now();
    return [...this.requests.values()].filter((r) => r.status === "pending" || now - r.createdAt < REQUEST_TTL_MS + 60_000).sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingRequests() {
    return [...this.requests.values()].filter((r) => r.status === "pending");
  }

  /** An agent (or the brain) asks to build on the host. Nothing runs until a person approves it. */
  request(r: Omit<BuildRequest, "id" | "status" | "createdAt">): BuildRequest | string {
    const bad = repoProblem(r.repo);
    if (bad) return bad.startsWith("That") ? bad : "Your repository needs a remote URL (https or git@) the host can clone. Push your branch and join with the remote URL.";
    if (!r.command.trim()) return "Give the build command.";
    const leaky = commandProblem(r.command) ?? openProblem(r.open);
    if (leaky) return leaky;
    return this.file(r);
  }

  /**
   * The brain wants to run a shell command on the host. It waits for a person's approval exactly
   * like a build: announced, then decided by a button or a spoken "approve" or "deny".
   */
  requestShell(command: string, by: string): BuildRequest | string {
    if (!command.trim()) return "Give a command.";
    const leaky = commandProblem(command);
    if (leaky) return leaky;
    return this.file({ agentId: "brain", agentName: by, ownerName: "the room", repo: "a shell command", branch: "", command: command.trim(), kind: "shell" });
  }

  private file(r: Omit<BuildRequest, "id" | "status" | "createdAt">): BuildRequest | string {
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
    // Turned off while it waited: nothing runs.
    if (approve && !this.session.settings().hostControl) return "Host control is turned off in Settings, so the build can't run. Turn it on, then approve again.";
    if (req.createdAt > saidAt) return `${by} spoke before this request arrived, so it's still waiting for an answer.`;
    req.status = approve ? "approved" : "denied";
    req.decidedBy = by;
    this.onRequest(req);
    if (req.kind === "shell") return approve ? this.runShell(req.command, by) : `Denied the shell command: ${req.command}`;
    if (!approve) return `Denied ${req.agentName}'s build.`;
    return this.preview({ repo: req.repo, branch: req.branch, command: req.command, open: req.open, by: `${req.agentName} (approved by ${by})` });
  }

  /** An approved shell command, in the background (60 seconds at most); the room sees how it ended. */
  private runShell(command: string, by: string): string {
    this.log(`Running on the host (approved by ${by}): ${redactUrls(command)}`);
    void run(["/bin/zsh", "-lc", command], 60_000)
      .then((r) => {
        switch (r.status) {
          case "stuck":
            return this.log(`Shell command is still running and couldn't be stopped: ${redactUrls(command)}`);
          case "ok":
          case "failed":
            return this.log(`Shell command finished with exit ${r.code}: ${redactUrls(command)}${r.out.trim() ? `\n${redactUrls(r.out.slice(-600))}` : ""}`);
          default:
            return assertNever(r);
        }
      })
      .catch((e) => this.log(`Shell command failed: ${e instanceof Error ? e.message : e}`));
    return `Running on the host: ${command}`;
  }

  /**
   * Builds a branch on the host and opens the result, in the background. The checkout lives in
   * ~/.jamsesh/previews and uses the host's own git login. `open` is a path in the checkout to open
   * when the build finishes (a .app, a file, or a URL), or "simulator:<path to .app>" to install and
   * launch an iPhone build in the Simulator.
   */
  preview(o: { repo: string; branch?: string; command: string; open?: string; by: string }): string {
    if (!this.session.settings().hostControl) return "Host control is turned off in Settings.";
    const bad = repoProblem(o.repo) ?? commandProblem(o.command) ?? openProblem(o.open);
    if (bad) return bad;
    const name = o.repo.replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
    const branch = o.branch?.trim() || "";
    if (branch && (!/^[\w./-]+$/.test(branch) || branch.startsWith("-"))) return "That branch name has characters I won't pass to git.";
    // The checkout is keyed by the full remote, so org-a/app and org-b/app never share one.
    const slug = `${name}${branch ? `-${branch.replace(/[^\w-]+/g, "-")}` : ""}-${createHash("sha1").update(o.repo.toLowerCase().replace(/\.git$/, "")).digest("hex").slice(0, 8)}`;
    if (this.builds.has(slug)) return `${name}${branch ? `@${branch}` : ""} is already building on the host.`;
    const dir = join(config.home, "previews", slug);
    const label = `${name}${branch ? `@${branch}` : ""}`;
    // The lock is taken here and released in the one finally below; nothing that can throw sits between them.
    this.builds.set(slug, { started: Date.now(), label });
    void (async () => {
      // If a command couldn't be stopped, the lock stays until its whole process group is seen empty.
      let release = () => void this.builds.delete(slug);
      try {
        mkdirSync(join(config.home, "previews"), { recursive: true });
        this.log(`${o.by} started a preview build of ${label} on the host: ${redactUrls(o.command)}`);
        bus.send({ type: "toast", tone: "info", text: `Building ${label} on the host`, detail: redactUrls(o.command).slice(0, 80) });
        // Fetching the code is argv only (no shell, the URL is never in a command string); the approved build command is the only shell text.
        // Every step goes through `step`: a command whose group could not be stopped ends the preview there (nothing after it runs),
        // and the lock stays until that group is seen empty.
        const stuck: { r: Extract<RunResult, { status: "stuck" }> | null } = { r: null };
        const step = async (cmd: string[], ms: number, cwd?: string): Promise<{ code: number; out: string } | null> => {
          const r = await run(cmd, ms, cwd);
          switch (r.status) {
            case "stuck":
              stuck.r = r;
              return null;
            case "ok":
            case "failed":
              return r;
            default:
              return assertNever(r);
          }
        };
        const git = (args: string[], cwd?: string) => step(["git", ...args], HostControl.GIT_MS, cwd);
        let fetched: { code: number; out: string } | null;
        if (existsSync(join(dir, ".git"))) {
          fetched = await git(["fetch", "--quiet", "origin"], dir);
          if (fetched && !fetched.code && branch) fetched = await git(["checkout", "--quiet", branch], dir);
          if (fetched && !fetched.code && branch) fetched = await git(["reset", "--quiet", "--hard", `origin/${branch}`], dir);
          if (fetched && !fetched.code && !branch) fetched = await git(["pull", "--quiet", "--ff-only"], dir);
        } else {
          fetched = await git(["clone", "--quiet", ...(branch ? ["--branch", branch] : []), "--", o.repo, dir]);
        }
        const built = fetched && fetched.code === 0 ? await step(["/bin/zsh", "-lc", o.command], HostControl.BUILD_MS, dir) : fetched;
        let result: string;
        let ok = false;
        const launched = async (): Promise<string> => {
          if (o.open?.startsWith("simulator:")) {
            const app = confine(dir, o.open.slice("simulator:".length));
            if (!app) throw new Error("the app to install is outside the checkout or missing");
            await this.simulator();
            const inst = await step(["xcrun", "simctl", "install", "booted", app], 120_000);
            if (!inst) return "";
            if (inst.code) return `Built ${label}, but the Simulator couldn't run it: ${inst.out.slice(0, 300)}`;
            const idr = await step(["/usr/bin/defaults", "read", join(app, "Info"), "CFBundleIdentifier"], HostControl.STEP_MS);
            if (!idr) return "";
            const launch = idr.code ? idr : await step(["xcrun", "simctl", "launch", "booted", idr.out.trim()], HostControl.STEP_MS);
            if (!launch) return "";
            ok = !launch.code;
            return launch.code ? `Built ${label}, but the Simulator couldn't run it: ${launch.out.slice(0, 300)}` : `${label} is running in the Simulator.`;
          }
          if (o.open) {
            const isUrl = /^https?:\/\//i.test(o.open);
            const target = isUrl ? o.open : confine(dir, o.open);
            if (!target) return `Built ${label}, but couldn't open ${o.open}: that path is outside the checkout or missing`;
            const opened = await step(["open", target], HostControl.STEP_MS);
            if (!opened) return "";
            ok = !opened.code;
            return opened.code ? `Built ${label}, but couldn't open ${o.open}: ${opened.out.slice(0, 200)}` : `${label} is built and open on the host.`;
          }
          ok = true;
          return `${label} is built on the host (${dir}).`;
        };
        if (!built) {
          result = ""; // stuck: set below
        } else if (built.code) {
          result = `The ${label} build failed (exit ${built.code}): ${redactUrls(built.out.slice(-600))}`;
        } else {
          result = await launched();
        }
        if (stuck.r) {
          const s2 = stuck.r;
          ok = false;
          release = () => void s2.gone.then(() => this.builds.delete(slug));
          result = `The ${label} build is still running a command that couldn't be stopped (${redactUrls(s2.out.slice(-300))}). It stays locked until that exits.`;
        }
        result = redactUrls(result);
        this.log(result);
        this.onBuilt(label, ok, result);
        bus.send({ type: "toast", tone: ok ? "info" : "warn", text: result.slice(0, 120) });
      } catch (e) {
        const result = redactUrls(`The ${label} build couldn't run: ${e instanceof Error ? e.message : String(e)}`);
        try {
          this.log(result);
          this.onBuilt(label, false, result);
        } catch {} // reporting must not stop the lock from being released
      } finally {
        release();
      }
    })();
    return `Building ${label} on the host. It opens when the build finishes, and the room sees a note either way.`;
  }

  /** The simulator to act on: the booted one that matches, else one that's booted for it. */
  private async pickSim(device?: string): Promise<{ udid: string; name: string } | string> {
    const list = await runShort(["xcrun", "simctl", "list", "devices", "available", "-j"]);
    if (list.code) return `Xcode's simctl isn't available: ${list.out.slice(0, 200)}`;
    const devices = Object.values(JSON.parse(list.out).devices as Record<string, any[]>).flat();
    const want = (device ?? "iPhone").toLowerCase();
    const pick =
      devices.find((d) => d.state === "Booted" && d.name.toLowerCase().includes(want)) ??
      devices.find((d) => d.state === "Booted" && !device) ??
      devices.filter((d) => d.name.toLowerCase().includes(want)).pop() ??
      devices.find((d) => d.name.startsWith("iPhone"));
    if (!pick) return "No simulator device is installed.";
    if (pick.state !== "Booted") await runShort(["xcrun", "simctl", "boot", pick.udid], 120_000);
    return { udid: pick.udid, name: pick.name };
  }

  async simulator(device?: string, url?: string): Promise<string> {
    const pick = await this.pickSim(device);
    if (typeof pick === "string") return pick;
    await runShort(["open", "-a", "Simulator"]);
    if (url) {
      const r = await runShort(["xcrun", "simctl", "openurl", pick.udid, url]);
      if (r.code) return `Booted ${pick.name}, but couldn't open ${url}: ${r.out}`;
    }
    this.log(`Simulator: ${pick.name}${url ? ` → ${url}` : ""}.`);
    return `${pick.name} is up${url ? ` with ${url}` : ""}.`;
  }

  /** Saves a PNG of the Simulator's screen. Taps and swipes are then given in this picture's pixels. */
  async simScreenshot(device?: string): Promise<string> {
    const pick = await this.pickSim(device);
    if (typeof pick === "string") return pick;
    const dir = join(config.home, "shots");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `sim-${Date.now()}.png`);
    const r = await runShort(["xcrun", "simctl", "io", pick.udid, "screenshot", "--type=png", file]);
    const size = pngSize(file);
    if (r.code || !size) return `Couldn't take a screenshot of ${pick.name}: ${r.out.slice(0, 200)}`;
    this.simShot = { udid: pick.udid, name: pick.name, px: size.width, py: size.height };
    // Keep the folder small: the newest 30 shots.
    try {
      const old = readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(30);
      for (const o of old) unlinkSync(join(dir, o.f));
    } catch {}
    this.onImage(file, `${pick.name} (Simulator)`);
    return `Screenshot of ${pick.name}: ${file} (${size.width}×${size.height} pixels). Give sim_tap and sim_swipe coordinates in these pixels.`;
  }

  /** A tap (or swipe) on the Simulator: the point is mapped from screenshot pixels into the Simulator window. */
  private async simPoint(device: string | undefined, x?: number, y?: number, x2?: number, y2?: number, ms = 0): Promise<string> {
    if (![x, y, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) return "Give x and y (and x2 and y2 for a swipe) in pixels of the latest sim_screenshot.";
    const pick = await this.pickSim(device);
    if (typeof pick === "string") return pick;
    const shot = this.simShot && this.simShot.udid === pick.udid ? this.simShot : null;
    if (!shot) return "Take a sim_screenshot first: taps are given in its pixels.";
    if (x! < 0 || y! < 0 || x2! < 0 || y2! < 0 || x! > shot.px || x2! > shot.px || y! > shot.py || y2! > shot.py) return `That point is outside the screenshot (${shot.px}×${shot.py}).`;
    await runShort(["open", "-a", "Simulator"]);
    await sleep(400);
    const wins = await runShort(["osascript", "-l", "JavaScript", "-e", APP_WINDOWS_JXA, "Simulator"]);
    const list = wins.code ? [] : (JSON.parse(wins.out || "[]") as { x: number; y: number; width: number; height: number }[]);
    if (!list.length) return "The Simulator window isn't on screen. Call the simulator action first.";
    // iPads (and iPhones below ~1000 px wide) are 2x; the large iPhones are 3x.
    const dpr = /^iPad/i.test(pick.name) || shot.px < 1000 ? 2 : 3;
    const rect = simScreenRect(list[0], shot.px, shot.py, dpr);
    if (!rect) return "Couldn't work out where the Simulator's screen is in its window.";
    const at = (px: number, py: number) => [rect.x + (px / shot.px) * rect.width, rect.y + (py / shot.py) * rect.height];
    const [gx, gy] = at(x!, y!);
    const [gx2, gy2] = at(x2!, y2!);
    const r = await runShort(["osascript", "-l", "JavaScript", "-e", MOUSE_JXA, String(gx), String(gy), String(gx2), String(gy2), String(Math.max(ms, 1))]);
    if (r.out.trim() === "noaccess") return "The host Mac hasn't allowed Accessibility for JamSesh yet, so it can't click: open JamSesh's menu bar menu > Set up this Mac.";
    if (r.code) return `Couldn't send the ${ms ? "swipe" : "tap"}: ${r.out.slice(0, 200)}`;
    this.log(`Simulator: ${ms ? "swiped" : "tapped"} on ${pick.name}.`);
    return `${ms ? "Swiped" : "Tapped"} in ${pick.name}. Take a sim_screenshot to see the result.`;
  }

  /** Types into the front app (the Simulator forwards the Mac's keyboard to the device). */
  async typeText(text?: string, app?: string): Promise<string> {
    if (!text) return "Give the text to type.";
    if (text.length > 500) return "That's too much text to type at once.";
    if (app) {
      await runShort(["open", "-a", app]);
      await sleep(400);
    }
    const r = await osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
    if (r.code) return permissionHint(r.out) ?? `Couldn't type: ${r.out.slice(0, 200)}`;
    return `Typed ${text.length} characters${app ? ` into ${app}` : ""}.`;
  }

  /** A click at a point on the host's screen (points, top-left origin; see the displays), after bringing an app forward. */
  async click(x?: number, y?: number, app?: string): Promise<string> {
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return "Give x and y: a point on the host's screen, in points.";
    if (app) {
      await runShort(["open", "-a", app]);
      await sleep(400);
    }
    const r = await runShort(["osascript", "-l", "JavaScript", "-e", MOUSE_JXA, String(x), String(y), String(x), String(y), "1"]);
    if (r.out.trim() === "noaccess") return "The host Mac hasn't allowed Accessibility for JamSesh yet, so it can't click: open JamSesh's menu bar menu > Set up this Mac.";
    return r.code ? `Couldn't click: ${r.out.slice(0, 200)}` : `Clicked at ${Math.round(x)},${Math.round(y)}.`;
  }

  /** A picture of the host's screen, or of one app's front window (needs Screen Recording for JamSesh). */
  async screenshot(app?: string): Promise<string> {
    const dir = join(config.home, "shots");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `host-${Date.now()}.png`);
    let args = ["screencapture", "-x", "-o", file];
    let what = "the host's screen";
    if (app) {
      const wins = await runShort(["osascript", "-l", "JavaScript", "-e", APP_WINDOWS_JXA, app]);
      const w = wins.code ? undefined : (JSON.parse(wins.out || "[]") as { id: number }[])[0];
      if (!w) return `${app} has no window on screen.`;
      args = ["screencapture", "-x", "-o", "-l", String(w.id), file];
      what = `${app}'s window`;
    }
    const r = await runShort(args);
    const size = pngSize(file);
    if (r.code || !size) return `Couldn't capture ${what}. The host Mac may not have allowed Screen Recording for JamSesh (System Settings > Privacy & Security): ${r.out.slice(0, 160)}`;
    this.onImage(file, app ? `${app} on the host` : "The host's screen");
    return `Screenshot of ${what}: ${file} (${size.width}×${size.height} pixels).`;
  }
}
