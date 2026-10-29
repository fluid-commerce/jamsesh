cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "MCP rollback: is the old entry and credential always restored on failure, and does no token ever reach argv or a leftover file?" \
 --focus "Setup no longer edits CLAUDE.md or AGENTS.md and only prints the old block's line numbers. Is that safe and clear enough, and is anything still written to those files?" \
 --focus "Room switch: roomId, purge ids, and the RoomFeed key. Can a feed still show another room's lines?" \
 --focus "Codex config.toml edited through a symlink, including a dangling one: any clobbering or escape?" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review9.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review10.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review10.log
