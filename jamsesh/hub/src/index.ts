// jamsesh host: starts the hub on this machine.
import { existsSync } from "node:fs";
import { config } from "./config";
import { Hub } from "./hub";
import { startHttp } from "./http";
import { advertise, stopAdvertising } from "./bonjour";
import { readWindowLinks } from "./auth";

const args = new Set(process.argv.slice(2));
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
const hostLink = fromApp ? `http://127.0.0.1:${config.port}/host` : `http://127.0.0.1:${config.port}/host-window?once=${hub.auth.windows.mint()}&next=%2Fhost`;
console.log(`
  JamSesh is live: ${hub.session.settings().sessionName}
  Host view:   ${hostLink}${fromApp ? "" : "\n               (a one-time link: open it in the browser for the big screen; restart the host for a new one)"}
  Invite:      open the host view; it shows the QR code, address and 4-character code
  Canvas:      ${hub.session.canvas.status}${hub.session.canvas.reason ? ` (${hub.session.canvas.reason})` : ""}
  Brain:       ${hub.session.settings().gatewayKeySet ? `gateway key from ${hub.session.settings().gatewayKeySource}` : "no gateway key yet (add it in Settings)"}
`);

if (args.has("--open")) openBigScreen(hostLink);

/** The big screen: Chrome in app mode, full screen, with its own profile, or the default browser. */
function openBigScreen(url: string) {
  const chrome = "/Applications/Google Chrome.app";
  const home = process.env.HOME ?? "";
  if (existsSync(chrome))
    Bun.spawn(["open", "-na", chrome, "--args", `--app=${url}`, "--start-fullscreen", `--user-data-dir=${home}/.jamsesh/chrome-host`, "--autoplay-policy=no-user-gesture-required", "--no-first-run"], { stdout: "ignore", stderr: "ignore" });
  else Bun.spawn(["open", url]);
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return process.exit(0);
  stopping = true;
  console.log("Saving the session…");
  stopAdvertising();
  await hub.shutdown();
  secure?.stop(true);
  server.stop(true);
  process.exit(0);
};
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
