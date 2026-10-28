// Scripts the hub serves to client machines: /agent/setup.sh sets a laptop up for the
// session, /hook.sh is what Claude Code's hooks call.
import type { Hub } from "./hub";

export function hookScript(hub: Hub) {
  void hub;
  return `#!/usr/bin/env bash
# JamSesh hook for Claude Code: hook.sh prompt|stop, with the hook's JSON on stdin.
# Sends your prompts into the room's context and picks up directives the room sends you.
# Does nothing unless this machine is connected (jamsesh-client on).
cfg="\${JAMSESH_CLIENT_ENV:-$HOME/.jamsesh/client.env}"
[ -f "$cfg" ] || exit 0
. "$cfg"
[ "\${JAMSESH_ACTIVE:-0}" = "1" ] || exit 0
body="$(cat)"
if ! printf '%s' "$body" | curl -fs --max-time 3 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" \\
  --data-binary @- "$JAMSESH_HUB/api/hooks/$1" 2>/dev/null; then
  # The host is unreachable: keep prompts so they reach the room when it's back.
  [ "$1" = "prompt" ] && printf '%s\\n' "$body" | tr -d '\\n' >> "\${JAMSESH_OUTBOX:-$HOME/.jamsesh/outbox.jsonl}" && echo >> "\${JAMSESH_OUTBOX:-$HOME/.jamsesh/outbox.jsonl}"
  exit 0
fi
# Back in touch: send anything queued while the host was away.
outbox="\${JAMSESH_OUTBOX:-$HOME/.jamsesh/outbox.jsonl}"
if [ -s "$outbox" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && printf '%s' "$line" | curl -fs --max-time 3 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" --data-binary @- "$JAMSESH_HUB/api/hooks/prompt" >/dev/null 2>&1
  done < "$outbox"
  : > "$outbox"
fi
`;
}

/** What a coding agent sees when it opens the host's address without a code. */
export function agentIntro(origin: string) {
  return `# This is a JamSesh host

JamSesh is a room session where people and their coding agents work together on a shared canvas.

To connect, ask your person for the 4-character code on the JamSesh screen (it changes every 30
seconds), then fetch:

    ${origin}/agent?c=<CODE>&name=<your person's first name>

That page pairs you with this host and tells you exactly how to set yourself up.
`;
}

/** Setup instructions for a freshly paired agent. The token in here is the agent's key. */
export function agentGuide(origin: string, token: string) {
  return `# You're paired with the JamSesh host at ${origin}

Your access token is below. Treat it like a password: don't print it to your person or put it in
files outside your home folder.

## Set yourself up (one time per computer)

Run this one command. It configures Claude Code and Codex on this computer: the \`jamsesh\` MCP
server, the JamSesh skill, a \`/jamsesh\` command, and two Claude Code hooks (prompts go to the room,
directives from the room reach you). Replace <NAME> with your person's first name; ask them if you
don't know it.

\`\`\`bash
curl -fsSL -H "authorization: Bearer ${token}" "${origin}/agent/setup.sh" | JAMSESH_NAME="<NAME>" bash
\`\`\`

## Then

1. Tell your person in one line: "Connected to JamSesh. Restart me (or run /mcp and reconnect
   jamsesh), then type /jamsesh in each repository you're working in."
2. After the restart, \`/jamsesh\` joins the session: you call \`jam_join\`, claim your workstream,
   and follow the JamSesh skill.

If the command fails because the host is unreachable, say so; don't retry in a loop.
`;
}

