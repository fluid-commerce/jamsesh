import { readFileSync } from "node:fs";
import { config } from "./config";
import type { Hub } from "./hub";

const template = () => readFileSync(config.skillFile, "utf8");

/** `origin` is the address the agent reaches the host through (the Mac app's relay, or the host). */
export function skillMarkdown(hub: Hub, origin = hub.session.hubUrl) {
  return template().replaceAll("{{HUB}}", origin);
}
