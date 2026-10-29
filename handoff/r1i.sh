cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: coordination" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Canvas child and parent-death watcher: can a canvas or MCP child outlive Stop, a failed handshake, or a dead hub? Does keeping stdin open change any shutdown path?" \
 --focus "Relay caps (1000 frames, 8 MB, 10 s open, close 1013): unbounded growth or a stuck socket left?" \
 --focus "Parity: parityCandidate's fix-word filter and coordinate directives quoting the shipper's seen text. Can parity still issue build work or close a task early? Judge the disputed recipient-scoping finding." \
 --focus "Confirm each finding in /tmp/claude-501/p1-review8.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p1-review9.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review9.log
