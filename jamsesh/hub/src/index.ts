// jamsesh host: starts the hub on this machine.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, enterProject } from "./config";
import { Hub, sharedOnce } from "./hub";
import { startHttp } from "./http";
import { advertise, stopAdvertising } from "./bonjour";
import { readWindowLinks } from "./auth";
import { linkSecretFile } from "./projects";

// The compiled hub is also the host's speech model process (audio/parakeet.ts); that never returns.
if (process.argv[2] === "--stt-server") await (await import("./audio/stt-server")).runSttServer(process.argv[3] ?? "");
const args = new Set(process.argv.slice(2));
// A check of the PDF reader in a release build: `jamsesh-hub --pdf-text <file>` prints what the helper reads from it.
if (process.argv[2] === "--pdf-text" && process.argv[3]) {
  const { pdfText } = await import("./attachments");
  console.log(await pdfText(process.argv[3]));
  process.exit(0);
}
enterProject();
// The Mac app starts a hub with no session first when hosting: only the Projects picker, until a project is chosen.
if (config.lobby) {
  const { startLobby } = await import("./lobby");
  const lobby = startLobby();
  const stop = () => (lobby.stop(true), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Like the hub: if the app goes away without stopping this, exit.
  const parentPid = Number(process.env.JAMSESH_PARENT_PID);
  if (parentPid > 1) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        stop();
      }
    }, 2000).unref();
  }
  await new Promise(() => {});
}
const hub = new Hub({ canvas: !args.has("--no-canvas"), whisper: !args.has("--no-whisper") });
const server = startHttp(hub);
// The Mac app hands over its window key and one-time window links on stdin (SPEC 14).
const fromApp = process.env.JAMSESH_WINDOW_LINKS === "stdin";
if (fromApp) void readWindowLinks(hub.auth.windows);
await hub.start();

// HTTPS for the public address, once remote access is set up (the router forwards 443 here).
let secure: ReturnType<typeof startHttp> | null = null;
const startSecure = () => {
  secure?.stop(true);
  secure = null;
  const tls = hub.net.tlsOptions();
  if (!tls) return;
  try {
    secure = startHttp(hub, hub.net.status().internalPort, tls);
    console.log(`  HTTPS:       ${hub.net.status().publicUrl} (port ${hub.net.status().internalPort})`);
  } catch (e) {
    console.error("https:", e instanceof Error ? e.message : e);
  }
};
startSecure();
const announce = () => advertise(config.port, { session: hub.session.settings().sessionName, https: hub.net.status().publicUrl });
hub.net.onCertChange(() => (startSecure(), announce()));
announce();

// From a terminal: one host link, good once for ten minutes, that signs this Mac's browser in as
// the host's window. Without it the host view is read-only (SPEC 14).
if (!fromApp) writeLinkSecret();
const hostLink = fromApp ? `http://127.0.0.1:${config.port}/host` : `http://127.0.0.1:${config.port}/host-window?once=${hub.auth.windows.mint()}&next=%2Fhost`;
console.log(`
  JamSesh is live: ${hub.session.settings().sessionName}${config.project ? `\n  Project:     ${config.project.name} (${config.project.resumed ? "today's session continues" : "a new session"})` : ""}
  Host view:   ${hostLink}${fromApp ? "" : "\n               (a one-time link: open it in the browser for the big screen; restart the host for a new one)"}
  Invite:      open the host view; it shows the QR code, address and 4-character code
  Canvas:      ${hub.session.canvas.status}${hub.session.canvas.reason ? ` (${hub.session.canvas.reason})` : ""}
  Brain:       ${hub.session.settings().gatewayKeySet ? `gateway key from ${hub.session.settings().gatewayKeySource}` : "no gateway key yet (add it in Settings)"}
`);

if (args.has("--open")) openBigScreen(hostLink);

/**
 * A terminal-started hub keeps a secret in a mode-600 file of its own, so `jamsesh host` can get a
 * fresh host link when this hub is already running (POST /api/host-link). It's written as the
 * header line curl sends (`curl -H @file`), so the secret never appears in a process's arguments.
 */
function writeLinkSecret() {
  // Beside the projects, not in a session: `jamsesh host` finds it whichever session is running.
  const file = process.env.JAMSESH_DATA ? join(config.dataDir, "host-link.secret") : linkSecretFile(config.home);
  try {
    rmSync(file, { force: true });
    const secret = randomBytes(32).toString("hex");
    writeFileSync(file, `x-jam-link-secret: ${secret}\n`, { mode: 0o600, flag: "wx" });
    hub.auth.windows.linkSecret = secret;
    process.on("exit", () => rmSync(file, { force: true }));
  } catch (e) {
    console.error("host link file:", e instanceof Error ? e.message : e);
  }
}

/** The big screen: Chrome in app mode, full screen, with its own profile, or the default browser. */
function openBigScreen(url: string) {
  const chrome = "/Applications/Google Chrome.app";
  const home = process.env.HOME ?? "";
  if (existsSync(chrome))
    Bun.spawn(["open", "-na", chrome, "--args", `--app=${url}`, "--start-fullscreen", `--user-data-dir=${home}/.jamsesh/chrome-host`, "--autoplay-policy=no-user-gesture-required", "--no-first-run"], { stdout: "ignore", stderr: "ignore" });
  else Bun.spawn(["open", url]);
}

// A second signal (or the parent app vanishing mid-save) waits for the first shutdown's result:
// it never exits early, or reports a save as finished before it is.
const shutdown = sharedOnce(async () => {
  console.log("Saving the session…");
  stopAdvertising();
  const complete = await hub.shutdown();
  secure?.stop(true);
  server.stop(true);
  // 0: everything was saved and every helper was seen to exit. 3: a save failed or ran out of time, or a helper could not be confirmed stopped (the Mac app says the shutdown is incomplete).
  if (!complete) console.error("The session's shutdown didn't finish cleanly (a save, or a helper that could not be confirmed stopped).");
  process.exit(complete ? 0 : 3);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Run by the Mac app: if the app goes away without stopping the hub (a crash, Force Quit), save
// and exit instead of running on with no window, holding the port.
const parent = Number(process.env.JAMSESH_PARENT_PID);
if (parent > 1) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      void shutdown();
    }
  }, 2000).unref();
}
