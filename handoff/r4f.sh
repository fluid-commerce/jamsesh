cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 4: Tasks board and brain judgement" --diff jamsesh/phase-3...jamsesh/phase-4 --repo "$HOME/jamsesh-p4" --context @/tmp/claude-501/p4-context.md \
 --focus "Structural file gate: with an attachment, is there any path (tool, execution wrapper, offline fallback, no-words or unreadable files) by which a consequential action happens without a person accepting a card?" \
 --focus "SQLite carry-over (carryover.ts): can overlapping sessions, the same item changed twice, a paused or killed writer, or a large accepted set lose or resurrect accepted context?" \
 --focus "Veto provenance on Tasks cards and the renews card: can a veto be erased or a vetoed ask revived without a person deciding?" \
 --focus "Loopback attachment reads with a paired token: does honouring the token on that route open anything else?" \
 --focus "Confirm each finding in /tmp/claude-501/p4-review5.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p4-review6.log 2>&1
echo "exit $?" >> /tmp/claude-501/p4-review6.log
