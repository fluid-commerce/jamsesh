cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 4: Tasks board and brain judgement" --diff jamsesh/phase-3...jamsesh/phase-4 --repo "$HOME/jamsesh-p4" --context @/tmp/claude-501/p4-context.md \
 --focus "Attachment action gate: can an explanatory or question request with a file still create work? Can an unpaired local process read attachments?" \
 --focus "Curation and Replace: can a fact be retired or replaced across kind, workstream or platform, or written without the hold?" \
 --focus "Context lock (owner pid plus token) and carry-over: can two writers both hold it, or can accepted context be lost on shutdown or a failed save?" \
 --focus "The overruled-card fix for 'same ask from two people': can a cleared overruled mark revive a card the room really rejected?" \
 --focus "Confirm each finding in /tmp/claude-501/p4-review4.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p4-review5.log 2>&1
echo "exit $?" >> /tmp/claude-501/p4-review5.log
