cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: coordination" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Explicit-only directive linkage: jam_message/jam_ask/jam_answer carry directiveId, exchangeGap per counterpart. Any path where an unlinked or wrong-party message counts, or a valid exchange cannot be recorded?" \
 --focus "Shutdown: stopHelper boolean contract, Canvas.stop/Hub.stop/shutdown, FigcraftMcp.close. Can anything report reaped without an observed exit, or hang shutdown?" \
 --focus "Relay empty-frame accounting test and Upstream held/cap logic; anything left dead or unused from earlier rounds." \
 --focus "Confirm each finding in /tmp/claude-501/p1-review12.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p1-review13.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review13.log
