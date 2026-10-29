// Live app tiles (Phase 6.3): an iPhone build in the iOS Simulator, or a Mac or Electron app, running
// on the host, streamed into the room as JPEG frames and driven from any person's own screen.
//
// How the picture gets out. `simctl io recordVideo` only finishes its file when it stops, so it can't
// be streamed; idb's MJPEG stream fails to start on this macOS. What works with no permission and no
// window is `simctl io screenshot --type=jpeg`: about 135 ms a call, so three calls in flight give
// 15 to 18 frames a second at full resolution, and a frame identical to the last is never sent. Mac
// apps go through `jamsesh-live` (native/jamsesh-live.swift): ScreenCaptureKit on one window.
//
// How taps get in. The Simulator has no tap command. idb's companion (idb.ts) injects touches headless,
// so no Simulator window and no Accessibility permission are needed; without it people can watch but not
// tap. Mac apps get CGEvents posted to that app's pid, scoped to its window.
//
// Who may drive. A tile on its own has one controller (a person) at a time. A tile shown on a locked big
// screen is driven by that screen's drivers instead (6.1: the owner, whoever they pass control to or drive
// together with), exactly like anything else on the screen. Only drivers can tap, press Home, rotate or
// switch appearance. Agents have no route to any of it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus";
import { config } from "./config";
import { simScreenRect } from "./hostctl";
import { Companion, companionPath, type ScreenInfo } from "./idb";
import type { Session } from "./session";
import type { LiveApp } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKERS = 3;
const MAX_APPS = 4;
/** Control lapses after this long without input, so a person who walked away doesn't hold a tile. */
export const CONTROL_IDLE_MS = 5 * 60_000;
/** A Mac button held down with nothing arriving for this long is let go: the hub gives back every press it relayed. */
export const PRESS_IDLE_MS = 4000;

export type Who = { personId: string | null; name: string; host: boolean };
export type Input =
  | { t: "tap"; x: number; y: number }
  | { t: "swipe"; x: number; y: number; x2: number; y2: number; ms?: number }
  | { t: "down" | "move" | "up"; x: number; y: number }
  | { t: "scroll"; x: number; y: number; dx?: number; dy?: number }
  | { t: "text"; text: string }
  | { t: "key"; key: "return" | "delete" | "tab" | "escape" }
  | { t: "home" | "rotate" }
  | { t: "appearance"; mode?: "light" | "dark" };

type Sub = (frame: Uint8Array) => void;
interface Live {
  info: LiveApp;
  subs: Set<Sub>;
  latest?: Uint8Array;
  lastHash?: string;
  running: boolean;
  lastActive: number;
  // iOS
  udid?: string;
  screen?: ScreenInfo | null;
  companion?: NonNullable<ReturnType<LiveApps["companionFor"]>>;
  // Mac
  proc?: ReturnType<typeof Bun.spawn>;
  /** The helper was told to pause: nobody is watching, so it encodes nothing. */
  paused?: boolean;
  /** A mouse button the helper was told is down: where, and whose press. The hub lets it go if the press can't finish (control changed, the tile ended, input went quiet). */
  held?: { x: number; y: number; by: string; timer: ReturnType<typeof setTimeout> };
}

async function run(cmd: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: (out + (err ? `\n${err}` : "")).trim() };
}

export interface SimWindow {
  id: number;
  title: string;
  w: number;
  h: number;
}

/** The one Simulator window for a device: Simulator titles read "<device name> – <runtime>". None, or two that look alike, is no match. */
export function pickSimWindow(windows: SimWindow[], deviceName: string): SimWindow | { ambiguous: true } | null {
  const want = deviceName.trim().toLowerCase();
  const hits = windows.filter((w) => w.title.split(/\s[–-]\s/)[0]?.trim().toLowerCase() === want);
  return hits.length === 1 ? hits[0]! : hits.length > 1 ? { ambiguous: true } : null;
}

