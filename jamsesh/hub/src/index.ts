// jamsesh host: starts the hub on this machine.
import { config } from "./config";
import { Hub } from "./hub";
import { startHttp } from "./http";

const args = new Set(process.argv.slice(2));
const hub = new Hub({ canvas: !args.has("--no-canvas"), whisper: !args.has("--no-whisper") });
const server = startHttp(hub);
await hub.start();

const url = hub.session.hubUrl;
console.log(`
  JamSesh is live: ${hub.session.settings().sessionName}
  Host view:   http://127.0.0.1:${config.port}/host
  Join code:   ${hub.session.code}
  Clients run: curl -fsSL ${url}/join.sh | bash
  Canvas:      ${hub.session.canvas.status}${hub.session.canvas.reason ? ` (${hub.session.canvas.reason})` : ""}
  Brain:       ${hub.session.settings().gatewayKeySet ? `gateway key from ${hub.session.settings().gatewayKeySource}` : "no gateway key yet (add it in Settings)"}
`);

if (args.has("--open")) Bun.spawn(["open", `http://127.0.0.1:${config.port}/host`]);

const shutdown = () => {
  hub.stop();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
