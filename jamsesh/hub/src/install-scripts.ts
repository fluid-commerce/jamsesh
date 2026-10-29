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
# client.env is read as data, never run: the person's name in it comes from the room.
conf() { sed -n "s/^$1=//p" "$cfg" | head -n 1 | sed -e "s/^[\\"']//" -e "s/[\\"']\\$//"; }
[ "$(conf JAMSESH_ACTIVE)" = "1" ] || exit 0
hub="$(conf JAMSESH_HUB)"
[ -n "$hub" ] || exit 0
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
acks="$dir/acks/$sid"
hdr="$dir/.headers.$$"
now="$(date +%s)"
locked=""
trap 'rm -f "$hdr"; [ -z "$locked" ] || rmdir "$outbox.lock" 2>/dev/null' EXIT
hub_down() { [ -f "$down" ] && [ $((now - $(cat "$down" 2>/dev/null || echo 0))) -lt 45 ]; }
# The credential is in a file (mode 600) that curl reads, so it never shows in a process list. With
# none, the JamSesh app's relay on this Mac adds it.
auth=()
[ -f "$dir/auth.header" ] && auth=(-H "@$dir/auth.header")
post() { curl -fs "\${auth[@]}" -X POST -H 'content-type: application/json' "$@"; }
header() { grep -i "^$1:" "$hdr" 2>/dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -cd 'A-Za-z0-9_-'; }
# What the host handed over is only delivered once this chat says it passed it on: the delivery ids
# wait here and go back with the next call (the host offers anything unconfirmed again).
sent="$(ls "$acks" 2>/dev/null | tr '\\n' ',' | sed 's/,$//')"
confirmed() { local id; for id in $(printf '%s' "$sent" | tr ',' ' '); do rm -f "$acks/$id"; done; }
handed_over() { local id; id="$(header x-jam-delivery)"; [ -n "$id" ] && mkdir -p "$acks" && : > "$acks/$id"; }
gone() { [ "$(header x-jam-joined)" = "0" ]; }
joined() { printf '{"session_id":"%s","connect":%s}' "$1" "\${2:-false}" | post --max-time 3 --data-binary @- "$hub/api/hooks/joined" 2>/dev/null; }

# Each prompt has an id that goes with it, and stays with it in the outbox, so the host records it once
# however often it arrives (a send whose answer was lost, then the same prompt replayed).
pid="p$now-$$-$RANDOM$RANDOM"
# Every chat's hooks share the outbox: one at a time changes it. A lock left by a hook that was
# killed holding it is cleared after a minute.
lock() {
  local i=0
  find "$outbox.lock" -maxdepth 0 -mmin +1 -exec rmdir {} \\; 2>/dev/null
  until mkdir "$outbox.lock" 2>/dev/null; do i=$((i + 1)); [ "$i" -ge 30 ] && return 1; sleep 0.1; done
  locked=1
}
unlock() { rmdir "$outbox.lock" 2>/dev/null; locked=""; }
# The host was unreachable a moment ago: don't make every prompt wait for it again. A chat this Mac
# saw joined keeps its prompts until the host is back.
queue() {
  [ "$1" = "prompt" ] && [ -f "$mark" ] || return 0
  lock || return 0
  printf '%s\\t%s\\t%s\\n' "$now" "$pid" "$(printf '%s' "$body" | tr -d '\\n')" >> "$outbox"
  # Keep the newest 50 only.
  if [ "$(wc -l < "$outbox")" -gt 50 ]; then tail -n 50 "$outbox" > "$outbox.tmp" && mv -f "$outbox.tmp" "$outbox"; fi
  unlock
}
if hub_down; then queue "$1"; exit 0; fi

# Has this chat joined? Asked every time, so a chat the room removed (or a host this Mac switched
# away from) gets nothing more. The question carries only the session id.
connect=false
if [ "$1" = "prompt" ] && printf '%s' "$body" | grep -Eiq '"prompt"[[:space:]]*:[[:space:]]*"([[:space:]]|\\\\n)*((please|ok|okay|hey|now)[[:space:],]+)*(connect to jamsesh|join jamsesh|join the (jam)?session|/jamsesh)'; then connect=true; fi
if ! ans="$(joined "$sid" "$connect")"; then
  printf '%s' "$now" > "$down"
  queue "$1"
  exit 0
