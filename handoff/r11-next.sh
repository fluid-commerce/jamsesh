cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: coordination" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Relay accounting: Upstream.send held bytes with FRAME_OVERHEAD, partial writes and drain, pre-open queue, close codes in both directions. Can any frame pattern still grow memory?" \
 --focus "Directive exchange guard: Directive.counterparts, directiveId on messages/asks/answers/inherited replies, no window, target-only and terminal state in setDirectiveFor. Any way to close early, strand, reopen or let a non-target act?" \
 --focus "Fonts: the incomplete/deferred lists from the Mac (fonts.rs) and FontTries.partial in the page: can a family be silently settled with missing faces or retried forever?" \
 --focus "Confirm each finding in /tmp/claude-501/p1-review10.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p1-review11.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review11.log
