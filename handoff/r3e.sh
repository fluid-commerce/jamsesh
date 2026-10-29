cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 3: the big screen" --diff jamsesh/phase-2...jamsesh/phase-3 --repo "$HOME/jamsesh-p3" --context @/tmp/claude-501/p3-context.md \
 --focus "Lock consent: can consent to replace a locked screen ever be inferred without the ask_to_replace_screen question being delivered, or from someone other than the owner?" \
 --focus "Quit and project switches: is every transition serialized through save completion, and can anything queued behind Quit still run?" \
 --focus "Migration retry via migratedFrom: can a crash at any point duplicate, strand, or overwrite a session, or touch the originals in ~/.jamsesh?" \
 --focus "Confirm each finding in /tmp/claude-501/p3-review4.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p3-review5.log 2>&1
echo "exit $?" >> /tmp/claude-501/p3-review5.log
