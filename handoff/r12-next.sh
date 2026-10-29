cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: coordination" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Inbox (Store.messagesTo, oldest-50 paging) and jam_answer (addressee-only, lookup by id, already-answered): can a message be lost, skipped, or answered by the wrong agent?" \
 --focus "Directive exchange guard per counterpart and thread-end inheritance in sendMessage; terminal state and target-only checks. Any way to close early or link the wrong messages?" \
 --focus "Fonts: FontTries.partial re-asking, backoff and the substitute list; feed trimming in RoomFeed (FEED_KEEP, trimmed ref, history reload); shutdown reaping via Canvas.stop/Hub.stop; empty relay sends." \
 --focus "Confirm each finding in /tmp/claude-501/p1-review11.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p1-review12.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review12.log
