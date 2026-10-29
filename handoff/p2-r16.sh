#!/usr/bin/env bash
# JamSesh: set up this computer's agents for a JamSesh host (run by the agent after pairing).
set -euo pipefail
# Everything runs inside main, read in full before it starts: piped into bash, a command that
# reads standard input (claude mcp does) would otherwise swallow the rest of this script.
main() {
HUB='http://127.0.0.1:1'
TOKEN='tok'
DIR="$HOME/.jamsesh"
# JamSesh's folder holds credentials: only this person can open it, however it was made before.
mkdir -p "$DIR" && chmod 700 "$DIR"
ok() { printf '  ok  %s\n' "$*"; }
skip() { printf '  --  %s\n' "$*"; }
# Through the JamSesh app on this computer (127.0.0.1) the app adds the credentials.
case "$HUB" in http://127.0.0.1:*) ;; *) [ -n "$TOKEN" ] || { echo "Missing token: pair first at $HUB/agent?c=<code>" >&2; exit 1; } ;; esac
# JSON and text edits run in Perl: every Mac has it, while python3 on a Mac without the developer
# tools only opens Apple's "install the command line tools" dialog.
command -v perl >/dev/null 2>&1 || { echo "JamSesh setup needs perl, which this computer doesn't have." >&2; exit 1; }
# The credential goes in files (mode 600) that curl and Claude Code read, never in a command's
# arguments, which any process on this computer can list. Empty: the JamSesh app's relay adds it.
# Only one setup runs at a time: two would share these files and the one MCP entry, and a failing run
# would roll back a good one. The lock is an flock on a file kept open as descriptor 9 for the whole run;
# the system drops it when this process ends however it ends, so there is no stale lock to recover and
# no way to take over a live one. A second run waits a few seconds, then gives up.
exec 9>>"$DIR/setup.lock"
waited=0
until perl -MFcntl=:flock -e 'open(my $f, ">&=", 9) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
  if [ "$waited" -ge $((${JAMSESH_LOCK_WAIT:-10} * 5)) ]; then
    echo "Another JamSesh setup is running on this computer. Wait for it to finish, then connect again." >&2
    exit 1
  fi
  sleep 0.2
  waited=$((waited + 1))
done
# Setup is one transaction, kept as a journal. Every file setup writes goes through safe_write, which
# first records the file's earlier content (or that it was absent), and after that the hash of what it
# wrote. Nothing is recorded for a file setup never changes, so a rollback never touches one. On any
# failure before the last step, a file is put back only if it still holds what setup wrote; one that
# someone else changed meanwhile is left as it is and listed. Claude Code's config is not a file setup
# owns: only its one jamsesh entry is read, compared and put back, key by key.
SAVED="$(mktemp -d "$DIR/.saved.XXXXXXXX")"
J="$SAVED/journal"
mkdir "$J"
sha() { perl -MDigest::SHA=sha256_hex -e 'if (open(my $f, "<:raw", $ARGV[0])) { local $/; print sha256_hex(<$f> // "") } else { print "absent" }' "$1"; }
key_of() { printf '%s' "$1" | perl -MDigest::SHA=sha1_hex -e 'local $/; print sha1_hex(<STDIN>)'; }
mode_of() { perl -e 'printf "%o", (stat $ARGV[0])[2] & 07777' "$1"; }
# Where a write to this path really lands: a symlink is followed (one that leads nowhere too), so the
# link itself stays a link.
resolve() { perl -MCwd=abs_path -MFile::Basename=dirname -e 'my $p = shift; my $r = abs_path($p); if (!defined $r && -l $p) { $r = readlink $p; $r = dirname($p) . "/" . $r unless $r =~ m{^/} } print $r // $p' "$1"; }
# Setup writes inside the person's home and never into an instruction file (CLAUDE.md, AGENTS.md), however
# a link points there.
guard() {
  local real="$1" f
  case "$real" in "$HOME"/*) ;; *) echo "JamSesh won't write $real: it is outside your home folder." >&2; return 1 ;; esac
  case "$(basename "$real" | tr 'A-Z' 'a-z')" in claude.md|agents.md) echo "JamSesh won't write $real: it is an instruction file." >&2; return 1 ;; esac
  for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do
    if [ -e "$f" ] && [ "$real" -ef "$f" ]; then echo "JamSesh won't write $real: it is an instruction file." >&2; return 1; fi
  done
}
# The one way setup writes a file: safe_write <path> <mode | keep:mode> [append], content on standard input.
# A new file is made beside the target (mktemp creates it exclusively and never follows a link), then moved over it.
safe_write() {
  local path="$1" mode="$2" append="${3:-}" real k t
  real="$(resolve "$path")"
  guard "$real" || return 1
  k="$(key_of "$real")"
  if [ ! -d "$J/$k" ]; then
    mkdir "$J/$k"
    printf '%s' "$real" > "$J/$k/path"
    if [ -f "$real" ]; then cp -p "$real" "$J/$k/before"; fi
    sha "$real" > "$J/$k/beforesha"
  fi
  t="$(mktemp "$real.XXXXXXXX")" || return 1
  if [ "$append" = append ] && [ -f "$real" ]; then cat "$real" > "$t" || { rm -f "$t"; return 1; }; fi
  cat >> "$t" || { rm -f "$t"; return 1; }
  case "$mode" in keep:*) if [ -f "$real" ]; then mode="$(mode_of "$real")"; else mode="${mode#keep:}"; fi ;; esac
  chmod "$mode" "$t" || { rm -f "$t"; return 1; }
  sha "$t" > "$J/$k/after"
  mv -f "$t" "$real"
}
# Downloads go to the saved folder (private, ours), and are checked before safe_write puts them in place.
fetch() { curl -fsS "${AUTH[@]}" "$HUB/$1" -o "$2"; }
# The jamsesh entry of Claude Code's config (~/.claude.json), alone: get prints it as JSON (nothing if
# absent), set puts the entry in the file given, del removes it. The rest of the file is carried over
# as it was read, and a write is retried if the file changed between reading it and replacing it.
mcp_key() { perl -MJSON::PP -MDigest::SHA=sha256_hex -MFile::Temp -MFile::Basename -MCwd=abs_path - "$@" <<'MCPKEY'
use strict; use warnings;
my ($op, $cfg, $val) = @ARGV;
$cfg = abs_path($cfg) // $cfg;
sub slurp { open(my $f, '<:raw', $_[0]) or return undef; local $/; my $t = <$f>; close $f; return $t }
my $js = JSON::PP->new->canonical;
if ($op eq 'get') {
  my $t = slurp($cfg);
  exit 0 unless defined $t;
  my $d = eval { decode_json($t) };
  exit 2 unless ref $d eq 'HASH';
  my $o = ref $d->{mcpServers} eq 'HASH' ? $d->{mcpServers}{jamsesh} : undef;
  print $js->encode($o) if defined $o;
  exit 0;
}
for my $try (1 .. 5) {
  my $t = slurp($cfg);
  my $d = defined $t ? eval { decode_json($t) } : {};
  exit 2 unless ref $d eq 'HASH';
  $d->{mcpServers} = {} unless ref $d->{mcpServers} eq 'HASH';
  if ($op eq 'set') { my $v = slurp($val); exit 1 unless defined $v; $d->{mcpServers}{jamsesh} = decode_json($v) } else { delete $d->{mcpServers}{jamsesh} }
  my $mode = defined $t ? ((stat $cfg)[2] & 07777) : 0600;
  my ($o, $tmp) = File::Temp::tempfile('.claude.jamsesh-XXXXXXXX', DIR => dirname($cfg));
  print $o $js->pretty->encode($d);
  close $o or exit 1;
  chmod $mode, $tmp;
  my $now = slurp($cfg);
  if ((defined $now ? sha256_hex($now) : '') eq (defined $t ? sha256_hex($t) : '')) { rename $tmp, $cfg or exit 1; exit 0 }
  unlink $tmp;
}
exit 1;
MCPKEY
}
CLAUDEJSON="$HOME/.claude.json"
committed=0
reason=""
mcp_touched=0
mcp_before=""
mcp_ours=""
CLAUDE=""
on_exit() {
  local rc=$? d real t cur before after bad="" foreign="" restored=1 mcp_result=none now
  trap - EXIT
  set +e
  [ "$committed" = 1 ] && exit "$rc"
  [ "$rc" = 0 ] && rc=1
  for d in "$J"/*/; do
    [ -d "$d" ] || continue
    real="$(cat "$d/path")"
    cur="$(sha "$real")"
    before="$(cat "$d/beforesha")"
    after="$(cat "$d/after" 2>/dev/null)"
    if [ "$cur" = "$before" ]; then
      continue
    elif [ -n "$after" ] && [ "$cur" = "$after" ]; then
      if [ -f "$d/before" ]; then
        t=""
        { t="$(mktemp "$real.XXXXXXXX")" && cp -p "$d/before" "$t" && mv -f "$t" "$real"; } || { rm -f "$t"; bad="$bad $real"; }
      else
        rm -f "$real" || bad="$bad $real"
      fi
    else
      foreign="$foreign $real"
    fi
  done
  if [ "$mcp_touched" = 1 ]; then
    # Read from the file itself, never from the CLI's exit status: the entry is put back only if it is
    # absent (setup removed it) or is the one setup registered; anything else is someone else's.
    now="$(mcp_key get "$CLAUDEJSON" 2>/dev/null)"
    if [ "$now" != "$mcp_before" ] && [ -n "$now" ] && [ "$now" != "$mcp_ours" ]; then
      mcp_result=foreign
    else
      if [ "$now" != "$mcp_before" ]; then
        if [ -n "$mcp_before" ]; then mcp_key set "$CLAUDEJSON" "$SAVED/mcp_before.json" 2>/dev/null; else mcp_key del "$CLAUDEJSON" 2>/dev/null; fi
      fi
      now="$(mcp_key get "$CLAUDEJSON" 2>/dev/null)"
      if [ "$now" = "$mcp_before" ]; then
        if [ -n "$mcp_before" ]; then mcp_result=restored; else mcp_result=removed; fi
      else
        mcp_result=failed
      fi
    fi
    case "$mcp_result" in foreign|failed) restored=0 ;; esac
  fi
  { [ -z "$bad" ] && [ -z "$foreign" ]; } || restored=0
  if [ "$restored" = 1 ]; then
    rm -rf "$SAVED"
    case "$reason" in
      hook) echo "JamSesh couldn't download its hook from $HUB, so nothing was changed. Try connecting again." >&2 ;;
      mcp) if [ "$mcp_result" = restored ]; then echo "JamSesh couldn't register its MCP server with Claude Code, so the earlier one was put back. Try connecting again." >&2; else echo "JamSesh couldn't register its MCP server with Claude Code, so none is registered. Try connecting again." >&2; fi ;;
      quiet) ;;
      *) echo "Setup didn't finish, so your earlier connection was put back. Try connecting again." ;;
    esac
  else
    [ -z "$bad" ] || echo "JamSesh couldn't put these files back:$bad (the earlier copies are in $SAVED)." >&2
    [ -z "$foreign" ] || echo "Changed by someone else while setup ran, so not put back:$foreign" >&2
    [ "$mcp_result" != foreign ] || echo "The jamsesh entry in $CLAUDEJSON was changed by someone else while setup ran, so it was left as it is." >&2
    [ "$mcp_result" != failed ] || echo "JamSesh couldn't put the jamsesh entry in $CLAUDEJSON back as it was (the earlier one is in $SAVED/mcp_before.json)." >&2
    echo "Setup didn't finish, and JamSesh couldn't put your earlier connection back completely." >&2
  fi
  exit "$rc"
}
trap on_exit EXIT
printf 'authorization: Bearer %s\n' "$TOKEN" | safe_write "$DIR/auth.header" 600
AUTH=(-H "@$DIR/auth.header")
# A value as one single-quoted shell word, so sourcing client.env (the jamsesh command does) runs
# nothing in it; the hook reads it as data.
q() { printf "'%s'" "$(printf '%s' "$1" | tr -d '\n\r' | sed "s/'/'\"'\"'/g")"; }
# Reads a value back without running the file (an older one held the name in double quotes).
conf() { sed -n "s/^$1=//p" "$DIR/client.env" 2>/dev/null | head -n 1 | sed -e "s/^[\"']//" -e "s/[\"']\$//" -e "s/'\"'\"'/'/g"; }
# The person is whoever the host already knows this computer as. The setup never adds a person:
# a guessed name only made duplicates.
NAME="$(curl -fsS --max-time 5 "${AUTH[@]}" "$HUB/api/me" 2>/dev/null | perl -MJSON::PP -0777 -ne 'my $m = eval { decode_json($_) }; print $m->{person}{name} // "" if ref $m eq "HASH" && ref $m->{person} eq "HASH"' || true)"
[ -n "$NAME" ] || NAME="${JAMSESH_NAME:-}"
if [ -z "$NAME" ] && [ -f "$DIR/client.env" ]; then NAME="$(conf JAMSESH_NAME)"; fi

