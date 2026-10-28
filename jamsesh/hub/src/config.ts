import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

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
mkdirSync(dataDir, { recursive: true });

/** People, devices, voiceprints and team settings outlive sessions (`jamsesh new` keeps them). */
const teamDir = process.env.JAMSESH_TEAM ?? (process.env.JAMSESH_DATA ? join(process.env.JAMSESH_DATA, "team") : join(HOME, "team"));
mkdirSync(teamDir, { recursive: true });

export const config = {
  home: HOME,
  teamDir,
  repo: REPO,
  dataDir,
  port: Number(process.env.JAMSESH_PORT ?? 4747),
  figcraftPort: Number(process.env.JAMSESH_FIGCRAFT_PORT ?? 47900),
  devPortStart: Number(process.env.JAMSESH_DEV_PORT_START ?? 5100),
  /** The address clients use to reach this host. */
  publicHost: process.env.JAMSESH_PUBLIC_HOST ?? lanAddress(),
  envGatewayKey: process.env.AI_GATEWAY_API_KEY ?? envFile.AI_GATEWAY_API_KEY,
  /** Set JAMSESH_OFFLINE=1 in tests: the brain uses its rule-based fallback only. */
  offline: process.env.JAMSESH_OFFLINE === "1",
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
  whisperServerBin: firstExisting(process.env.JAMSESH_WHISPER_SERVER, "/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"),
  whisperModel: firstExisting(
    process.env.JAMSESH_WHISPER_MODEL,
    join(homedir(), ".cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin"),
    join(homedir(), ".cache/whisper-cpp/ggml-large-v3-turbo.bin"),
    join(homedir(), ".cache/whisper-cpp/ggml-medium.en.bin"),
    join(homedir(), ".cache/whisper-cpp/ggml-base.en.bin"),
  ),
  speakerModel: firstExisting(join(HOME, "models", "wespeaker_en.onnx"), res("models", "wespeaker_en.onnx")),
};

export type Config = typeof config;
