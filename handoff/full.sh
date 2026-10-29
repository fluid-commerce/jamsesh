#!/bin/bash
cd ~/jamsesh-final/jamsesh
LIVE=" brain.affinity brain.curate brain.scenarios brain.speech triage-board.live wiki.live attachments.live "
out=/tmp/claude-501/final-results.txt; : > $out
for f in $(ls hub/test/*.test.ts | /usr/bin/grep -v audio.bench) hub/test/audio.bench.test.ts; do
  b=$(basename $f .test.ts); lim=240; [ $b = audio.bench ] && lim=600
  H=$(mktemp -d)
  if [[ "$LIVE" == *" $b "* ]]; then
    mode=live
    res=$(env -u JAMSESH_OFFLINE bash -c "set -a; . ~/.claude/api-keys.env; set +a; export JAMSESH_SILENT=1 JAMSESH_HOME=$H JAMSESH_DATA=$H/data JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp; perl -e 'alarm $lim; exec @ARGV' bun test $f 2>&1"); code=$?
  else
    mode=offline
    res=$(JAMSESH_SILENT=1 JAMSESH_OFFLINE=1 JAMSESH_HOME=$H JAMSESH_DATA=$H/data JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp perl -e "alarm $lim; exec @ARGV" bun test $f 2>&1); code=$?
  fi
  p=$(echo "$res" | /usr/bin/grep -Eo '^ *[0-9]+ pass' | /usr/bin/grep -Eo '[0-9]+'); fl=$(echo "$res" | /usr/bin/grep -Eo '^ *[0-9]+ fail' | /usr/bin/grep -Eo '[0-9]+'); sk=$(echo "$res" | /usr/bin/grep -Eo '^ *[0-9]+ skip' | /usr/bin/grep -Eo '[0-9]+'); t=$(echo "$res" | /usr/bin/grep -Eo 'Ran .*\[[0-9.]+m?s\]' | /usr/bin/grep -Eo '\[[0-9.]+m?s\]')
  echo "$b|$mode|$code|${p:-0}|${fl:-0}|${sk:-0}|$t" >> $out
  if [ "$code" != 0 ]; then echo "$res" > /tmp/claude-501/fail-$b.log; fi
  rm -rf "$H"
done
echo DONE >> $out
