#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 5: hearing the room" --diff jamsesh/phase-3...jamsesh/phase-5 --repo "$HOME/jamsesh-p5" --context @/tmp/claude-501/p5-context.md \
 --focus "Model and binary download/bundling: integrity checks, partial files, disk use, process lifetime of whisper-server and the Parakeet child" \
 --focus "Voiceprint privacy and authorization: can anyone read, push, or delete someone else's voiceprint; is consent honoured; is any audio stored" \
 --focus "Correction pass and dedupe: false rewrites, lost lines, and labels assigned to the wrong person" \
 --focus "QR join and discovery: injection via scanned codes, URL handling" \
 --focus "Test quality and what to delete" > /tmp/claude-501/p5-review.log 2>&1
echo "exit $?" >> /tmp/claude-501/p5-review.log
