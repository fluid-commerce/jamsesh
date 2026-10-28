// jamsesh host: starts the hub on this machine.
import { config } from "./config";
import { Hub } from "./hub";
import { startHttp } from "./http";
import { advertise, stopAdvertising } from "./bonjour";

const args = new Set(process.argv.slice(2));
const hub = new Hub({ canvas: !args.has("--no-canvas"), whisper: !args.has("--no-whisper") });
const server = startHttp(hub);
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

console.log(`
  JamSesh is live: ${hub.session.settings().sessionName}
  Host view:   http://127.0.0.1:${config.port}/host
  Invite:      open the host view; it shows the QR code, address and 4-character code
  Canvas:      ${hub.session.canvas.status}${hub.session.canvas.reason ? ` (${hub.session.canvas.reason})` : ""}
  Brain:       ${hub.session.settings().gatewayKeySet ? `gateway key from ${hub.session.settings().gatewayKeySource}` : "no gateway key yet (add it in Settings)"}
`);

if (args.has("--open")) Bun.spawn(["open", `http://127.0.0.1:${config.port}/host`]);

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
