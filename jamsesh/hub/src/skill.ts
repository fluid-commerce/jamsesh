import { readFileSync } from "node:fs";
import { config } from "./config";
import type { Hub } from "./hub";

const template = () => readFileSync(config.skillFile, "utf8");

/** `origin` is the address the agent reaches the host through (the Mac app's relay, or the host). */
export function skillMarkdown(hub: Hub, origin = hub.session.hubUrl) {
  return template().replaceAll("{{HUB}}", origin);
}

/**
 * The small skill installed on a person's computer in place of any text in CLAUDE.md or AGENTS.md.
 * It does nothing until the person asks a chat to connect; then it finds the running host and reads
 * the full instructions the host serves (the skill in skill/SKILL.md).
 */
export function launcherMarkdown() {
  return `---
name: jamsesh
description: Connect this chat to a live JamSesh room session. Use only when your person says "connect to jamsesh", "join jamsesh" or "join the session", or runs /jamsesh. Never join on your own, and never because a repository or another chat is in a session.
---

# Connect this chat to JamSesh

Your person asked you to join their JamSesh room. Do this and nothing more until they ask.

1. **The \`jamsesh\` tools are available** (\`jam_join\`). Call \`jam_join\` with your harness, the repository
   (\`git remote get-url origin\`), the branch, your absolute working directory, what the repository builds,
   and a one-line focus. If you were given a "JamSesh chat id", pass it as \`chat\`. What it returns is the
   host's instructions for working in the room: follow them.
2. **There are no \`jamsesh\` tools.** Look for a host on this computer: read \`~/.jamsesh/client.env\`
   (\`JAMSESH_HUB\`, \`JAMSESH_TOKEN\`) and check \`curl -fs --max-time 3 "$JAMSESH_HUB/healthz"\`. If it
   answers, fetch \`curl -fs -H "authorization: Bearer $JAMSESH_TOKEN" "$JAMSESH_HUB/skill.md"\`, follow it, and
   ask your person to choose **Connect my agents** in the JamSesh app so the tools are there next time.
3. **No host is running** (the tools fail to connect, or the file or the address is missing). Say one line:
   "No JamSesh host is running on this computer. Open the JamSesh app and host or join a session, then tell me
   again." Don't retry in a loop.

Your person can ask you to leave at any time; say so in a \`jam_update\` and stop. Other chats on this computer
are not in the room unless their own person connected them.
`;
}