fi
if ! printf '%s' "$ans" | grep -q '"joined":true'; then
  rm -f "$mark"
  # Not joined. The person asking to connect is the one moment this chat needs its id: the agent
  # passes it to jam_join. Saying so also lets a chat the room removed join again.
  if [ "$connect" = true ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"JamSesh chat id for jam_join (pass it as chat): %s"}}' "$sid"
  fi
  exit 0
fi
mkdir -p "$dir/chats" && : > "$mark"
rm -f "$down"

# listen runs in the background after the agent stops (asyncRewake): it holds until the room has
# something for the idle agent, prints it and exits 2, which wakes the agent. No news is exit 0.
if [ "$1" = "listen" ]; then
  end=$((now + \${JAMSESH_LISTEN_SECONDS:-3000}))
  while [ "$(date +%s)" -lt "$end" ]; do
    if out="$(printf '%s' "$body" | post --max-time 230 -D "$hdr" -H "x-jam-ack: $sent" --data-binary @- "$hub/api/hooks/listen" 2>/dev/null)"; then
      confirmed
      sent=""
      gone && { rm -f "$mark"; exit 0; }
      if [ -n "$out" ]; then printf '%s\\n' "$out" >&2; handed_over; exit 2; fi
    else
      # The answer didn't arrive: ask again in a moment (the host offers the same items again).
      sleep 5
    fi
  done
  exit 0
fi

if ! out="$(printf '%s' "$body" | post --max-time 4 -D "$hdr" -H "x-jam-ack: $sent" -H "x-jam-prompt-id: $pid" --data-binary @- "$hub/api/hooks/$1" 2>/dev/null)"; then
  # The host is unreachable: keep prompts so they reach the room when it's back.
  printf '%s' "$now" > "$down"
  queue "$1"
  exit 0
fi
confirmed
printf '%s' "$out"
handed_over
gone && rm -f "$mark"
# Back in touch: send what was queued while the host was away, two at a time (each call stays
# short). An entry leaves the outbox only once the host has it, it's too old to matter (ten minutes:
# a prompt from hours ago would only confuse the room), or its chat isn't in the room any more.
if [ -s "$outbox" ] && lock; then
  : > "$outbox.keep"
  n=0
  while IFS=$'\\t' read -r ts qid line; do
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    # Queued by an older hook.sh, without an id: one made from the line stays the same on every try.
    [ -n "$line" ] || { line="$qid"; qid="q$ts-$(printf '%s' "$line" | cksum | cut -d ' ' -f 1)"; }
    [ $((now - ts)) -le 600 ] && [ -n "$line" ] || continue
    keep() { printf '%s\\t%s\\t%s\\n' "$ts" "$qid" "$line" >> "$outbox.keep"; }
    [ "$n" -lt 2 ] || { keep; continue; }
    n=$((n + 1))
    qsid="$(printf '%s' "$line" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p' | head -n 1)"
    [ -n "$qsid" ] || continue
    ans="$(joined "$qsid")" || { keep; continue; }
    printf '%s' "$ans" | grep -q '"joined":true' || continue
    printf '%s' "$line" | post --max-time 4 -H "x-jam-prompt-id: $qid" --data-binary @- "$hub/api/hooks/prompt" >/dev/null 2>&1 || keep
  done < "$outbox"
  mv -f "$outbox.keep" "$outbox"
  unlock
