cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "MCP rollback: does the reported result (removed, restored, failed) always match what mcp get shows, and are saved copies kept on failure?" \
 --focus "Hub client: is state ordered across overlapping HTTP fallbacks, socket states and reconnects, and is room-specific state reset?" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review12.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review13.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review13.log
