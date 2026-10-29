#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 3: the big screen" --diff jamsesh/phase-2...jamsesh/phase-3 --repo "$HOME/jamsesh-p3" --context @/tmp/claude-501/p3-context.md \
 --focus "Authorization on every new route (stage lock/unlock/restore/ready/show-requests/expand, /renders/full, /api/projects, /api/screens/config): can an agent or another person's device act as someone else?" \
 --focus "Project migration and switching: any path that loses, moves, or corrupts existing session data in ~/.jamsesh; lobby and hub swap races" \
 --focus "Lock semantics: can the room get stuck with a lock nobody can clear, or can agents/brain bypass a lock? Per-screen correctness" \
 --focus "Tauri screens.rs and main.rs: placement math, display hot-plug, crash paths" \
 --focus "Confirm each finding in /tmp/claude-501/p3-review3.md is fixed" --focus "Test quality and what to delete" > /tmp/claude-501/p3-review4.log 2>&1
echo "exit $?" >> /tmp/claude-501/p3-review4.log