fi
`;
}

/** The blocks earlier installs wrote into AGENTS.md, exactly (the first one, then the longer one that replaced it). */
const SHORT_BLOCK = [
  "<!-- jamsesh:start -->",
  "## JamSesh",
  "",
  'When your person says "connect to jamsesh", "join jamsesh", or "join the session", read',
  "~/.codex/prompts/jamsesh.md and follow it: it connects you to the room session through the",
  "`jamsesh` MCP tools. If those tools fail to connect, tell your person to open the JamSesh app and",
  "host or join a session.",
];
export const OLD_BLOCKS = [
  [
    ...SHORT_BLOCK,
    "",
    "When the `jamsesh` tools are available and you start work in a repository, join the session first",
    "(jam_join, jam_repo_card, jam_claim) unless you already did in this conversation. Codex has no hooks",
    "here, so you are the room's only link to your person: post a one-line jam_update (progress) when",
    "your person gives you a new task, check jam_inbox between steps, and when you are idle keep",
    "calling jam_wait instead of ending your turn.",
    "<!-- jamsesh:end -->",
  ],
  [...SHORT_BLOCK, "<!-- jamsesh:end -->"],
].map((lines) => lines.join("\n"));

/**
 * Removes the block an earlier JamSesh wrote into AGENTS.md (or CLAUDE.md) and touches nothing else.
 * Only the exact blocks JamSesh used to write count, whole lines, with the file's own line endings;
 * anything else between the markers is the person's and stays. Every other byte is kept, except the
 * one blank line the old writer put before a block it appended at the end of the file. A symlinked
 * file (a shared CLAUDE.md/AGENTS.md) is edited at its target, so the link stays a link. A file
 * with no block isn't rewritten.
 */
export const STRIP_BLOCK_PL = String.raw`use strict; use warnings; use Cwd qw(abs_path);
my ($path) = @ARGV;
exit 0 unless -f $path;
my $real = abs_path($path) // exit 0;
open(my $in, '<:raw', $real) or exit 0;
my $text = do { local $/; <$in> };
close $in;
my @blocks = (${OLD_BLOCKS.map((b) => `'${b.replace(/[\\']/g, "\\$&")}'`).join(", ")});
my $changed = 0;
for my $old (@blocks) {
  for my $eol ("\r\n", "\n") {
    my $block = join($eol, split(/\n/, $old, -1));
    my $from = 0;
    while ((my $i = index($text, $block, $from)) >= 0) {
      my $j = $i + length $block;
      my $starts = $i == 0 || substr($text, $i - 1, 1) eq "\n";
      my $after = substr($text, $j, length $eol);
      if (!$starts || ($j < length $text && $after ne $eol)) { $from = $i + 1; next; }
      $j += length $after;
      # Appended at the end after a blank line ("text\n\n<block>\n"): that blank line was JamSesh's too.
      $i -= length $eol if $j == length $text && $i >= 2 * length($eol) && substr($text, $i - 2 * length($eol), 2 * length($eol)) eq $eol x 2;
      substr($text, $i, $j - $i) = '';
      $changed = 1;
      $from = $i;
    }
  }
}
exit 0 unless $changed;
if ($text eq '' && !-l $path) { unlink $real; exit 0; }
my $mode = (stat $real)[2] & 07777;
my $tmp = "$real.jamsesh-tmp";
open(my $o, '>:raw', $tmp) or die "JamSesh: can't write $tmp: $!\n";
print $o $text;
close $o or die "JamSesh: can't write $tmp: $!\n";
chmod $mode, $tmp;
rename $tmp, $real or die "JamSesh: can't replace $real: $!\n";
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

The token never goes in a command: commands land in shell history and process lists.

1. Make JamSesh's private folder: \`mkdir -p ~/.jamsesh && chmod 700 ~/.jamsesh\`
2. With your file-writing tool (not a shell command), create \`~/.jamsesh/auth.header\` holding exactly
   this one line:

   \`\`\`
   authorization: Bearer ${token}
   \`\`\`

3. Run this one command. It configures Claude Code and Codex on this computer: the \`jamsesh\` MCP
   server, a small JamSesh skill, a \`/jamsesh\` command, and Claude Code hooks. Nothing joins the room by
   itself: a chat joins only when its person tells it to ("connect to jamsesh"), and the hooks do nothing
   for any other chat. Replace <NAME> with your person's first name; ask them if you don't know it.

   \`\`\`bash
   chmod 600 ~/.jamsesh/auth.header && curl -fsSL -H @"$HOME/.jamsesh/auth.header" "${origin}/agent/setup.sh" | JAMSESH_NAME="<NAME>" bash
   \`\`\`

## Then

1. Tell your person in one line: "Connected to JamSesh. Restart me (or run /mcp and reconnect
   jamsesh), then tell me \"connect to jamsesh\" in each chat you want in the room."
2. After the restart, when your person says "connect to jamsesh" (or types \`/jamsesh\`), you call
   \`jam_join\`, claim your workstream, and follow the JamSesh skill. Until then this chat is not in the room.

If the command fails because the host is unreachable, say so; don't retry in a loop.
`;
}

