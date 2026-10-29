cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 7: the project wiki" --diff jamsesh/phase-4...jamsesh/phase-7 --repo "$HOME/jamsesh-p7" --context @/tmp/claude-501/p7-context.md \
 --focus "Approval integrity: can a card ever ask a person to approve text it can't show? Partial accept, retry with changed selections, dismissal, restart: is every written page always logged and indexed?" \
 --focus "Unhandled model output (unseen existing pages, the need list, again): any loop, lost update, or source marked read too early? Archive of old sources: citations, held and part-read sources, the cap." \
 --focus "State validation (readState) and durable cursors: agent-report event-named sources, replay, damaged state. Anything still malformed that passes?" \
 --focus "Full-size stage graph (grid name room, name budget, startup time budget, memoized graph): correct and actually bounded?" \
 --focus "Confirm each finding in /tmp/claude-501/p7-review4.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p7-review5.log 2>&1
echo "exit $?" >> /tmp/claude-501/p7-review5.log
