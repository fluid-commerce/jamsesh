#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: fix what's broken (confirmation)" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Confirm each finding in /tmp/claude-501/p1-review5.md is fixed" \
 --focus "The shippedBatch prompt change: does it reintroduce agents getting each other's news as tasks?" \
 --focus "Canvas reconnect, share lifecycle, and watchdog: any remaining way to crash, loop, or leak" > /tmp/claude-501/p1-review6.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review6.log
