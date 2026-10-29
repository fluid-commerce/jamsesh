cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 7: the project wiki" --diff jamsesh/phase-4...jamsesh/phase-7 --repo "$HOME/jamsesh-p7" --context @/tmp/claude-501/p7-context.md \
 --focus "Path validation and the project root: can any page name, source, or symlink write outside the vault? Judge the disputed child-folder swap race (no openat in Bun): real risk given who can write the folder?" \
 --focus "Proposal and card recovery after a crash at any write point: lost proposals, orphan cards, double accepts?" \
 --focus "Durable tracking: agent-report replay cursor, log replay, transcript parts with offsets, damaged state file. Lost or duplicated ingest?" \
 --focus "Unaccepted proposal content must not reach agents or the stage. Any leak left?" \
 --focus "Confirm each finding in /tmp/claude-501/p7-review3.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p7-review4.log 2>&1
echo "exit $?" >> /tmp/claude-501/p7-review4.log
