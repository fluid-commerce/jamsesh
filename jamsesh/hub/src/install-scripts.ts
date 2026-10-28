// Scripts the hub serves to client machines: /agent/setup.sh sets a laptop up for the
// session, /hook.sh is what Claude Code's hooks call.
import type { Hub } from "./hub";

export function hookScript(hub: Hub) {
  void hub;
  return `#!/usr/bin/env bash
# JamSesh hook for Claude Code: hook.sh prompt|stop|start, with the hook's JSON on stdin.
# Sends your prompts into the room's context, picks up directives the room sends you, and
# at the start of a session reminds the agent to join the room.
# Does nothing unless this machine is connected (jamsesh-client on).
cfg="\${JAMSESH_CLIENT_ENV:-$HOME/.jamsesh/client.env}"
[ -f "$cfg" ] || exit 0
. "$cfg"
[ "\${JAMSESH_ACTIVE:-0}" = "1" ] || exit 0
body="$(cat)"
dir="\${JAMSESH_DIR:-$HOME/.jamsesh}"
outbox="\${JAMSESH_OUTBOX:-$dir/outbox.jsonl}"
down="$dir/hub-down"
now="$(date +%s)"

if [ "$1" = "start" ]; then
  # Only a live room gets the reminder, and the skill is refreshed from the host while we're here.
  curl -fs --max-time 2 "$JAMSESH_HUB/healthz" >/dev/null 2>&1 || exit 0
  skill="$HOME/.claude/skills/jamsesh/SKILL.md"
  if [ -d "$(dirname "$skill")" ] && curl -fs --max-time 3 -H "authorization: Bearer $JAMSESH_TOKEN" "$JAMSESH_HUB/skill.md" -o "$skill.new" 2>/dev/null; then
    mv -f "$skill.new" "$skill"
  fi
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"JamSesh: this computer is connected to a live room session. Before you start work in a repository, join it: load the jamsesh skill, then call jam_join (harness claude-code, this directory), post your jam_repo_card, and jam_claim your workstream. If you already joined in this conversation, carry on. When you have nothing to do, keep calling jam_wait so the room can reach you."}}'
  exit 0
fi

# The host was unreachable a moment ago: don't make every prompt wait for it again.
queue() {
  [ "$1" = "prompt" ] || return 0
  printf '%s\\t%s\\n' "$now" "$(printf '%s' "$body" | tr -d '\\n')" >> "$outbox"
  # Keep the newest 50 only.
  if [ "$(wc -l < "$outbox")" -gt 50 ]; then tail -n 50 "$outbox" > "$outbox.tmp" && mv -f "$outbox.tmp" "$outbox"; fi
}
if [ -f "$down" ] && [ $((now - $(cat "$down" 2>/dev/null || echo 0))) -lt 45 ]; then queue "$1"; exit 0; fi

if ! printf '%s' "$body" | curl -fs --max-time 2 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" \\
  --data-binary @- "$JAMSESH_HUB/api/hooks/$1" 2>/dev/null; then
  # The host is unreachable: keep prompts so they reach the room when it's back.
  printf '%s' "$now" > "$down"
  queue "$1"
  exit 0
fi
rm -f "$down"
# Back in touch: send what was queued while the host was away, if it's still fresh. A prompt from
# hours ago would only confuse the room, so anything older than ten minutes is dropped.
if [ -s "$outbox" ]; then
  while IFS=$'\\t' read -r ts line; do
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    [ $((now - ts)) -le 600 ] && [ -n "$line" ] && printf '%s' "$line" | curl -fs --max-time 2 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" --data-binary @- "$JAMSESH_HUB/api/hooks/prompt" >/dev/null 2>&1
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
server, the JamSesh skill, a \`/jamsesh\` command, and Claude Code hooks (prompts go to the room,
directives from the room reach you, and each new session is reminded to join). Replace <NAME> with your person's first name; ask them if you
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
# Everything runs inside main, read in full before it starts: piped into bash, a command that
# reads standard input (claude mcp does) would otherwise swallow the rest of this script.
main() {
HUB="${HUB}"
TOKEN="${token}"
DIR="$HOME/.jamsesh"
mkdir -p "$DIR"
ok() { printf '  ok  %s\\n' "$*"; }
skip() { printf '  --  %s\\n' "$*"; }
# Through the JamSesh app on this computer (127.0.0.1) the app adds the credentials.
case "$HUB" in http://127.0.0.1:*) ;; *) [ -n "$TOKEN" ] || { echo "Missing token: pair first at $HUB/agent?c=<code>" >&2; exit 1; } ;; esac
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
3. Call jam_join (harness: claude-code, cwd: this directory; add owner only if jam_join asks). Use this as the focus: $ARGUMENTS
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
for event, arg in (("SessionStart", "start"), ("UserPromptSubmit", "prompt"), ("Stop", "stop")):
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
  mkdir -p "$HOME/.codex/skills/jamsesh"
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/skill.md" -o "$HOME/.codex/skills/jamsesh/SKILL.md" || true
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/skill.md" -o "$HOME/.codex/prompts/jamsesh.md"
  printf '\\n\\nJoin now: call jam_join (harness codex, cwd this directory; add owner only if jam_join asks), post jam_repo_card, jam_claim your workstream, and when idle call jam_wait. Focus: $ARGUMENTS\\n' >> "$HOME/.codex/prompts/jamsesh.md"
  # "connect to jamsesh" in any Codex session: a marked block in Codex's global instructions.
  python3 - "$HOME/.codex/AGENTS.md" <<'PY'
import sys, re
path = sys.argv[1]
try:
    text = open(path).read()
except FileNotFoundError:
    text = ""
block = """<!-- jamsesh:start -->
## JamSesh

When your person says "connect to jamsesh", "join jamsesh", or "join the session", read
~/.codex/prompts/jamsesh.md and follow it: it connects you to the room session through the
\`jamsesh\` MCP tools. If those tools fail to connect, tell your person to open the JamSesh app and
host or join a session.

When the \`jamsesh\` tools are available and you start work in a repository, join the session first
(jam_join, jam_repo_card, jam_claim) unless you already did in this conversation. Codex has no hooks
here, so you are the room's only link to your person: post a one-line jam_update (progress) when
your person gives you a new task, check jam_inbox between steps, and when you are idle keep
calling jam_wait instead of ending your turn.
<!-- jamsesh:end -->"""
text = re.sub(r"\\n*<!-- jamsesh:start -->.*?<!-- jamsesh:end -->\\n*", "\\n", text, flags=re.S).rstrip()
open(path, "w").write((text + "\\n\\n" if text else "") + block + "\\n")
PY
  ok "Codex: MCP server, skill, /jamsesh prompt and join instructions (Codex has no hooks here)"
else
  skip "Codex isn't installed"
fi
echo "Done. Restart Claude Code or Codex (or run /mcp and reconnect jamsesh), then tell it: connect to jamsesh."
}
main "$@" </dev/null
`;
}
