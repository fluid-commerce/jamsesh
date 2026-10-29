cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "Setup lock: flock on fd 9, exclusivity, release on every exit path, the race test" \
 --focus "MCP rollback: restore only by editing the one key in ~/.claude.json; any secret in argv; the file edit safe against concurrent writers and symlinks?" \
 --focus "Rollback temp files: any predictable path or symlink-following write left?" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review14.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review15.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review15.log
