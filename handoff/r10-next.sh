cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 1: coordination" --diff main...jamsesh/phase-1 --repo "$HOME/jamsesh-p1" --context @/tmp/claude-501/p1-context.md \
 --focus "Child shutdown: the sh wrapper's TERM then KILL grace, Stop reaping the server/host/key helper, hub death with TERM-resistant children. Anything left running?" \
 --focus "New hub/src/relay.ts upstream client (handshake, masked framing, fragmentation, ping, write/drain accounting) and relayUp/relayDown in http.ts: can a stalled peer in either direction still grow memory, or can valid canvas traffic break?" \
 --focus "Parity completion: coordinate directives close only through jam_ack after an exchange (Session.exchangeGap); font transfer now sends every file per family with a deferred list. Any way to close early, strand a directive, or lose faces?" \
 --focus "Confirm each finding in /tmp/claude-501/p1-review9.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p1-review10.log 2>&1
echo "exit $?" >> /tmp/claude-501/p1-review10.log
