cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "Setup lock: exclusive, stale recovery, released on every exit path; and the Mac app refusing a second run" \
 --focus "MCP rollback secrets: can any secret reach a command argument, and is the direct ~/.claude.json restore safe?" \
 --focus "Hub client: do all socket changes order the HTTP fallback?" \
 --focus "devproxy re-registration and failed bind" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review13.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review14.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review14.log
