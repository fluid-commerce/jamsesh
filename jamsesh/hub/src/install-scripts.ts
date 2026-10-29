// Scripts the hub serves to client machines: /agent/setup.sh sets a laptop up for the
// session, /hook.sh is what Claude Code's hooks call.
import type { Hub } from "./hub";

export function hookScript(hub: Hub) {
  void hub;
  return `#!/usr/bin/env bash
# JamSesh hook for Claude Code: hook.sh prompt|tool|stop|listen, with the hook's JSON on stdin.
# Does nothing for a chat that hasn't joined the room: only a chat whose person said "connect to
# jamsesh" sends its prompts in, picks up directives, or is held at the end of a turn. Chats are told
# apart by Claude Code's session id, so a second chat in the same folder is not the joined one.
cfg="\${JAMSESH_CLIENT_ENV:-$HOME/.jamsesh/client.env}"
[ -f "$cfg" ] || exit 0
. "$cfg"
[ "\${JAMSESH_ACTIVE:-0}" = "1" ] || exit 0
body="$(cat)"
sid="$(printf '%s' "$body" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p' | head -n 1)"
[ -n "$sid" ] || exit 0
# Claude Code also sends prompts it writes itself (background task reports, relayed shell output).
# They aren't the person talking, and they carry file paths and whole reports, so they stay out of the room.
if [ "$1" = "prompt" ] && printf '%s' "$body" | grep -Eq '"prompt"[[:space:]]*:[[:space:]]*"([[:space:]]|\\\\n)*<(task-notification|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|system-reminder)'; then
  exit 0
fi
dir="\${JAMSESH_DIR:-$HOME/.jamsesh}"
outbox="\${JAMSESH_OUTBOX:-$dir/outbox.jsonl}"
down="$dir/hub-down"
mark="$dir/chats/$sid"
now="$(date +%s)"
hub_down() { [ -f "$down" ] && [ $((now - $(cat "$down" 2>/dev/null || echo 0))) -lt 45 ]; }

# Has this chat joined? Remembered once the host says so; the question carries only the session id.
if [ ! -f "$mark" ]; then
  if ! hub_down && printf '{"session_id":"%s"}' "$sid" | curl -fs --max-time 2 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" --data-binary @- "$JAMSESH_HUB/api/hooks/joined" 2>/dev/null | grep -q '"joined":true'; then
    mkdir -p "$dir/chats" && : > "$mark"
  else
    # Not joined. The person asking to connect is the one moment this chat needs its id: the agent passes it to jam_join.
    if [ "$1" = "prompt" ] && printf '%s' "$body" | grep -Eiq '"prompt"[[:space:]]*:[[:space:]]*"[^"]{0,40}(connect to jamsesh|join jamsesh|join the (jam)?session|/jamsesh)'; then
      printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"JamSesh chat id for jam_join (pass it as chat): %s"}}' "$sid"
    fi
    exit 0
  fi
fi

# listen runs in the background after the agent stops (asyncRewake): it holds until the room has
# something for the idle agent, prints it and exits 2, which wakes the agent. No news is exit 0.
if [ "$1" = "listen" ]; then
  end=$((now + \${JAMSESH_LISTEN_SECONDS:-3000}))
  while [ "$(date +%s)" -lt "$end" ]; do
    out="$(printf '%s' "$body" | curl -fs --max-time 230 -X POST -H 'content-type: application/json' -H "authorization: Bearer $JAMSESH_TOKEN" --data-binary @- "$JAMSESH_HUB/api/hooks/listen" 2>/dev/null)" || exit 0
    if [ -n "$out" ]; then printf '%s\\n' "$out" >&2; exit 2; fi
  done
  exit 0
fi

# The host was unreachable a moment ago: don't make every prompt wait for it again.
queue() {
  [ "$1" = "prompt" ] || return 0
  printf '%s\\t%s\\n' "$now" "$(printf '%s' "$body" | tr -d '\\n')" >> "$outbox"
  # Keep the newest 50 only.
  if [ "$(wc -l < "$outbox")" -gt 50 ]; then tail -n 50 "$outbox" > "$outbox.tmp" && mv -f "$outbox.tmp" "$outbox"; fi
}
if hub_down; then queue "$1"; exit 0; fi

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

/**
 * Removes the block an earlier JamSesh wrote into CLAUDE.md or AGENTS.md (between its markers) and
 * touches nothing else: line endings stay as they are, and a file with no block isn't rewritten.
 */
export const STRIP_BLOCK_PL = String.raw`use strict; use warnings;
my ($path) = @ARGV;
exit 0 unless -f $path;
open(my $in, '<:raw', $path) or exit 0;
my $text = do { local $/; <$in> };
close $in;
my $S = '<!-- jamsesh:start -->';
my $E = '<!-- jamsesh:end -->';
my $out = '';
my $changed = 0;
while (1) {
  my $i = index($text, $S);
  my $j = $i < 0 ? -1 : index($text, $E, $i + length $S);
  if ($i < 0 || $j < 0) { $out .= $text; last; }
  $out .= substr($text, 0, $i);
  $text = substr($text, $j + length $E);
  $text =~ s/\A[ \t]*(?:\r?\n)?//;
  $changed = 1;
  # The block was written after a blank line at the end of the file: take that blank line with it.
  $out =~ s/(\r?\n)(?:\r?\n)+\z/$1/ if $text eq '';
}
exit 0 unless $changed;
my $mode = (stat $path)[2] & 07777;
if ($out eq '') { unlink $path; exit 0; }
my $tmp = "$path.jamsesh-tmp";
open(my $o, '>:raw', $tmp) or die "JamSesh: can't write $tmp: $!\n";
print $o $out;
close $o or die "JamSesh: can't write $tmp: $!\n";
chmod $mode, $tmp;
rename $tmp, $path or die "JamSesh: can't replace $path: $!\n";
`;

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
server, a small JamSesh skill, a \`/jamsesh\` command, and Claude Code hooks. Nothing joins the room by
itself: a chat joins only when its person tells it to ("connect to jamsesh"), and the hooks do nothing for
any other chat. Replace <NAME> with your person's first name; ask them if you don't know it.

\`\`\`bash
curl -fsSL -H "authorization: Bearer ${token}" "${origin}/agent/setup.sh" | JAMSESH_NAME="<NAME>" bash
\`\`\`

## Then

1. Tell your person in one line: "Connected to JamSesh. Restart me (or run /mcp and reconnect
   jamsesh), then tell me \"connect to jamsesh\" in each chat you want in the room."
2. After the restart, when your person says "connect to jamsesh" (or types \`/jamsesh\`), you call
   \`jam_join\`, claim your workstream, and follow the JamSesh skill. Until then this chat is not in the room.

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
# JSON and text edits run in Perl: every Mac has it, while python3 on a Mac without the developer
# tools only opens Apple's "install the command line tools" dialog.
command -v perl >/dev/null 2>&1 || { echo "JamSesh setup needs perl, which this computer doesn't have." >&2; exit 1; }
# The person is whoever the host already knows this computer as. The setup never adds a person:
# a guessed name only made duplicates.
NAME="$(curl -fsS --max-time 5 -H "authorization: Bearer $TOKEN" "$HUB/api/me" 2>/dev/null | perl -MJSON::PP -0777 -ne 'my $m = eval { decode_json($_) }; print $m->{person}{name} // "" if ref $m eq "HASH" && ref $m->{person} eq "HASH"' || true)"
[ -n "$NAME" ] || NAME="\${JAMSESH_NAME:-}"
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

# Agent CLIs often aren't on PATH: the Claude desktop app keeps its own copy of Claude Code, and nvm
# and Volta keep theirs in their own folders. Prints the first one found, the newest copy first.
# JAMSESH_CLI_DIRS replaces the system-wide folders (tests point it somewhere empty).
find_cli() {
  local name="$1" c d
  c="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  for d in "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/.volta/bin" \${JAMSESH_CLI_DIRS-/opt/homebrew/bin /usr/local/bin}; do
    [ -x "$d/$name" ] && { printf '%s' "$d/$name"; return 0; }
  done
  for c in $(ls -td "$HOME"/.nvm/versions/node/*/bin/"$name" 2>/dev/null || true); do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  if [ "$name" = claude ]; then
    c="$(ls -td "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1 || true)"
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  fi
  return 1
}
# Takes the block an earlier JamSesh wrote into an instruction file out again, and nothing else.
strip_block() { perl - "$1" <<'STRIP'
${STRIP_BLOCK_PL}STRIP
}
configured=0

CLAUDE="$(find_cli claude || true)"
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" mcp remove jamsesh -s user >/dev/null 2>&1 || true
  "$CLAUDE" mcp add --transport http -s user jamsesh "$HUB/mcp" --header "authorization: Bearer $TOKEN" >/dev/null
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills/jamsesh"
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/launcher.md" -o "$HOME/.claude/skills/jamsesh/SKILL.md"
  # JamSesh used to write a block into CLAUDE.md. It never does now, and takes the old one out.
  strip_block "$HOME/.claude/CLAUDE.md"
  cat > "$HOME/.claude/commands/jamsesh.md" <<'CMD'
---
description: Join the JamSesh room session
argument-hint: [what you're working on]
---
Join the JamSesh room session and work as part of it.

1. Load the jamsesh skill and follow it for the rest of this session.
2. Find this repository's remote (git remote get-url origin), branch, and what it builds (desktop, mobile, web, backend, or design).
3. Call jam_join (harness: claude-code, cwd: this directory; chat: the JamSesh chat id from the note at the start of this prompt, if there is one; add owner only if jam_join asks). Use this as the focus: $ARGUMENTS
4. Post your repo card with jam_repo_card, jam_claim your workstream, and tell me in two lines who else is here and what's open.
5. Then do the work. When you're idle, just stop: JamSesh wakes you when the room has something.
CMD
  # A settings file that doesn't parse is left exactly as it is, never replaced with an empty one.
  perl - "$DIR/hook.sh" "$HOME/.claude/settings.json" <<'PL'
use strict; use warnings; use JSON::PP;
my ($hook, $path) = @ARGV;
my $data = {};
if (-e $path) {
  open(my $in, '<', $path) or die "JamSesh: can't read $path: $!\\n";
  my $text = do { local $/; <$in> };
  close $in;
  if ($text =~ /\\S/) {
    $data = eval { JSON::PP->new->relaxed->decode($text) };
    die "JamSesh: $path isn't valid JSON, so it was left as it is. Fix it, then connect again.\\n" unless ref $data eq 'HASH';
  }
}
$data->{hooks} = {} unless ref $data->{hooks} eq 'HASH';
my $hooks = $data->{hooks};
my $plain = JSON::PP->new->allow_nonref;
# JamSesh no longer reminds every new session to join: take that hook out of earlier installs.
if (ref $hooks->{SessionStart} eq 'ARRAY') {
  my @kept = grep { index($plain->encode($_), 'jamsesh') < 0 } @{ $hooks->{SessionStart} };
  if (@kept) { $hooks->{SessionStart} = \\@kept } else { delete $hooks->{SessionStart} }
}
for my $pair (['UserPromptSubmit', 'prompt'], ['PostToolUse', 'tool'], ['Stop', 'stop']) {
  my ($event, $arg) = @$pair;
  my @kept = grep { index($plain->encode($_), 'jamsesh') < 0 } (ref $hooks->{$event} eq 'ARRAY' ? @{ $hooks->{$event} } : ());
  push @kept, { hooks => [{ type => 'command', command => "$hook $arg", timeout => 5 }] };
  # An idle agent is woken by a background listener that holds until the room has something for it.
  push @kept, { hooks => [{ type => 'command', command => "$hook listen", timeout => 3300, asyncRewake => JSON::PP::true }] } if $event eq 'Stop';
  $hooks->{$event} = \\@kept;
}
my $tmp = "$path.jamsesh-tmp";
open(my $out, '>', $tmp) or die "JamSesh: can't write $tmp: $!\\n";
print $out JSON::PP->new->pretty->canonical->encode($data);
close $out or die "JamSesh: can't write $tmp: $!\\n";
rename $tmp, $path or die "JamSesh: can't replace $path: $!\\n";
PL
  ok "Claude Code: MCP server, skill, /jamsesh command, hooks (a chat joins only when told to)"
  configured=$((configured + 1))
else
  skip "Claude Code isn't installed"
fi

if find_cli codex >/dev/null || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/prompts"
  perl - "$HUB" "$TOKEN" "$HOME/.codex/config.toml" <<'PL'
use strict; use warnings;
my ($hub, $token, $path) = @ARGV;
my $text = '';
if (-e $path) {
  open(my $in, '<', $path) or die "JamSesh: can't read $path: $!\\n";
  $text = do { local $/; <$in> };
  close $in;
}
$text =~ s/\\n?\\[mcp_servers\\.jamsesh(\\.[a-z_]+)?\\][^\\[]*/\\n/g;
$text =~ s/\\s+\\z//;
$text .= "\\n\\n[mcp_servers.jamsesh]\\nurl = \\"$hub/mcp\\"\\ntool_timeout_sec = 600\\ndefault_tools_approval_mode = \\"approve\\"\\n\\n[mcp_servers.jamsesh.http_headers]\\nauthorization = \\"Bearer $token\\"\\n";
my $tmp = "$path.jamsesh-tmp";
umask 077;
open(my $out, '>', $tmp) or die "JamSesh: can't write $tmp: $!\\n";
print $out $text;
close $out or die "JamSesh: can't write $tmp: $!\\n";
chmod 0600, $tmp;
rename $tmp, $path or die "JamSesh: can't replace $path: $!\\n";
PL
  mkdir -p "$HOME/.codex/skills/jamsesh"
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/launcher.md" -o "$HOME/.codex/skills/jamsesh/SKILL.md"
  # The prompt is the full instructions, for when a person types /jamsesh in Codex.
  curl -fsS -H "authorization: Bearer $TOKEN" "$HUB/skill.md" -o "$HOME/.codex/prompts/jamsesh.md"
  printf '\\n\\nJoin now: call jam_join (harness codex, cwd this directory; add owner only if jam_join asks), post jam_repo_card, jam_claim your workstream, and when idle call jam_wait. Focus: $ARGUMENTS\\n' >> "$HOME/.codex/prompts/jamsesh.md"
  # JamSesh used to write a block into AGENTS.md. It never does now, and takes the old one out.
  strip_block "$HOME/.codex/AGENTS.md"
  ok "Codex: MCP server, skill, /jamsesh prompt (Codex has no hooks here; a chat joins only when told to)"
  configured=$((configured + 1))
else
  skip "Codex isn't installed"
fi
# Saying "done" when no agent was set up sent people off to restart agents that would never connect.
if [ "$configured" -eq 0 ]; then
  echo "Didn't find Claude Code or Codex on this computer, so no agent was connected. Install one (or open it once), then connect again." >&2
  exit 1
fi
echo "Done. Restart Claude Code or Codex (or run /mcp and reconnect jamsesh), then tell it: connect to jamsesh."
}
main "$@" </dev/null
`;
}
