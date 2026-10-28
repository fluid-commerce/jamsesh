// Scripts the hub serves to client machines: /join.sh sets a laptop up for the
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
curl -s --max-time 3 -X POST -H 'content-type: application/json' -H "x-jam-code: $JAMSESH_CODE" \\
  --data-binary @- "$JAMSESH_HUB/api/hooks/$1" 2>/dev/null || true
`;
}

export function joinScript(hub: Hub) {
  const HUB = hub.session.hubUrl;
  const CODE = hub.session.code;
  return `#!/usr/bin/env bash
# JamSesh: connect this computer to the session at ${HUB}
#   curl -fsSL ${HUB}/join.sh | bash
# Sets up Claude Code and Codex (MCP server, hooks, /jamsesh command, skill), offers this
# computer's whisper for room transcription, and opens your JamSesh window.
set -euo pipefail
HUB="${HUB}"
CODE="${CODE}"
DIR="$HOME/.jamsesh"
mkdir -p "$DIR"
say() { printf '\\033[1m%s\\033[0m\\n' "$*"; }
ok() { printf '  \\033[32m✓\\033[0m %s\\n' "$*"; }
skip() { printf '  \\033[2m- %s\\033[0m\\n' "$*"; }

if ! curl -fsS --max-time 4 "$HUB/healthz" >/dev/null; then
  echo "Can't reach the host at $HUB. Are you on the same network?" >&2
  exit 1
fi

NAME="\${JAMSESH_NAME:-}"
if [ -z "$NAME" ] && [ -f "$DIR/client.env" ]; then NAME="$(. "$DIR/client.env"; echo "\${JAMSESH_NAME:-}")"; fi
if [ -z "$NAME" ]; then
  printf 'Your first name (how the room knows you): '
  read -r NAME </dev/tty
fi
ROLE="\${JAMSESH_ROLE:-}"
if [ -z "$ROLE" ] && [ -t 0 -o -e /dev/tty ]; then
  printf 'Your role (for example designer, engineer, CPO; Enter to skip): '
  read -r ROLE </dev/tty || true
fi

cat > "$DIR/client.env" <<ENV
JAMSESH_HUB="$HUB"
JAMSESH_CODE="$CODE"
JAMSESH_NAME="$NAME"
JAMSESH_ACTIVE=1
ENV
chmod 600 "$DIR/client.env"
curl -fsS "$HUB/hook.sh" -o "$DIR/hook.sh" && chmod +x "$DIR/hook.sh"
curl -fsS -X POST -H 'content-type: application/json' -H "x-jam-code: $CODE" \\
  -d "{\\"name\\": \\"$NAME\\", \\"role\\": \\"$ROLE\\"}" "$HUB/api/people" >/dev/null || true
say "JamSesh: setting up $NAME's computer"

# --- Claude Code ---
if command -v claude >/dev/null 2>&1; then
  claude mcp remove jamsesh -s user >/dev/null 2>&1 || true
  claude mcp add --transport http -s user jamsesh "$HUB/mcp?code=$CODE" >/dev/null
  ok "Claude Code: MCP server 'jamsesh'"
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills/jamsesh"
  curl -fsS -H "x-jam-code: $CODE" "$HUB/skill.md" -o "$HOME/.claude/skills/jamsesh/SKILL.md"
  ok "Claude Code: jamsesh skill"
  cat > "$HOME/.claude/commands/jamsesh.md" <<'CMD'
---
description: Connect this session to the JamSesh room
argument-hint: [what you're working on]
---
Connect to the JamSesh room session and work as part of it.

1. Load the jamsesh skill and follow it for the rest of this session.
2. Find this repository's remote (git remote get-url origin), branch, and what it builds (desktop, mobile, web, backend, or design).
3. Call jam_join (owner: the name in ~/.jamsesh/client.env as JAMSESH_NAME, harness: claude-code, cwd: this directory). Use this as the focus: $ARGUMENTS
4. Read what comes back, jam_claim your workstream, and tell me in two lines who else is here and what's open.
5. Then do the work. When you're idle, call jam_wait so the room can reach you.
CMD
  ok "Claude Code: /jamsesh command"
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
  ok "Claude Code: hooks (your prompts go to the room; room directives come to your agent)"
else
  skip "Claude Code isn't installed"
fi

# --- Codex ---
if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/prompts"
  python3 - "$HUB" "$CODE" <<'PY'
import os, re, sys
hub, code = sys.argv[1], sys.argv[2]
path = os.path.expanduser("~/.codex/config.toml")
text = open(path).read() if os.path.exists(path) else ""
text = re.sub(r"\\n?\\[mcp_servers\\.jamsesh\\][^\\[]*", "\\n", text).rstrip() + "\\n"
text += f'\\n[mcp_servers.jamsesh]\\nurl = "{hub}/mcp?code={code}"\\ntool_timeout_sec = 600\\n'
open(path, "w").write(text)
PY
  curl -fsS -H "x-jam-code: $CODE" "$HUB/skill.md" -o "$HOME/.codex/prompts/jamsesh.md"
  printf '\\n\\nConnect now: call jam_join (owner from ~/.jamsesh/client.env JAMSESH_NAME, harness codex, cwd this directory), jam_claim your workstream, and when idle call jam_wait. Focus: $ARGUMENTS\\n' >> "$HOME/.codex/prompts/jamsesh.md"
  ok "Codex: MCP server 'jamsesh' and /jamsesh prompt"
else
  skip "Codex isn't installed"
fi

# --- This computer's whisper, offered to the room ---
WS="$(command -v whisper-server || true)"
MODEL=""
for m in "$HOME/.cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin" "$HOME/.cache/whisper-cpp/ggml-large-v3-turbo.bin" "$HOME/.cache/whisper-cpp/ggml-base.en.bin"; do
  [ -f "$m" ] && MODEL="$m" && break
done
if [ -n "$WS" ] && [ -n "$MODEL" ]; then
  if ! curl -fsS --max-time 1 http://127.0.0.1:8179/ >/dev/null 2>&1; then
    nohup "$WS" -m "$MODEL" --host 0.0.0.0 --port 8179 -l en --no-timestamps >"$DIR/whisper.log" 2>&1 &
    sleep 2
  fi
  curl -fsS -X POST -H 'content-type: application/json' -H "x-jam-code: $CODE" \\
    -d "{\\"id\\": \\"worker-$NAME\\", \\"label\\": \\"$NAME's whisper\\", \\"url\\": \\"http://localhost:8179\\"}" "$HUB/api/workers" >/dev/null \\
    && ok "Local whisper offered to the room (port 8179)"
else
  skip "No local whisper (brew install whisper-cpp to share transcription work)"
fi

# --- Your JamSesh window ---
URL="$HUB/client?code=$CODE&name=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$NAME")"
CHROME="/Applications/Google Chrome.app"
if [ -d "$CHROME" ]; then
  # A separate profile lets the window use your mic on the room's plain-HTTP address.
  open -na "$CHROME" --args --app="$URL" --user-data-dir="$DIR/chrome" \\
    --unsafely-treat-insecure-origin-as-secure="$HUB" --no-first-run >/dev/null 2>&1 || true
  ok "Opened your JamSesh window"
else
  open "$URL" 2>/dev/null || true
  skip "Opened in your browser; install Chrome for mic capture over the LAN"
fi
echo
say "Done. In Claude Code or Codex, run /jamsesh in each repository you're working in."
echo "To disconnect this computer later: sed -i '' 's/JAMSESH_ACTIVE=1/JAMSESH_ACTIVE=0/' $DIR/client.env"
`;
}
