#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 4: triage, tasks, memory" --diff jamsesh/phase-3...jamsesh/phase-4 --repo "$HOME/jamsesh-p4" --context @/tmp/claude-501/p4-context.md \
 --focus "Attachments: upload and fetch authorization, content sniffing, path safety, size limits, and prompt injection from attached text into the brain" \
 --focus "Triage routing: can overheard talk still create agent work without approval, or can direct requests get stuck on the board? Card action races and authorization" \
 --focus "Curation hold and carry-over: data loss, facts silently retired, context.json corruption across sessions" \
 --focus "Test quality and what to delete" > /tmp/claude-501/p4-review.log 2>&1
echo "exit $?" >> /tmp/claude-501/p4-review.log
