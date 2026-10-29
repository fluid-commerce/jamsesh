#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 6: driving and reviewing" --diff jamsesh/phase-3...jamsesh/phase-6 --repo "$HOME/jamsesh-p6" --context @/tmp/claude-501/p6-context.md \
 --focus "Input injection security: devdrive.ts in proxied builds (origin checks, CSP), websocket drive events, CGEvent/idb input. Can a non-driver, agent, or web page inject input?" \
 --focus "Native helper and child processes: compile-on-first-use Swift, permission handling, process lifetime, untrusted arguments" \
 --focus "Fonts: licence handling, lend consent enforcement, memory caps, never written to disk" \
 --focus "FigCraft Rust changes: rule compliance, command design, wasm" \
 --focus "Confirm each finding in /tmp/claude-501/p6-review.md is fixed" --focus "Test quality and what to delete" > /tmp/claude-501/p6-review2.log 2>&1
echo "exit $?" >> /tmp/claude-501/p6-review2.log
