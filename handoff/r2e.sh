#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 2: agents join on purpose" --diff jamsesh/phase-1...jamsesh/phase-2 --repo "$HOME/jamsesh-p2" --context @/tmp/claude-501/p2-context.md \
 --focus "Security of the hook scripts and new hook routes (/api/hooks/joined, /tool, /listen): can an unjoined or foreign chat read or consume another agent's room items, or impersonate a person? Is chat id spoofable in a way that matters?" \
 --focus "STRIP_BLOCK_PL: can it ever damage a user's CLAUDE.md or AGENTS.md beyond JamSesh's own block?" \
 --focus "Duplicate or lost delivery across PostToolUse, the Stop listener, jam_inbox, and jam_wait; the old-install fallback path" \
 --focus "Remove with purge: does it delete only that agent's content? Reassign and aging timers: races and repeated nudges" \
 --focus "Confirm each finding in /tmp/claude-501/p2-review4.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p2-review5.log 2>&1
echo "exit $?" >> /tmp/claude-501/p2-review5.log
