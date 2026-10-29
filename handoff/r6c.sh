cd /Users/cheyrasmussen/jamsesh-p6/jamsesh/app/src-tauri
export CARGO_TARGET_DIR=/tmp/claude-501/p6-target
{
echo; echo "## ROUND 3 native verification (run by the orchestrator, $(date '+%H:%M'))"
perl -e 'alarm 1500; exec @ARGV' cargo clippy --all-targets -- -D warnings >/tmp/claude-501/p6-clippy.log 2>&1; echo "- cargo clippy --all-targets -D warnings (src-tauri): exit $? ($(grep -c '^error' /tmp/claude-501/p6-clippy.log) errors)"
perl -e 'alarm 1500; exec @ARGV' cargo test >/tmp/claude-501/p6-ctest.log 2>&1; echo "- cargo test (src-tauri): exit $? — $(grep '^test result' /tmp/claude-501/p6-ctest.log | tr '\n' ' ')"
swiftc -typecheck /Users/cheyrasmussen/jamsesh-p6/jamsesh/hub/native/jamsesh-live.swift >/tmp/claude-501/p6-swift.log 2>&1; echo "- swiftc -typecheck jamsesh-live.swift: exit $?"
echo "- No FigCraft crate changes in this phase, so cargo xtask ci is not applicable. ScreenCaptureKit/CGEvent behavior needs permission prompts and is on the office checklist."
} >> /tmp/claude-501/p6-context.md
rm -rf /tmp/claude-501/p6-target
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 6: driving and reviewing together" --diff jamsesh/phase-3...jamsesh/phase-6 --repo "$HOME/jamsesh-p6" --context @/tmp/claude-501/p6-context.md \
 --focus "Recording ownership and lifecycle: can one person stop, replace or read another's recording, and does a refused or racing Start keep the right recording?" \
 --focus "Mac input in tileinput.ts: can a button or key ever stay held down (lost up, cancel, capture loss, disconnect)?" \
 --focus "Font memory cap and lend tickets: can concurrent downloads or many callers exceed the caps?" \
 --focus "Build-driving reconnect: frame key refresh and reload. Stale keys or reload loops?" \
 --focus "Confirm each finding in /tmp/claude-501/p6-review2.md is fixed, and read the native verification results in the context" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p6-review3.log 2>&1
echo "exit $?" >> /tmp/claude-501/p6-review3.log
