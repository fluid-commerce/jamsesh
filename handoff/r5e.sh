cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 5: hearing the room" --diff jamsesh/phase-3...jamsesh/phase-5 --repo "$HOME/jamsesh-p5" --context @/tmp/claude-501/p5-context.md \
 --focus "Who a browser may become (becomePerson in http.ts, /paired/:id/allow, DELETE /people): can any browser, agent or loopback process read or write another person's voiceprint, after revoke, re-pair or with a roster person?" \
 --focus "Per-host consent on the Mac app: answers keyed by an Ed25519 key the host proves over a fresh nonce (/api/host-proof, voice_host, verify_host). Can a replacement or impersonating host still get a voiceprint? Judge the disputed relay limit." \
 --focus "Reset: one gate in Store.addVoiceSample by heardAt, reset generations, sealed copies (provenance/seal). Can any path (in-flight audio, held candidates, old events, carried copies, clock skew) restore a reset voiceprint?" \
 --focus "Dedupe needs the same sound (contour correlation plus GCC-PHAT coherence); web sync waits for acknowledged registration and retries; stale-copy deletion failure surfaces; Parakeet manifest and Whisper bad-model paths" \
 --focus "Confirm each finding in /tmp/claude-501/p5-review4.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p5-review5.log 2>&1
echo "exit $?" >> /tmp/claude-501/p5-review5.log
