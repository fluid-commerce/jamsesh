// Control of the host machine for the room brain: open apps and URLs, place windows,
// drive the iOS Simulator, and run shell commands. Only the brain on the host can
// use this; client agents never reach it.
import { bus } from "./bus";
import type { Session } from "./session";

export interface HostAction {
  action: "open_app" | "open_url" | "arrange" | "simulator" | "shell" | "focus_jamsesh";
  app?: string;
  url?: string;
  device?: string;
  command?: string;
  layout?: "left-right" | "grid" | "full";
}

async function run(cmd: string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: (out + (err ? `\n${err}` : "")).trim() };
}

const osa = (script: string) => run(["osascript", "-e", script]);

export class HostControl {
  constructor(private session: Session) {}

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
          return this.arrange((a.app ?? "").split(",").map((s) => s.trim()).filter(Boolean), a.layout ?? "left-right");
        case "simulator":
          return this.simulator(a.device, a.url);
        case "shell": {
          if (!a.command) return "Give a command.";
          const r = await run(["/bin/zsh", "-lc", a.command], 60_000);
          this.log(`Ran on the host: ${a.command}`);
          return `exit ${r.code}\n${r.out.slice(-4000)}`;
        }
        case "focus_jamsesh":
          bus.send({ type: "toast", tone: "info", text: "Back to JamSesh" });
          await run(["open", `http://127.0.0.1:${new URL(this.session.hubUrl).port}/host`]);
          return "JamSesh is in front.";
      }
    } catch (e) {
      return `Host action failed: ${e instanceof Error ? e.message : e}`;
    }
    return "Unknown action.";
  }

  /** Places the front window of each app in columns (or a grid) on the main screen. */
  async arrange(apps: string[], layout: "left-right" | "grid" | "full"): Promise<string> {
    if (!apps.length) return "Name the apps to arrange, comma-separated.";
    const bounds = await osa('tell application "Finder" to get bounds of window of desktop');
    const [, , W, H] = bounds.out.split(/,\s*/).map(Number);
    if (!W || !H) return `Couldn't read the screen size: ${bounds.out}`;
    const top = 32;
    const n = apps.length;
    const cols = layout === "grid" ? Math.ceil(Math.sqrt(n)) : layout === "full" ? 1 : n;
    const rows = Math.ceil(n / cols);
    const w = Math.floor(W / cols);
    const h = Math.floor((H - top) / rows);
    const problems: string[] = [];
    for (const [i, app] of apps.entries()) {
      const x = (i % cols) * w;
      const y = top + Math.floor(i / cols) * h;
      await run(["open", "-a", app]);
      const r = await osa(
        `tell application "System Events" to tell (first process whose name is "${app.replace(/"/g, "")}")
           set frontmost to true
           set position of window 1 to {${x}, ${y}}
           set size of window 1 to {${w}, ${h}}
         end tell`,
      );
      if (r.code) problems.push(`${app}: ${r.out.includes("assistive") ? "JamSesh needs Accessibility permission (System Settings > Privacy & Security > Accessibility)" : r.out}`);
    }
    this.log(`Arranged ${apps.join(", ")} ${layout} on the host.`);
    return problems.length ? `Arranged with problems: ${problems.join("; ")}` : `Arranged ${apps.join(", ")}.`;
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
