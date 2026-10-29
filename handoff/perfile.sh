#!/bin/zsh
# usage: perfile.sh <repo jamsesh dir> <out file>
cd "$1" || exit 1
set -a; . ~/.claude/api-keys.env; set +a; export JAMSESH_SILENT=1
: > "$2"
for f in hub/test/*.test.ts; do
  out=$(perl -e 'alarm 180; exec @ARGV' bun test "$f" 2>&1); code=$?
  sum=$(print -r -- "$out" | /usr/bin/grep -E "^\s*[0-9]+ (pass|fail)" | tr '\n' ' ')
  fails=$(print -r -- "$out" | /usr/bin/grep -E "^\(fail\)" | cut -c1-140)
  if [ $code -eq 142 ]; then echo "TIMEOUT $f" >> "$2"; else echo "$f [$code] $sum" >> "$2"; fi
  [ -n "$fails" ] && print -r -- "$fails" | sed 's/^/    /' >> "$2"
  pkill -f "figcraft-server.*jamsesh-test" 2>/dev/null
done
echo DONE >> "$2"