export function joinScript(hub: Hub, origin?: string, token = "") {
  const HUB = origin ?? hub.session.hubUrl;
  return `#!/usr/bin/env bash
# JamSesh: set up this computer's agents for the host at ${HUB} (run by the agent after pairing).
set -euo pipefail
HUB="${HUB}"
TOKEN="${token}"
DIR="$HOME/.jamsesh"
mkdir -p "$DIR"
ok() { printf '  ok  %s\\n' "$*"; }
skip() { printf '  --  %s\\n' "$*"; }
[ -n "$TOKEN" ] || { echo "Missing token: pair first at $HUB/agent?c=<code>" >&2; exit 1; }
NAME="\${JAMSESH_NAME:-}"
if [ -z "$NAME" ] && [ -f "$DIR/client.env" ]; then NAME="$(. "$DIR/client.env"; echo "\${JAMSESH_NAME:-}")"; fi

umask 077
cat > "$DIR/client.env" <<ENV
JAMSESH_HUB="$HUB"
JAMSESH_TOKEN="$TOKEN"
JAMSESH_NAME="$NAME"
JAMSESH_ACTIVE=1
ENV
umask 022
curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/hook.sh" -o "$DIR/hook.sh" && chmod +x "$DIR/hook.sh"
[ -n "$NAME" ] && curl -fsS -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "{\\"name\\": \\"$NAME\\"}" "$HUB/api/people" >/dev/null || true

if command -v claude >/dev/null 2>&1; then
  claude mcp remove jamsesh -s user >/dev/null 2>&1 || true
  claude mcp add --transport http -s user jamsesh "$HUB/mcp" --header "authorization: Bearer $TOKEN" >/dev/null
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills/jamsesh"
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/skill.md" -o "$HOME/.claude/skills/jamsesh/SKILL.md"
  cat > "$HOME/.claude/commands/jamsesh.md" <<'CMD'
---
description: Join the JamSesh room session
argument-hint: [what you're working on]
---
Join the JamSesh room session and work as part of it.

1. Load the jamsesh skill and follow it for the rest of this session.
2. Find this repository's remote (git remote get-url origin), branch, and what it builds (desktop, mobile, web, backend, or design).
3. Call jam_join (owner: JAMSESH_NAME from ~/.jamsesh/client.env, harness: claude-code, cwd: this directory). Use this as the focus: $ARGUMENTS
4. Post your repo card with jam_repo_card, jam_claim your workstream, and tell me in two lines who else is here and what's open.
5. Then do the work. When you're idle, call jam_wait so the room can reach you.
CMD
  python3 - "$DIR/hook.sh" <<'PY'
import json, os, sys
hook = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
try:
    data = json.load(open(path))
except Exception:
    data = {}
hooks = data.setdefault("hooks", {})
for event, arg in (("UserPromptSubmit", "prompt"), ("Stop", "stop")):
    entries = [e for e in hooks.get(event, []) if "jamsesh" not in json.dumps(e)]
    entries.append({"hooks": [{"type": "command", "command": f"{hook} {arg}", "timeout": 5}]})
    hooks[event] = entries
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, "w"), indent=2)
PY
  ok "Claude Code: MCP server, skill, /jamsesh command, hooks"
else
  skip "Claude Code isn't installed"
fi

if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/prompts"
  python3 - "$HUB" "$TOKEN" <<'PY'
import os, re, sys
hub, token = sys.argv[1], sys.argv[2]
path = os.path.expanduser("~/.codex/config.toml")
text = open(path).read() if os.path.exists(path) else ""
text = re.sub(r"\\n?\\[mcp_servers\\.jamsesh(\\.[a-z_]+)?\\][^\\[]*", "\\n", text).rstrip() + "\\n"
text += f'\\n[mcp_servers.jamsesh]\\nurl = "{hub}/mcp"\\ntool_timeout_sec = 600\\ndefault_tools_approval_mode = "approve"\\n\\n[mcp_servers.jamsesh.http_headers]\\nauthorization = "Bearer {token}"\\n'
open(path, "w").write(text)
os.chmod(path, 0o600)
PY
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/skill.md" -o "$HOME/.codex/prompts/jamsesh.md"
  printf '\\n\\nJoin now: call jam_join (owner from ~/.jamsesh/client.env JAMSESH_NAME, harness codex, cwd this directory), post jam_repo_card, jam_claim your workstream, and when idle call jam_wait. Focus: $ARGUMENTS\\n' >> "$HOME/.codex/prompts/jamsesh.md"
  ok "Codex: MCP server and /jamsesh prompt"
else
  skip "Codex isn't installed"
fi
echo "Done. Restart Claude Code or Codex (or run /mcp and reconnect jamsesh), then type /jamsesh."
`;
}
