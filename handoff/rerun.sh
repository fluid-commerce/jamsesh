#!/bin/bash
cd ~/jamsesh-final/jamsesh
H=$(mktemp -d); mkdir -p $H/models; cp ~/.jamsesh/models/*.onnx $H/models/
out=/tmp/claude-501/rerun-results.txt; : > $out
res=$(env -u JAMSESH_OFFLINE bash -c "set -a; . ~/.claude/api-keys.env; set +a; export JAMSESH_SILENT=1 JAMSESH_HOME=$H JAMSESH_DATA=$H/data JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp; perl -e 'alarm 900; exec @ARGV' bun test hub/test/brain.scenarios.test.ts 2>&1"); echo "brain.scenarios exit=$? $(echo "$res" | /usr/bin/grep -Eo '^ *[0-9]+ (pass|fail|skip)' | tr '\n' ' ') $(echo "$res" | /usr/bin/grep -Eo 'Ran .*')" >> $out
echo "$res" > /tmp/claude-501/rerun-brain.scenarios.log
rm -rf $H/data; H2=$(mktemp -d); mkdir -p $H2/models; cp $H/models/*.onnx $H2/models/
res=$(JAMSESH_SILENT=1 JAMSESH_OFFLINE=1 JAMSESH_HOME=$H2 JAMSESH_DATA=$H2/data JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp perl -e 'alarm 600; exec @ARGV' bun test hub/test/audio.bench.test.ts 2>&1); echo "audio.bench exit=$? $(echo "$res" | /usr/bin/grep -Eo '^ *[0-9]+ (pass|fail|skip)' | tr '\n' ' ') $(echo "$res" | /usr/bin/grep -Eo 'Ran .*')" >> $out
echo "$res" > /tmp/claude-501/rerun-audio.bench.log
rm -rf $H $H2
echo DONE >> $out
