cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 4: Tasks board and brain judgement" --diff jamsesh/phase-3...jamsesh/phase-4 --repo "$HOME/jamsesh-p4" --context @/tmp/claude-501/p4-context.md \
 --focus "Lossless export and recovery (rows with tombstones and versions, importJson, readProjectContext recovering before seeding): can recovery lose or revive anything, or seeding start empty with a valid export?" \
 --focus "Per-row save results (applied vs superseded, carryBase, the superseded pull-in and Tasks card): can an accepted edit be lost, retried forever, or wrongly marked saved?" \
 --focus "Export failure handling and retry, and Send/Merge checks on the Tasks board (unavailable targets, kind/workstream/platform)" \
 --focus "Confirm each finding in /tmp/claude-501/p4-review7.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p4-review8.log 2>&1
echo "exit $?" >> /tmp/claude-501/p4-review8.log