/** Window capture (30 fps) when everything it needs is there, else screenshots with a one-line hint on what would enable it. */
export function planCapture(o: { helper: boolean; screenAccess: boolean; windows: SimWindow[]; deviceName: string; portrait: boolean; haveScreen: boolean }): { mode: "window"; window: SimWindow } | { mode: "screenshots"; hint?: string } {
  if (!o.helper) return { mode: "screenshots", hint: "For smoother video, install Xcode's command line tools on the host (xcode-select --install)." };
  if (!o.screenAccess) return { mode: "screenshots", hint: "For 30 fps, allow Screen Recording for JamSesh in System Settings > Privacy & Security, then reopen the app." };
  if (!o.portrait) return { mode: "screenshots" };
  if (!o.haveScreen) return { mode: "screenshots" };
  const w = pickSimWindow(o.windows, o.deviceName);
  if (!w) return { mode: "screenshots", hint: "For 30 fps, open this device in Simulator (File > Open Simulator) and keep its window on screen." };
  if ("ambiguous" in w) return { mode: "screenshots", hint: "Two Simulator windows share this device's name; close one for 30 fps." };
  return { mode: "window", window: w };
}

/** Simulator's bundle id: its windows are captured by process, not by a name another app could share. */
const SIMULATOR = "com.apple.iphonesimulator";
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const finite = (...v: unknown[]) => v.every((n) => typeof n === "number" && Number.isFinite(n));
const unit = (n: number) => Math.min(1, Math.max(0, n));

export class LiveApps {
  private apps = new Map<string, Live>();
  /** Set by the hub: the host's Simulator picker (a booted device, or one it boots). */
  pickSim: (device?: string) => Promise<{ udid: string; name: string } | string> = async () => "No simulator.";
  log: (text: string) => void = () => {};
  /** The input helper for a Simulator, when idb's companion is installed (tests supply their own). */
  companionFor: (udid: string) => Pick<Companion, "start" | "describe" | "tap" | "swipe" | "button" | "orientation" | "type" | "key" | "stop" | "onExit"> | null = (udid) =>
    companionPath() ? new Companion(udid, join(config.home, "live", `${udid.slice(0, 8)}.sock`)) : null;

  /** The `jamsesh-live` command (tests supply a fake). */
  helper: () => Promise<string[] | string> = () => this.macHelper();

  constructor(private session: Session) {}

  /** The locked big screen showing this tile, with who drives it; the hub fills this in. Null when it is shown nowhere locked. */
  /** How long a held button may sit still before it is let go (a field so tests can shorten it). */
  pressIdleMs = PRESS_IDLE_MS;
  screenFor: (appId: string) => { screen: string; owner: string; since: number; drivers: { personId: string; name: string }[] } | null = () => null;

  list(): LiveApp[] {
    return [...this.apps.values()].map((l) => {
      const sc = l.info.status === "live" ? this.screenFor(l.info.id) : null;
      if (!sc) return { ...l.info };
      const first = sc.drivers[0];
      return { ...l.info, controller: first ? { personId: first.personId, name: first.name, since: sc.since } : null, drivers: sc.drivers, viaScreen: sc.screen };
    });
  }

  /** Whether this person may stop the tile: whoever drives it (its controller, or a driver of its screen). */
  drives(id: string, personId: string | null): boolean {
    const live = this.apps.get(id);
    if (!live || !personId) return false;
    const sc = this.screenFor(id);
    return sc ? sc.drivers.some((d) => d.personId === personId) : live.info.controller?.personId === personId;
  }

  /** Driver ids of the tile's locked screen, or null when it is on none (its own controller drives). */
  screenDriverIds(id: string): string[] | null {
    return this.screenFor(id)?.drivers.map((d) => d.personId) ?? null;
  }

  get(id: string) {
    return this.apps.get(id)?.info;
  }

  private changed() {
    bus.changed("liveApps");
  }

