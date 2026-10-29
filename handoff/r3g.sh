cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 3: the big screen" --diff jamsesh/phase-2...jamsesh/phase-3 --repo "$HOME/jamsesh-p3" --context @/tmp/claude-501/p3-context.md \
 --focus "Questions and consent: can one spoken answer settle more than one show request or lock question, or settle one when several are open for that person (Session.openQuestionsFor, releaseLock, decideByVoice, unlock_screen)?" \
 --focus "Late writes to the stage: does setStage's ifRev compare-and-set cover every delayed or async path (share placement and others), so nothing decided earlier lands on a newer stage or lock?" \
 --focus "Screen names: screenMatch (exact id, exact name, unique whole-word prefix); can a stale or ambiguous reference reach a screen it didn't mean?" \
 --focus "Migration snapshot via VACUUM INTO on a read-only connection: consistent with a live writer, originals untouched?" \
 --focus "App: Turns::lock_quiet for screen arrangement and closed screens, quit_for tickets for Reopen, Turns::unsaved blocking restarts. Can anything still act on the wrong session or restart over a failed save?" \
 --focus "Confirm each finding in /tmp/claude-501/p3-review6.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p3-review7.log 2>&1
echo "exit $?" >> /tmp/claude-501/p3-review7.log
