cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 4: Tasks board and brain judgement" --diff jamsesh/phase-3...jamsesh/phase-4 --repo "$HOME/jamsesh-p4" --context @/tmp/claude-501/p4-context.md \
 --focus "withFiles: is there any route into a brain pass, rule fallback or voice decision where a line with files can act without a person accepting a card?" \
 --focus "Versioned carry-over merge (carryover.ts apply, snapshotContext, carryBase): can any order of overlapping saves, restatement, or same-millisecond change lose an accepted fact or revive a retired one?" \
 --focus "Export and recovery: can context.json ever show uncommitted or out-of-order state, and is generation-based recovery safe when several processes find damage at once?" \
 --focus "Attachment reads: credentials only from header or cookie, no-store; anything else opened?" \
 --focus "Confirm each finding in /tmp/claude-501/p4-review6.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p4-review7.log 2>&1
echo "exit $?" >> /tmp/claude-501/p4-review7.log
