cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 3: the big screen" --diff jamsesh/phase-2...jamsesh/phase-3 --repo "$HOME/jamsesh-p3" --context @/tmp/claude-501/p3-context.md \
 --focus "Lock consent: Session.releaseLock is meant to be the only deliberate unlock. Is there any path (HTTP, brain tools, ruleRoute, show requests, overrides, MCP) that clears or replaces a person's lock without the owner, the host window rule, or a timely answer to the lock question?" \
 --focus "Transitions in app/src-tauri/src/main.rs: Turns tickets, may_start, final_stop. Can a stale or queued request (host, join, project switch, resume, leave) act on a session that changed, can Reopen or any exit skip the acknowledged save, and can a failed Reopen leave the app stuck?" \
 --focus "Migration lock: does the SQLite exclusive-transaction lock on projects/.migration-lock.db guarantee one migration at a time across processes and crashes, and are the tests real?" \
 --focus "Screen targets and tile keys: can an explicit unknown screen ever reach main; do windows only use the hub's stageTiles keys?" \
 --focus "Confirm each finding in /tmp/claude-501/p3-review5.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p3-review6.log 2>&1
echo "exit $?" >> /tmp/claude-501/p3-review6.log
