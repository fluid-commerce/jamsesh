cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 7: the project wiki" --diff jamsesh/phase-4...jamsesh/phase-7 --repo "$HOME/jamsesh-p7" --context @/tmp/claude-501/p7-context.md \
 --focus "Hand edits in the vault (syncVault, markSeen, first look, reconcile order): lost, duplicated or wrongly filed edits? Bytes-hash proof of a write: any hole?" \
 --focus "Shutdown closing (503 gate, brain and transcriber stopped): can anything still arrive after the final capture? Graph edge cap and index link cap; state range checks." \
 --focus "State validation (readState) and durable cursors: agent-report event-named sources, replay, damaged state. Anything still malformed that passes?" \
 --focus "Full-size stage graph (grid name room, name budget, startup time budget, memoized graph): correct and actually bounded?" \
 --focus "Confirm each finding in /tmp/claude-501/p7-review7.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p7-review8.log 2>&1
echo "exit $?" >> /tmp/claude-501/p7-review8.log