  private add(info: Omit<LiveApp, "id" | "status" | "controller" | "startedAt">, extra: Partial<Live> = {}): Live | string {
    if ([...this.apps.values()].filter((l) => l.info.status === "live").length >= MAX_APPS) return `There are already ${MAX_APPS} live apps. Stop one first.`;
    const id = `app-${Math.random().toString(36).slice(2, 8)}`;
    const live: Live = { info: { ...info, id, status: "live", controller: null, startedAt: Date.now() }, subs: new Set(), running: false, lastActive: Date.now(), ...extra };
    this.apps.set(id, live);
    this.changed();
    return live;
  }

  /** The iOS Simulator device `device` (or the booted iPhone) as a live tile. */
  async startIos(device: string | undefined, by: string): Promise<LiveApp | string> {
    const pick = await this.pickSim(device);
    if (typeof pick === "string") return pick;
    const dup = [...this.apps.values()].find((l) => l.udid === pick.udid && l.info.status === "live");
    if (dup) return { ...dup.info };
    const companion = this.companionFor(pick.udid) ?? undefined;
    let screen = null as Awaited<ReturnType<Companion["describe"]>>;
    let note: string | undefined;
    if (companion) {
      const err = await companion.start();
      if (err) note = `Watching only: ${err}`;
      else screen = await companion.describe().catch(() => null);
    } else note = "Watching only: taps need idb_companion (brew install facebook/fb/idb-companion).";
    const appearance = (await run(["xcrun", "simctl", "ui", pick.udid, "appearance"])).out.trim();
    const r = this.add(
      {
        kind: "ios",
        capture: "screenshots",
        name: pick.name,
        width: screen?.widthPt ?? 402,
        height: screen?.heightPt ?? 874,
        orientation: "portrait",
        appearance: appearance === "dark" ? "dark" : "light",
        canTap: !!companion && !note,
        startedBy: by,
        ...(note ? { note } : {}),
      },
      { udid: pick.udid, companion: note ? undefined : companion, screen },
    );
    if (typeof r === "string") return (companion?.stop(), r);
    if (note) companion?.stop();
    if (companion && !note) companion.onExit = () => this.update(r, { canTap: false, note: "Taps stopped: the Simulator's input helper exited." });
    this.log(`${by} put ${pick.name} (Simulator) on a live tile.`);
    void this.beginCapture(r);
    return { ...r.info };
  }

