cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "Setup rollback: are auth.header, client.env and hook.sh restored after a failed hook download and a refused MCP entry, and is anything leaked or left behind?" \
 --focus "Mac app Connect my agents: is the old-instructions notice shown on success, clearly?" \
 --focus "Hub client state adoption: do the socket and HTTP paths both reset room data on a room change?" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review10.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review11.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review11.log
