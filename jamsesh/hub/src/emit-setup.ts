// Writes the agent setup the Mac app runs, and the hook it installs, as files (the app bundles them and never runs script text fetched from a host):
//   bun hub/src/emit-setup.ts <folder>   ->   <folder>/agent-setup.sh, <folder>/agent-hook.sh
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookScript, joinScript } from "./install-scripts";

const out = process.argv[2];
if (!out) {
  console.error("usage: emit-setup.ts <folder>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "agent-setup.sh"), joinScript(null, "http://127.0.0.1:0", "", true));
writeFileSync(join(out, "agent-hook.sh"), hookScript());
chmodSync(join(out, "agent-setup.sh"), 0o755);
chmodSync(join(out, "agent-hook.sh"), 0o755);