  /**
   * A Mac app's window as a live tile; needs the jamsesh-live helper (built from source on first use). The app is
   * found by its bundle id: given (an app the host opened), or the one running app whose name is exactly `name`.
   * The helper captures and sends input to that app's process only, never one whose name merely contains it.
   */
  async startMac(target: { name: string; bundle?: string }, by: string, helper?: string[]): Promise<LiveApp | string> {
    const appName = target.name.trim();
    if (!appName || appName.length > 80) return "Give the app's name.";
    const cmd = helper ?? (await this.helper());
    if (typeof cmd === "string") return cmd;
    const bundle = target.bundle ?? (await this.bundleOf(cmd, appName));
    if (bundle.startsWith("!")) return bundle.slice(1);
    if (!BUNDLE_ID.test(bundle)) return "That isn't an app's bundle id.";
    const proc = Bun.spawn([...cmd, bundle, "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const live = this.add({ kind: "mac", name: appName, width: 0, height: 0, orientation: "portrait", appearance: null, canTap: true, startedBy: by }, { proc });
    if (typeof live === "string") return (proc.kill(), live);
    void this.readHelper(live, proc);
    // The first word from the helper says whether it's capturing; an error ends the tile at once.
    for (let i = 0; i < 60 && live.info.width === 0 && live.info.status === "live"; i++) await sleep(100);
    // A helper that stays open but never says anything isn't capturing: the tile ends and the helper is stopped.
    if (live.info.status === "live" && live.info.width === 0) this.end(live, "The app's window didn't start. Is the app open with a window?");
    if (live.info.status !== "live") {
      const why = live.info.note ?? "The app's window couldn't be captured.";
      this.apps.delete(live.info.id);
      this.changed();
      return why;
    }
    this.log(`${by} put ${appName} (Mac app) on a live tile.`);
    this.watching(live);
    return { ...live.info };
  }

  /** The bundle id of the one running app called exactly `name` (any case), or "!" and why there's none. */
  private async bundleOf(cmd: string[], name: string): Promise<string> {
    let apps: { bundle?: unknown; name?: unknown }[] = [];
    try {
      apps = JSON.parse((await run([...cmd, "--apps"])).out);
    } catch {}
    const want = name.toLowerCase();
    const hits = [...new Set((Array.isArray(apps) ? apps : []).filter((a) => typeof a?.name === "string" && a.name.toLowerCase() === want && typeof a.bundle === "string").map((a) => a.bundle as string))];
    if (!hits.length) return `!No running app is called ${name}. Open it on the host first.`;
    if (hits.length > 1) return `!Two running apps are called ${name}, so JamSesh can't tell which to show.`;
    return hits[0]!;
  }

  /** Picks how a Simulator's picture is captured: its window at 30 fps if the host allows it, else screenshots. Starts as screenshots and upgrades. */
  private async beginCapture(live: Live) {
    const old = live.proc;
    live.proc = undefined;
    try {
      old?.kill();
    } catch {}
    const cmd = await this.helper();
    let access = false;
    let windows: SimWindow[] = [];
    if (typeof cmd !== "string") {
      access = (await run([...cmd, "--check"])).out.includes('"screen":true');
      if (access) {
        try {
          windows = JSON.parse((await run([...cmd, "--windows", SIMULATOR])).out) as SimWindow[];
        } catch {}
      }
    }
    if (live.info.status !== "live") return;
    const plan = planCapture({ helper: typeof cmd !== "string", screenAccess: access, windows, deviceName: live.info.name, portrait: live.info.orientation === "portrait", haveScreen: !!live.screen });
    if (plan.mode === "screenshots" || typeof cmd === "string" || !live.screen) {
      this.update(live, { capture: "screenshots", ...(plan.mode === "screenshots" && plan.hint ? { hint: plan.hint } : { hint: undefined }) });
      if (live.subs.size) void this.pump(live);
      return;
    }
    // The screen sits inside the window's frame: crop to it so taps map onto the picture.
    const rect = simScreenRect({ x: 0, y: 0, width: plan.window.w, height: plan.window.h }, live.screen.widthPx, live.screen.heightPx, live.screen.density);
    if (!rect) return void this.update(live, { capture: "screenshots", hint: undefined });
    const proc = Bun.spawn([...cmd, SIMULATOR, "30", "--window", String(plan.window.id), "--crop", `${rect.x},${rect.y},${rect.width},${rect.height}`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    live.proc = proc;
    this.update(live, { capture: "window", hint: undefined });
    void this.readHelper(live, proc);
  }

  private async macHelper(): Promise<string[] | string> {
    const src = join(import.meta.dir, "..", "native", "jamsesh-live.swift");
    if (!existsSync(src)) return "The Mac app streaming helper isn't installed on this host.";
    const hash = createHash("sha1").update(await Bun.file(src).bytes()).digest("hex").slice(0, 10);
    const bin = join(config.home, "bin", `jamsesh-live-${hash}`);
    if (!existsSync(bin)) {
      mkdirSync(join(config.home, "bin"), { recursive: true });
      const r = await run(["swiftc", "-O", "-swift-version", "5", src, "-o", bin], 300_000);
      if (r.code) return `Couldn't build the Mac app streaming helper (it needs Xcode's command line tools): ${r.out.slice(0, 200)}`;
    }
    return [bin];
  }

  private async readHelper(live: Live, proc: ReturnType<typeof Bun.spawn>) {
    const errs = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk);
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (live.info.kind === "ios") continue;
            if (m.event === "window" && finite(m.w, m.h)) this.update(live, { width: m.w, height: m.h });
            else if (m.event === "error" && m.code === "accessibility") this.update(live, { canTap: false, note: String(m.text).slice(0, 200) });
            else if (m.event === "error") this.end(live, String(m.text).slice(0, 200));
          } catch {}
        }
      }
    })();
    let buf = new Uint8Array();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf);
      joined.set(chunk, buf.length);
      buf = joined;
      while (buf.length >= 4) {
        const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        if (n > 32 * 1024 * 1024) return this.helperEnded(live, proc, "The helper sent something unreadable.");
        if (buf.length < 4 + n) break;
        this.emit(live, buf.slice(4, 4 + n));
        buf = buf.slice(4 + n);
      }
    }
    await errs;
    this.helperEnded(live, proc, live.info.note ?? "The app's window closed.");
  }

  /** A capture helper stopped. A Mac app's tile ends with it; a Simulator falls back to screenshots (unless a newer helper replaced this one). */
  private helperEnded(live: Live, proc: ReturnType<typeof Bun.spawn>, note: string) {
    if (live.info.kind === "mac") return this.end(live, note);
    if (live.proc !== proc || live.info.status !== "live") return;
    live.proc = undefined;
    this.update(live, { capture: "screenshots", hint: "Window capture stopped (is the Simulator window still open?). Showing screenshots." });
    if (live.subs.size) void this.pump(live);
  }

  private update(live: Live, patch: Partial<LiveApp>) {
    // Whoever held a button when control changed hands doesn't hold it any more.
    if ("controller" in patch) this.releaseHeld(live);
    live.info = { ...live.info, ...patch };
    this.changed();
  }

  /** Ends a tile: viewers see it as gone, then it's removed. */
  private end(live: Live, note: string) {
    if (live.info.status === "gone") return;
    const wasHeld = !!live.held;
    this.releaseHeld(live);
    live.info = { ...live.info, status: "gone", canTap: false, controller: null, note };
    live.companion?.stop();
    const proc = live.proc;
    // A button just let go needs a moment to reach the app before the helper goes.
    const grace = wasHeld ? 400 : 0;
    const kill = () => {
      try {
        proc?.kill();
      } catch {}
    };
    if (grace) setTimeout(kill, grace).unref?.();
    else kill();
    this.changed();
    this.log(`${live.info.name} is no longer live: ${note}`);
    setTimeout(() => {
      if (this.apps.get(live.info.id) === live) (this.apps.delete(live.info.id), this.changed());
    }, 30_000).unref?.();
  }

  stop(id: string) {
    const live = this.apps.get(id);
    if (!live) return false;
    this.end(live, "Stopped.");
    return true;
  }

  stopAll() {
    for (const l of this.apps.values()) this.end(l, "The host closed.");
  }

  // ---- frames ----

  private emit(live: Live, frame: Uint8Array) {
    live.latest = frame;
    for (const s of live.subs) {
      try {
        s(frame);
      } catch {}
    }
  }

  /** A viewer's frames. The newest one goes out at once; the capture runs only while someone watches (a Mac helper is paused with no viewer). */
  subscribe(id: string, fn: Sub): (() => void) | null {
    const live = this.apps.get(id);
    if (!live || live.info.status !== "live") return null;
    live.subs.add(fn);
    if (live.latest) fn(live.latest);
    if (live.info.kind === "ios" && !live.proc) void this.pump(live);
    this.watching(live);
    return () => {
      live.subs.delete(fn);
      this.watching(live);
    };
  }

  /** A Mac helper captures only while someone watches: it is paused at the last viewer leaving and resumed at the first arriving. */
  private watching(live: Live) {
    if (live.info.kind !== "mac" || !live.proc || live.info.status !== "live") return;
    const want = live.subs.size === 0;
    if (!!live.paused === want) return;
    live.paused = want;
    this.macWrite(live, { t: want ? "pause" : "resume" });
  }

  /** Simulator frames: a few `simctl screenshot` calls in flight at once, newest first, duplicates dropped. */
  private async pump(live: Live) {
    if (live.running || !live.udid) return;
    live.running = true;
    const dir = join(config.home, "live", live.info.id);
    mkdirSync(dir, { recursive: true });
    const udid = live.udid;
    let issued = 0;
    let shown = 0;
    let fails = 0;
    const worker = async (k: number) => {
      const file = join(dir, `w${k}.jpg`);
      while (live.subs.size && live.info.status === "live") {
        const n = ++issued;
        const r = await run(["xcrun", "simctl", "io", udid, "screenshot", "--type=jpeg", file]);
        if (live.info.status !== "live") return;
        if (r.code) {
          if (++fails >= 3 && (await this.deviceGone(udid))) return this.end(live, `${live.info.name} was shut down or removed.`);
          await sleep(300);
          continue;
        }
        fails = 0;
        // An older call that finishes after a newer one would show the screen going backwards.
        if (n <= shown) continue;
        const frame = await Bun.file(file).bytes().catch(() => null);
        if (!frame?.length) continue;
        shown = n;
        const hash = createHash("sha1").update(frame).digest("hex");
        if (hash === live.lastHash) continue;
        live.lastHash = hash;
        this.emit(live, frame);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, async (_, k) => (await sleep(k * 45), worker(k))));
    live.running = false;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    // Someone subscribed while the last workers were winding down.
    if (live.subs.size && live.info.status === "live") void this.pump(live);
  }

  private async deviceGone(udid: string) {
    const r = await run(["xcrun", "simctl", "list", "devices", "-j"]);
    if (r.code) return false;
    try {
      const all = Object.values(JSON.parse(r.out).devices as Record<string, { udid: string; state: string }[]>).flat();
      return all.find((d) => d.udid === udid)?.state !== "Booted";
    } catch {
      return false;
    }
  }

  // ---- who is driving ----

  /** Take, release or pass control of a tile. Returns a sentence for the person. */
  control(id: string, act: "take" | "release" | "pass", who: Who, to?: { personId: string; name: string }): string {
    const live = this.apps.get(id);
    if (!live || live.info.status !== "live") return "That app isn't live any more.";
    const sc = this.screenFor(id);
    if (sc) return `This app is on ${sc.owner}'s locked screen: whoever is driving the screen controls it. Use Drive, Pass control or Drive together on the screen.`;
    const cur = live.info.controller;
    const lapsed = cur && Date.now() - live.lastActive > CONTROL_IDLE_MS;
    const mine = cur && cur.personId === who.personId && who.personId !== null;
    if (act === "take") {
      if (cur && !mine && !lapsed && !who.host) return `${cur.name} is driving. Ask them to pass control to you.`;
      if (mine) return "You're already driving.";
      live.lastActive = Date.now();
      this.update(live, { controller: { personId: who.personId, name: who.name, since: Date.now() } });
      this.log(`${who.name} took control of ${live.info.name}${cur && !lapsed ? ` from ${cur.name}` : ""}.`);
      return `You're driving ${live.info.name}.`;
    }
    if (!cur) return "Nobody is driving.";
    if (!mine && !who.host) return `${cur.name} is driving; only they can ${act === "pass" ? "pass" : "release"} it.`;
    if (act === "release") {
      this.update(live, { controller: null });
      return "Control released.";
    }
    if (!to || !to.personId) return "Say who to pass control to.";
    live.lastActive = Date.now();
    this.update(live, { controller: { personId: to.personId, name: to.name, since: Date.now() } });
    this.log(`${who.name} passed control of ${live.info.name} to ${to.name}.`);
    return `${to.name} is driving ${live.info.name}.`;
  }

  /** A person left the room (or was disconnected): whatever they were driving is free. */
  releaseFor(personId: string) {
    for (const l of this.apps.values()) if (l.info.controller?.personId === personId) this.update(l, { controller: null });
  }

  // ---- input ----

  /** One input from the person driving. Returns a sentence when it didn't happen, null when it did. */
  async input(id: string, who: Who, ev: Input): Promise<string | null> {
    const live = this.apps.get(id);
    if (!live || live.info.status !== "live") return "That app isn't live any more.";
    const sc = this.screenFor(id);
    if (sc) {
      if (!who.personId || !sc.drivers.some((d) => d.personId === who.personId)) return sc.drivers.length ? `${sc.drivers.map((d) => d.name).join(" and ")} ${sc.drivers.length > 1 ? "are" : "is"} driving the screen. Ask ${sc.owner} to pass control or drive together.` : `${sc.owner} holds this screen: start driving it first.`;
      live.lastActive = Date.now();
      return live.info.kind === "ios" ? this.iosInput(live, ev) : this.macInput(live, ev, who);
    }
    const cur = live.info.controller;
    if (!cur || cur.personId === null || cur.personId !== who.personId) return cur ? `${cur.name} is driving. Ask them to pass control to you.` : "Take control first.";
    if (Date.now() - live.lastActive > CONTROL_IDLE_MS) {
      this.update(live, { controller: null });
      return "Control lapsed after a few idle minutes. Take control again.";
    }
    live.lastActive = Date.now();
    return live.info.kind === "ios" ? this.iosInput(live, ev) : this.macInput(live, ev, who);
  }

  private async iosInput(live: Live, ev: Input): Promise<string | null> {
    const { info, udid, companion } = live;
    try {
      if (ev.t === "appearance") {
        const mode = ev.mode === "light" || ev.mode === "dark" ? ev.mode : info.appearance === "dark" ? "light" : "dark";
        const r = await run(["xcrun", "simctl", "ui", udid!, "appearance", mode]);
        if (r.code) return `Couldn't switch appearance: ${r.out.slice(0, 120)}`;
        this.update(live, { appearance: mode });
        return null;
      }
      if (!companion || !info.canTap) return info.note ?? "Taps aren't available for this Simulator.";
      if (ev.t === "home") {
        await companion.button("home");
        return null;
      }
      if (ev.t === "rotate") {
        const landscape = info.orientation === "portrait";
        await companion.orientation(landscape ? 2 : 0);
        this.update(live, { orientation: landscape ? "landscape-left" : "portrait" });
        // A turned screen isn't the window's shape any more: screenshots until it's upright again.
        void this.beginCapture(live);
        return null;
      }
      if (ev.t === "text") {
        await companion.type(String(ev.text).slice(0, 200));
        return null;
      }
      if (ev.t === "key") {
        if (!["return", "delete", "tab", "escape"].includes(ev.key)) return "That key isn't supported.";
        await companion.key(ev.key);
        return null;
      }
      // The Simulator doesn't map a touch while the screen is turned (checked on iOS 18.6), so taps wait for portrait.
      if (info.orientation !== "portrait" && (ev.t === "tap" || ev.t === "swipe")) return "Rotate back to portrait to tap: touches don't land while the screen is turned.";
      if (ev.t === "tap" && finite(ev.x, ev.y)) {
        await companion.tap(unit(ev.x) * info.width, unit(ev.y) * info.height);
        return null;
      }
      if (ev.t === "swipe" && finite(ev.x, ev.y, ev.x2, ev.y2)) {
        const secs = Math.min(2, Math.max(0.05, (finite(ev.ms) ? ev.ms! : 300) / 1000));
        await companion.swipe(unit(ev.x) * info.width, unit(ev.y) * info.height, unit(ev.x2) * info.width, unit(ev.y2) * info.height, secs);
        return null;
      }
      return "That input isn't supported for a Simulator.";
    } catch (e) {
      return `The Simulator didn't take that: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
    }
  }

  private macInput(live: Live, ev: Input, who: Who): string | null {
    const by = who.personId ?? "host";
    // A press belongs to the person who made it: another driver's input (the screen's drivers changed) lets it go first.
    if (live.held && live.held.by !== by) this.releaseHeld(live);
    if (!live.info.canTap) return live.info.note ?? "Input isn't allowed for this app.";
    if (ev.t === "home" || ev.t === "rotate" || ev.t === "appearance") return "That control is for iPhone tiles.";
    let line: Record<string, unknown>;
    if (ev.t === "swipe") {
      if (!finite(ev.x, ev.y, ev.x2, ev.y2)) return "That input isn't valid.";
      // A drag: down at the start, a few moves, up at the end.
      const steps = 8;
      const pts = Array.from({ length: steps + 1 }, (_, i) => ({ x: unit(ev.x + ((ev.x2 - ev.x) * i) / steps), y: unit(ev.y + ((ev.y2 - ev.y) * i) / steps) }));
      for (const [i, p] of pts.entries()) if (!this.macSend(live, { t: i === 0 ? "down" : i === steps ? "up" : "move", ...p }, by)) return "The app isn't taking input.";
      return null;
    }
    if (ev.t === "text") line = { t: "text", text: String(ev.text).slice(0, 200) };
    else if (ev.t === "key") line = { t: "key", key: ev.key };
    else if (["tap", "down", "move", "up", "scroll"].includes(ev.t) && "x" in ev && finite(ev.x, ev.y)) line = { ...ev, x: unit(ev.x), y: unit(ev.y) };
    else return "That input isn't valid.";
    return this.macSend(live, line, by) ? null : "The app isn't taking input.";
  }

  /** Every line to a Mac helper goes through here, so the hub always knows whether a button is down. */
  private macSend(live: Live, msg: Record<string, unknown>, by: string) {
    if (!this.macWrite(live, msg)) return false;
    const [x, y] = [Number(msg.x), Number(msg.y)];
    if (msg.t === "down" || (msg.t === "move" && live.held)) {
      if (live.held) clearTimeout(live.held.timer);
      const timer = setTimeout(() => this.releaseHeld(live), this.pressIdleMs);
      timer.unref?.();
      live.held = { x: Number.isFinite(x) ? x : live.held?.x ?? 0.5, y: Number.isFinite(y) ? y : live.held?.y ?? 0.5, by: msg.t === "down" ? by : live.held?.by ?? by, timer };
    } else if ((msg.t === "up" || msg.t === "tap") && live.held) {
      clearTimeout(live.held.timer);
      live.held = undefined;
    }
    return true;
  }

  private macWrite(live: Live, msg: Record<string, unknown>) {
    try {
      const sink = live.proc?.stdin as unknown as { write(s: string): unknown; flush?(): unknown } | undefined;
      sink?.write(`${JSON.stringify(msg)}\n`);
      sink?.flush?.();
      return !!sink;
    } catch {
      return false;
    }
  }

  /** A held button whose person is no longer the one driving its tile (the screen's drivers or the tile's controller changed) comes up. */
  syncHeld() {
    for (const live of this.apps.values()) {
      if (!live.held) continue;
      const allowed = this.screenDriverIds(live.info.id) ?? (live.info.controller?.personId ? [live.info.controller.personId] : []);
      if (!allowed.includes(live.held.by)) this.releaseHeld(live);
    }
  }

  /** Lets go of a button the hub relayed as down, where it last was. */
  private releaseHeld(live: Live) {
    const h = live.held;
    if (!h) return;
    clearTimeout(h.timer);
    live.held = undefined;
    this.macWrite(live, { t: "up", x: h.x, y: h.y });
  }

  /** Cleans leftovers from a crashed run (frame folders of tiles that no longer exist). */
  static sweep() {
    try {
      const dir = join(config.home, "live");
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
    } catch {}
  }
}