/** A value as one single-quoted shell word: nothing in it is expanded or run. */
export const shellWord = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export function joinScript(hub: Hub, origin?: string, token = "") {
  const HUB = origin ?? hub.session.hubUrl;
  return `#!/usr/bin/env bash
# JamSesh: set up this computer's agents for a JamSesh host (run by the agent after pairing).
set -euo pipefail
# Everything runs inside main, read in full before it starts: piped into bash, a command that
# reads standard input (claude mcp does) would otherwise swallow the rest of this script.
main() {
HUB=${shellWord(HUB)}
TOKEN=${shellWord(token)}
DIR="$HOME/.jamsesh"
# JamSesh's folder holds credentials: only this person can open it, however it was made before.
mkdir -p "$DIR" && chmod 700 "$DIR"
# Replaces a credential file in one step with a private one (mode 600), from standard input: an
# existing file is never written in place, so a looser mode it had never carries over.
private() { local t="$1.jamsesh-tmp.$$"; (umask 077 && cat > "$t") && chmod 600 "$t" && mv -f "$t" "$1"; }
ok() { printf '  ok  %s\\n' "$*"; }
skip() { printf '  --  %s\\n' "$*"; }
# Through the JamSesh app on this computer (127.0.0.1) the app adds the credentials.
case "$HUB" in http://127.0.0.1:*) ;; *) [ -n "$TOKEN" ] || { echo "Missing token: pair first at $HUB/agent?c=<code>" >&2; exit 1; } ;; esac
# JSON and text edits run in Perl: every Mac has it, while python3 on a Mac without the developer
# tools only opens Apple's "install the command line tools" dialog.
command -v perl >/dev/null 2>&1 || { echo "JamSesh setup needs perl, which this computer doesn't have." >&2; exit 1; }
# The credential goes in files (mode 600) that curl and Claude Code read, never in a command's
# arguments, which any process on this computer can list. Empty: the JamSesh app's relay adds it.
printf 'authorization: Bearer %s\\n' "$TOKEN" | private "$DIR/auth.header"
AUTH=(-H "@$DIR/auth.header")
# A value as one single-quoted shell word, so sourcing client.env (the jamsesh command does) runs
# nothing in it; the hook reads it as data.
q() { printf "'%s'" "$(printf '%s' "$1" | tr -d '\\n\\r' | sed "s/'/'\\"'\\"'/g")"; }
# Reads a value back without running the file (an older one held the name in double quotes).
conf() { sed -n "s/^$1=//p" "$DIR/client.env" 2>/dev/null | head -n 1 | sed -e "s/^[\\"']//" -e "s/[\\"']\\$//" -e "s/'\\"'\\"'/'/g"; }
# The person is whoever the host already knows this computer as. The setup never adds a person:
# a guessed name only made duplicates.
NAME="$(curl -fsS --max-time 5 "\${AUTH[@]}" "$HUB/api/me" 2>/dev/null | perl -MJSON::PP -0777 -ne 'my $m = eval { decode_json($_) }; print $m->{person}{name} // "" if ref $m eq "HASH" && ref $m->{person} eq "HASH"' || true)"
[ -n "$NAME" ] || NAME="\${JAMSESH_NAME:-}"
if [ -z "$NAME" ] && [ -f "$DIR/client.env" ]; then NAME="$(conf JAMSESH_NAME)"; fi

{
  printf 'JAMSESH_HUB=%s\\n' "$(q "$HUB")"
  printf 'JAMSESH_TOKEN=%s\\n' "$(q "$TOKEN")"
  printf 'JAMSESH_NAME=%s\\n' "$(q "$NAME")"
  echo 'JAMSESH_ACTIVE=1'
} | private "$DIR/client.env"
curl -fsS "\${AUTH[@]}" "$HUB/hook.sh" -o "$DIR/hook.sh" && chmod +x "$DIR/hook.sh"

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
  # Claude Code asks a helper for the credential header each time it connects, so the token is in
  # neither its arguments nor its config. Without a token the app's relay adds it.
  helper=""
  if [ -n "$TOKEN" ]; then
    printf '%s' "$TOKEN" | perl -MJSON::PP -0777 -ne 'print encode_json({ authorization => "Bearer $_" })' | private "$DIR/mcp-headers.json"
    printf '#!/bin/sh\\nexec cat %s\\n' "$(q "$DIR/mcp-headers.json")" | private "$DIR/mcp-headers.sh"
    chmod 700 "$DIR/mcp-headers.sh"
    helper="$DIR/mcp-headers.sh"
  fi
  "$CLAUDE" mcp add-json -s user jamsesh "$(JAMSESH_URL="$HUB/mcp" JAMSESH_HELPER="$helper" perl -MJSON::PP -e 'print JSON::PP->new->canonical->encode({ type => "http", url => $ENV{JAMSESH_URL}, ($ENV{JAMSESH_HELPER} ? (headersHelper => $ENV{JAMSESH_HELPER}) : ()) })')" >/dev/null
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills/jamsesh"
  curl -fsS "\${AUTH[@]}" "$HUB/launcher.md" -o "$HOME/.claude/skills/jamsesh/SKILL.md"
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
use strict; use warnings; use JSON::PP; use Cwd qw(abs_path);
my ($hook, $path) = @ARGV;
# A symlinked settings file is edited at its target, and keeps its mode (it may hold secrets).
$path = abs_path($path) // $path if -l $path;
my $mode = -e $path ? (stat $path)[2] & 07777 : 0600;
# The hook's path as one shell word: a home folder with spaces still runs it.
(my $cmd = $hook) =~ s/'/'\\\\''/g;
$cmd = "'$cmd'";
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
  push @kept, { hooks => [{ type => 'command', command => "$cmd $arg", timeout => 15 }] };
  # An idle agent is woken by a background listener that holds until the room has something for it.
  push @kept, { hooks => [{ type => 'command', command => "$cmd listen", timeout => 3300, asyncRewake => JSON::PP::true }] } if $event eq 'Stop';
  $hooks->{$event} = \\@kept;
}
my $tmp = "$path.jamsesh-tmp";
umask 077;
open(my $out, '>', $tmp) or die "JamSesh: can't write $tmp: $!\\n";
chmod $mode, $tmp;
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
  # The token comes from the header file, not this process's arguments or environment.
  perl - "$HUB" "$DIR/auth.header" "$HOME/.codex/config.toml" <<'PL'
use strict; use warnings;
my ($hub, $header, $path) = @ARGV;
my $token = '';
if (open(my $h, '<', $header)) { ($token) = (<$h> // '') =~ /Bearer\\s+(\\S+)/; close $h; }
$token //= '';
my $text = '';
if (-e $path) {
  open(my $in, '<', $path) or die "JamSesh: can't read $path: $!\\n";
  $text = do { local $/; <$in> };
  close $in;
}
# Takes out JamSesh's own tables ([mcp_servers.jamsesh] and its subtables) by their header lines, so
# a "[" inside a value (an IPv6 address, a comment) or a multi-line string never ends a table early.
my ($kept, $ours, $long) = ('', 0, '');
for my $line (split /(?<=\\n)/, $text) {
  if (!$long && $line =~ /^\\s*\\[\\[?\\s*([^\\]\\[#]+?)\\s*\\]\\]?\\s*(?:#.*)?\\r?\\n?\\z/) {
    (my $name = $1) =~ s/\\s*\\.\\s*/./g;
    $name =~ s/"([^"]*)"/$1/g;
    $ours = $name =~ /^mcp_servers\\.jamsesh(\\.|\\z)/ ? 1 : 0;
  }
  $kept .= $line unless $ours;
  # Inside a multi-line string nothing is a header: count the quote triples that open and close one.
  for my $q ('"' x 3, "'" x 3) {
    my $n = () = $line =~ /\\Q$q\\E/g;
    $long = $long eq $q ? '' : $q if $n % 2 && (!$long || $long eq $q);
  }
}
$text = $kept;
$text =~ s/\\s+\\z//;
(my $url = "$hub/mcp") =~ s/(["\\\\])/\\\\$1/g;
(my $tok = $token) =~ s/(["\\\\])/\\\\$1/g;
$text .= ($text eq '' ? '' : "\\n\\n") . "[mcp_servers.jamsesh]\\nurl = \\"$url\\"\\ntool_timeout_sec = 600\\ndefault_tools_approval_mode = \\"approve\\"\\n\\n[mcp_servers.jamsesh.http_headers]\\nauthorization = \\"Bearer $tok\\"\\n";
my $tmp = "$path.jamsesh-tmp";
umask 077;
open(my $out, '>', $tmp) or die "JamSesh: can't write $tmp: $!\\n";
print $out $text;
close $out or die "JamSesh: can't write $tmp: $!\\n";
chmod 0600, $tmp;
rename $tmp, $path or die "JamSesh: can't replace $path: $!\\n";
PL
  mkdir -p "$HOME/.codex/skills/jamsesh"
  curl -fsS "\${AUTH[@]}" "$HUB/launcher.md" -o "$HOME/.codex/skills/jamsesh/SKILL.md"
  # The prompt is the full instructions, for when a person types /jamsesh in Codex.
  curl -fsS "\${AUTH[@]}" "$HUB/skill.md" -o "$HOME/.codex/prompts/jamsesh.md"
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
