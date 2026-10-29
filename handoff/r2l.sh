cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "Setup transaction: is every file and the MCP entry restored on any failure after the first change, are failed restores reported, and is anything leaked or left behind?" \
 --focus "Hub client: are stale HTTP /state answers dropped and room-specific state cleared on a room change?" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review11.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review12.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review12.log