{
  printf 'JAMSESH_HUB=%s\n' "$(q "$HUB")"
  printf 'JAMSESH_NAME=%s\n' "$(q "$NAME")"
  echo 'JAMSESH_ACTIVE=1'
} | safe_write "$DIR/client.env" 600
# The hook is fetched to a private temporary file and checked before it replaces the installed one, so
# a download cut short never leaves Claude Code's hooks running half a script.
hooktmp="$SAVED/hook.sh.new"
if fetch hook.sh "$hooktmp" && head -n 1 "$hooktmp" | grep -q '^#!/usr/bin/env bash' && bash -n "$hooktmp"; then
  safe_write "$DIR/hook.sh" 755 < "$hooktmp"
else
  reason=hook
  exit 1
fi

# Agent CLIs often aren't on PATH: the Claude desktop app keeps its own copy of Claude Code, and nvm
# and Volta keep theirs in their own folders. Prints the first one found, the newest copy first.
# JAMSESH_CLI_DIRS replaces the system-wide folders (tests point it somewhere empty).
find_cli() {
  local name="$1" c d
  c="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  for d in "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/.volta/bin" ${JAMSESH_CLI_DIRS-/opt/homebrew/bin /usr/local/bin}; do
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
# Says where the block an earlier JamSesh wrote into an instruction file is. Never changes the file.
note_block() { perl - "$1" <<'FIND'
use strict; use warnings; use Cwd qw(abs_path);
my ($path) = @ARGV;
exit 0 unless -f $path;
my $real = abs_path($path) // exit 0;
open(my $in, '<:raw', $real) or exit 0;
my $text = do { local $/; <$in> };
close $in;
my @blocks = ('<!-- jamsesh:start -->
## JamSesh

When your person says "connect to jamsesh", "join jamsesh", or "join the session", read
~/.codex/prompts/jamsesh.md and follow it: it connects you to the room session through the
`jamsesh` MCP tools. If those tools fail to connect, tell your person to open the JamSesh app and
host or join a session.

When the `jamsesh` tools are available and you start work in a repository, join the session first
(jam_join, jam_repo_card, jam_claim) unless you already did in this conversation. Codex has no hooks
here, so you are the room\'s only link to your person: post a one-line jam_update (progress) when
your person gives you a new task, check jam_inbox between steps, and when you are idle keep
calling jam_wait instead of ending your turn.
<!-- jamsesh:end -->', '<!-- jamsesh:start -->
## JamSesh

When your person says "connect to jamsesh", "join jamsesh", or "join the session", read
~/.codex/prompts/jamsesh.md and follow it: it connects you to the room session through the
`jamsesh` MCP tools. If those tools fail to connect, tell your person to open the JamSesh app and
host or join a session.
<!-- jamsesh:end -->');
my %found;
for my $old (@blocks) {
  for my $eol ("\r\n", "\n") {
    my $block = join($eol, split(/\n/, $old, -1));
    my $from = 0;
    while ((my $i = index($text, $block, $from)) >= 0) {
      my $j = $i + length $block;
      my $starts = $i == 0 || substr($text, $i - 1, 1) eq "\n";
      my $after = substr($text, $j, length $eol);
      if (!$starts || ($j < length $text && $after ne $eol)) { $from = $i + 1; next; }
      my $first = 1 + (() = substr($text, 0, $i) =~ /\n/g);
      $found{$first} = $first + (() = $block =~ /\n/g);
      $from = $j;
    }
  }
}
for my $first (sort { $a <=> $b } keys %found) {
  print STDERR "JamSesh: $path still has the block an earlier JamSesh wrote (lines $first-$found{$first}). JamSesh no longer changes this file, and until you delete those lines (from <!-- jamsesh:start --> to <!-- jamsesh:end -->) that block can still make a chat join the room by itself.\n";
}
FIND
}
configured=0

CLAUDE="$(find_cli claude || true)"
if [ -n "$CLAUDE" ]; then
  # claude mcp has no replace: the old entry has to go before the new one is added. So the old entry is
  # kept first and put back, key by key, if the new one can't be added. Nothing here puts a token on a
  # command line.
  cred="$DIR/mcp-headers.json"
  mcp_before="$(mcp_key get "$CLAUDEJSON" 2>/dev/null || true)"
  printf '%s' "$mcp_before" > "$SAVED/mcp_before.json"
  # Claude Code asks a helper for the credential header each time it connects, so the token is in
  # neither its arguments nor its config. Without a token the app's relay adds it.
  helper=""
  if [ -n "$TOKEN" ]; then
    printf '%s' "$TOKEN" | perl -MJSON::PP -0777 -ne 'print encode_json({ authorization => "Bearer $_" })' | safe_write "$cred" 600
    printf '#!/bin/sh\nexec cat %s\n' "$(q "$cred")" | safe_write "$DIR/mcp-headers.sh" 700
    helper="$DIR/mcp-headers.sh"
  fi
  new_mcp="$(JAMSESH_URL="$HUB/mcp" JAMSESH_HELPER="$helper" perl -MJSON::PP -e 'print JSON::PP->new->canonical->encode({ type => "http", url => $ENV{JAMSESH_URL}, ($ENV{JAMSESH_HELPER} ? (headersHelper => $ENV{JAMSESH_HELPER}) : ()) })')"
  mcp_touched=1
  "$CLAUDE" mcp remove jamsesh -s user >/dev/null 2>&1 || true
  if ! "$CLAUDE" mcp add-json -s user jamsesh "$new_mcp" >/dev/null; then reason=mcp; exit 1; fi
  mcp_ours="$(mcp_key get "$CLAUDEJSON" 2>/dev/null || true)"
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills/jamsesh"
  fetch launcher.md "$SAVED/launcher.md"
  safe_write "$HOME/.claude/skills/jamsesh/SKILL.md" 644 < "$SAVED/launcher.md"
  # JamSesh used to write a block into CLAUDE.md. It never does now, and says where the old one is.
  note_block "$HOME/.claude/CLAUDE.md"
  safe_write "$HOME/.claude/commands/jamsesh.md" 644 <<'CMD'
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
  perl - "$DIR/hook.sh" "$HOME/.claude/settings.json" > "$SAVED/settings.new" <<'PL'
use strict; use warnings; use JSON::PP; use Cwd qw(abs_path); use File::Temp (); use File::Basename ();
my ($hook, $path) = @ARGV;
# A symlinked settings file is edited at its target, and keeps its mode (it may hold secrets).
$path = abs_path($path) // $path if -l $path;
# The hook's path as one shell word: a home folder with spaces still runs it.
(my $cmd = $hook) =~ s/'/'\\''/g;
$cmd = "'$cmd'";
my $data = {};
if (-e $path) {
  open(my $in, '<', $path) or die "JamSesh: can't read $path: $!\n";
  my $text = do { local $/; <$in> };
  close $in;
  if ($text =~ /\S/) {
    $data = eval { JSON::PP->new->relaxed->decode($text) };
    die "JamSesh: $path isn't valid JSON, so it was left as it is. Fix it, then connect again.\n" unless ref $data eq 'HASH';
  }
}
$data->{hooks} = {} unless ref $data->{hooks} eq 'HASH';
my $hooks = $data->{hooks};
# Only JamSesh's own hook commands go: its hook script (~/.jamsesh/hook.sh, under any home, quoted or
# not) with one of its verbs, and nothing else. A person's own hook stays, even in the same group,
# and even if its path or arguments mention JamSesh.
sub ours {
  my ($h) = @_;
  return 0 unless ref $h eq 'HASH' && defined $h->{command} && !ref $h->{command};
  my $c = $h->{command};
  my $p = $c =~ /^'((?:[^']|'\\'')*)' (start|prompt|tool|stop|listen)\z/ ? $1 =~ s/'\\''/'/gr : $c =~ /^(\S+) (start|prompt|tool|stop|listen)\z/ ? $1 : '';
  return $p =~ m{(^|/)\.jamsesh/hook\.sh\z} ? 1 : 0;
}
sub without_ours {
  my @groups;
  for my $g (@_) {
    if (ref $g eq 'HASH' && ref $g->{hooks} eq 'ARRAY') {
      my @left = grep { !ours($_) } @{ $g->{hooks} };
      next unless @left;
      push @groups, @left == @{ $g->{hooks} } ? $g : { %$g, hooks => \@left };
    } else {
      push @groups, $g;
    }
  }
  return @groups;
}
# JamSesh no longer reminds every new session to join: take that hook out of earlier installs.
if (ref $hooks->{SessionStart} eq 'ARRAY') {
  my @kept = without_ours(@{ $hooks->{SessionStart} });
  if (@kept) { $hooks->{SessionStart} = \@kept } else { delete $hooks->{SessionStart} }
}
for my $pair (['UserPromptSubmit', 'prompt'], ['PostToolUse', 'tool'], ['Stop', 'stop']) {
  my ($event, $arg) = @$pair;
  my @kept = without_ours(ref $hooks->{$event} eq 'ARRAY' ? @{ $hooks->{$event} } : ());
  push @kept, { hooks => [{ type => 'command', command => "$cmd $arg", timeout => 15 }] };
  # An idle agent is woken by a background listener that holds until the room has something for it.
  push @kept, { hooks => [{ type => 'command', command => "$cmd listen", timeout => 3300, asyncRewake => JSON::PP::true }] } if $event eq 'Stop';
  $hooks->{$event} = \@kept;
}
print JSON::PP->new->pretty->canonical->encode($data);
PL
  safe_write "$HOME/.claude/settings.json" keep:600 < "$SAVED/settings.new"
  ok "Claude Code: MCP server, skill, /jamsesh command, hooks (a chat joins only when told to)"
  configured=$((configured + 1))
else
  skip "Claude Code isn't installed"
fi

if find_cli codex >/dev/null || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/prompts"
  # The token comes from the header file, not this process's arguments or environment.
  perl - "$HUB" "$DIR/auth.header" "$HOME/.codex/config.toml" > "$SAVED/config.new" <<'PL'
use strict; use warnings; use Cwd qw(abs_path); use File::Temp (); use File::Basename ();
my ($hub, $header, $path) = @ARGV;
# A symlinked config is edited at its target, so the link stays a link.
$path = abs_path($path) // $path if -l $path;
my $token = '';
if (open(my $h, '<', $header)) { ($token) = (<$h> // '') =~ /Bearer\s+(\S+)/; close $h; }
$token //= '';
my $text = '';
if (-e $path) {
  open(my $in, '<', $path) or die "JamSesh: can't read $path: $!\n";
  $text = do { local $/; <$in> };
  close $in;
}
# Where a line leaves us: inside a multi-line string (its opening quotes) or not (''). Comments and
# one-line strings are skipped, so quotes in a comment or a value never start a multi-line string.
sub scan {
  my ($line, $long) = @_;
  my ($i, $n) = (0, length $line);
  while ($i < $n) {
    if ($long) {
      my $j = index($line, $long, $i);
      return $long if $j < 0;
      ($i, $long) = ($j + 3, '');
      next;
    }
    my $c = substr($line, $i, 1);
    return '' if $c eq '#';
    my $three = substr($line, $i, 3);
    if ($three eq '"' x 3 || $three eq "'" x 3) { ($long, $i) = ($three, $i + 3); next; }
    if ($c eq '"') {
      for ($i++; $i < $n; $i++) { my $d = substr($line, $i, 1); if ($d eq '\\') { $i++; next } if ($d eq '"') { $i++; last } }
      next;
    }
    if ($c eq "'") { my $j = index($line, "'", $i + 1); $i = $j < 0 ? $n : $j + 1; next; }
    $i++;
  }
  return $long;
}
# Takes out JamSesh's own tables ([mcp_servers.jamsesh] and its subtables) by their header lines, so
# a "[" inside a value (an IPv6 address, a comment) or a multi-line string never ends a table early.
my ($kept, $ours, $long) = ('', 0, '');
for my $line (split /(?<=\n)/, $text) {
  if (!$long && $line =~ /^\s*\[\[?\s*([^\]\[#]+?)\s*\]\]?\s*(?:#.*)?\r?\n?\z/) {
    (my $name = $1) =~ s/\s*\.\s*/./g;
    $name =~ s/"([^"]*)"/$1/g;
    $ours = $name =~ /^mcp_servers\.jamsesh(\.|\z)/ ? 1 : 0;
  }
  $kept .= $line unless $ours;
  # Inside a multi-line string nothing is a header.
  $long = scan($line, $long);
}
$text = $kept;
$text =~ s/\s+\z//;
(my $url = "$hub/mcp") =~ s/(["\\])/\\$1/g;
(my $tok = $token) =~ s/(["\\])/\\$1/g;
$text .= ($text eq '' ? '' : "\n\n") . "[mcp_servers.jamsesh]\nurl = \"$url\"\ntool_timeout_sec = 600\ndefault_tools_approval_mode = \"approve\"\n\n[mcp_servers.jamsesh.http_headers]\nauthorization = \"Bearer $tok\"\n";
print $text;
PL
  safe_write "$HOME/.codex/config.toml" 600 < "$SAVED/config.new"
  mkdir -p "$HOME/.codex/skills/jamsesh"
  fetch launcher.md "$SAVED/codex-launcher.md"
  safe_write "$HOME/.codex/skills/jamsesh/SKILL.md" 644 < "$SAVED/codex-launcher.md"
  # The prompt is the full instructions, for when a person types /jamsesh in Codex.
  fetch skill.md "$SAVED/codex-prompt.md"
  printf '\n\nJoin now: call jam_join (harness codex, cwd this directory; add owner only if jam_join asks), post jam_repo_card, jam_claim your workstream, and when idle call jam_wait. Focus: $ARGUMENTS\n' >> "$SAVED/codex-prompt.md"
  safe_write "$HOME/.codex/prompts/jamsesh.md" 644 < "$SAVED/codex-prompt.md"
  # JamSesh used to write a block into AGENTS.md. It never does now, and says where the old one is.
  note_block "$HOME/.codex/AGENTS.md"
  ok "Codex: MCP server, skill, /jamsesh prompt (Codex has no hooks here; a chat joins only when told to)"
  configured=$((configured + 1))
else
  skip "Codex isn't installed"
fi
# Saying "done" when no agent was set up sent people off to restart agents that would never connect.
if [ "$configured" -eq 0 ]; then
  echo "Didn't find Claude Code or Codex on this computer, so no agent was connected. Install one (or open it once), then connect again." >&2
  reason=quiet
  exit 1
fi
# Every step worked: the saved copies are no longer needed.
committed=1
rm -rf "$SAVED"
echo "Done. Restart Claude Code or Codex (or run /mcp and reconnect jamsesh), then tell it: connect to jamsesh."
}
main "$@" </dev/null

