import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { createProject, defaultProject, findProject, migrateLegacy, openSession, takeNewSessionMark } from "./projects";

const HOME = process.env.JAMSESH_HOME ?? join(homedir(), ".jamsesh");
const REPO = resolve(import.meta.dir, "../../..");
/** Set by the Mac app: the hub's files inside the app bundle (web app, canvas, skill, binaries). */
const RES = process.env.JAMSESH_RESOURCES;
const res = (...p: string[]) => (RES ? join(RES, ...p) : undefined);

function firstExisting(...paths: (string | undefined)[]): string | undefined {
  return paths.find((p) => p && existsSync(p));
}

/** Reads KEY=value lines from ~/.jamsesh/.env into a map (never into the log). */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** This machine's addresses: its LAN address and, when present, its Tailscale address. */
export function hostAddresses(): { label: string; host: string }[] {
  const out: { label: string; host: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254")) continue;
      const tail = a.address.startsWith("100.") && Number(a.address.split(".")[1]) >= 64 && Number(a.address.split(".")[1]) < 128;
      if (tail || /^utun|^tailscale/.test(name)) out.push({ label: "Remote (Tailscale)", host: a.address });
      else if (!out.some((o) => o.label === "In the room")) out.push({ label: "In the room", host: a.address });
    }
  }
  return out;
}

/** Same /24 as one of this machine's LAN addresses: someone in the room. */
export function sameLan(ip: string) {
  const clean = ip.replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1") return true;
  const prefix = clean.split(".").slice(0, 3).join(".");
  return hostAddresses().some((a) => a.label === "In the room" && a.host.split(".").slice(0, 3).join(".") === prefix);
}

export function lanAddress(): string {
  const room = hostAddresses().find((a) => a.label === "In the room");
  if (room) return room.host;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254")) return a.address;
    }
  }
  return "127.0.0.1";
}

const envFile = readEnvFile(join(HOME, ".env"));
const dataDir = process.env.JAMSESH_DATA ?? join(HOME, "host");

/** People, devices, voiceprints and team settings outlive sessions (`jamsesh new` keeps them). */
const teamDir = process.env.JAMSESH_TEAM ?? (process.env.JAMSESH_DATA ? join(process.env.JAMSESH_DATA, "team") : join(HOME, "team"));
mkdirSync(teamDir, { recursive: true });

export const config = {
  home: HOME,
  teamDir,
  repo: REPO,
  /** The session's directory. `enterProject` moves it into a project before the hub is built. */
  dataDir,
  /** The project this run is a session of; null when JAMSESH_DATA chose the directory. */
  project: null as { slug: string; name: string; sessionId: string; resumed: boolean } | null,
  /** Only the Projects picker runs (JAMSESH_LOBBY=1): no session is opened. */
  lobby: process.env.JAMSESH_LOBBY === "1",
  port: Number(process.env.JAMSESH_PORT ?? 4747),
  figcraftPort: Number(process.env.JAMSESH_FIGCRAFT_PORT ?? 47900),
  devPortStart: Number(process.env.JAMSESH_DEV_PORT_START ?? 5100),
  /** The address clients use to reach this host. */
  publicHost: process.env.JAMSESH_PUBLIC_HOST ?? lanAddress(),
  envGatewayKey: process.env.AI_GATEWAY_API_KEY ?? envFile.AI_GATEWAY_API_KEY,
  /** Set JAMSESH_OFFLINE=1 in tests: the brain uses its rule-based fallback only. */
  offline: process.env.JAMSESH_OFFLINE === "1",
  /** Where open fonts come from (Fontsource, which mirrors Google Fonts): its catalogue API, and the CDN its font files must be on. Tests point both at a stub. */
  fontApi: process.env.JAMSESH_FONT_API ?? "https://api.fontsource.org/v1",
  fontCdn: process.env.JAMSESH_FONT_CDN ?? "https://cdn.jsdelivr.net/fontsource/",
  /** Google Fonts' stylesheet API and the host its font files must be on (the first place an open font is looked for; Fontsource is the second). */
  fontGoogleCss: process.env.JAMSESH_FONT_GOOGLE_CSS ?? "https://fonts.googleapis.com/css2",
  fontGoogleHost: process.env.JAMSESH_FONT_GOOGLE_HOST ?? "https://fonts.gstatic.com/",
  /** Offline runs never reach the real font services (a test that sets its own font API still does). */
  fontsOffline: process.env.JAMSESH_OFFLINE === "1" && !process.env.JAMSESH_FONT_API && !process.env.JAMSESH_FONT_GOOGLE_CSS,
  figcraftBin:
    firstExisting(
      process.env.JAMSESH_FIGCRAFT_BIN_DIR && join(process.env.JAMSESH_FIGCRAFT_BIN_DIR, "figcraft-cli"),
      res("bin", "figcraft-cli"),
      join(HOME, "bin", "figcraft-cli"),
      join(REPO, "target", "release", "figcraft-cli"),
    ) ?? "figcraft-cli",
  figcraftServerBin:
    firstExisting(
      process.env.JAMSESH_FIGCRAFT_BIN_DIR && join(process.env.JAMSESH_FIGCRAFT_BIN_DIR, "figcraft-server"),
      res("bin", "figcraft-server"),
      join(HOME, "bin", "figcraft-server"),
      join(REPO, "target", "release", "figcraft-server"),
    ) ?? "figcraft-server",
  webDist: firstExisting(res("web"), join(REPO, "jamsesh", "web", "dist")),
  canvasDist: firstExisting(res("canvas"), join(HOME, "web-canvas"), join(REPO, "dist", "web")),
  skillFile: firstExisting(res("skill", "SKILL.md"), join(REPO, "jamsesh", "skill", "SKILL.md")) ?? join(REPO, "jamsesh", "skill", "SKILL.md"),
  /** Where the voiceprint library is installed (the app ships it next to the hub). */
  nodeModules: firstExisting(res("node_modules")),
  speakerModel: firstExisting(join(HOME, "models", "wespeaker_en.onnx"), res("models", "wespeaker_en.onnx")),
};

export type Config = typeof config;

/**
 * The host's entry calls this before building the hub: the session lives inside a project (SPEC 3.6)
 * unless JAMSESH_DATA chose the directory (tests). JAMSESH_PROJECT names an existing project (slug
 * or name; one that isn't there is created), JAMSESH_NEW_PROJECT makes a new one,
 * JAMSESH_NEW_SESSION=1 skips today's session; with none of them, the project used last.
 * Sessions from before projects are copied in first (never moved).
 */
export function enterProject() {
  if (process.env.JAMSESH_DATA) return;
  migrateLegacy(HOME);
  if (config.lobby) return;
  const wanted = process.env.JAMSESH_PROJECT?.trim();
  const named = process.env.JAMSESH_NEW_PROJECT?.trim();
  const meta = named ? createProject(HOME, named) : wanted ? (findProject(HOME, wanted) ?? createProject(HOME, wanted)) : defaultProject(HOME);
  const opened = openSession(HOME, meta.slug, { fresh: takeNewSessionMark(HOME) || process.env.JAMSESH_NEW_SESSION === "1" });
  config.project = { slug: meta.slug, name: meta.name, sessionId: opened.sessionId, resumed: opened.resumed };
  config.dataDir = opened.dir;
  mkdirSync(opened.dir, { recursive: true });
}
