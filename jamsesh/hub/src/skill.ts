import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { Hub } from "./hub";

const template = () => readFileSync(join(config.repo, "jamsesh", "skill", "SKILL.md"), "utf8");

export function skillMarkdown(hub: Hub) {
  return template().replaceAll("{{HUB}}", hub.session.hubUrl).replaceAll("{{CODE}}", hub.session.code);
}
