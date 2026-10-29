#!/usr/bin/env bash
# Every JamSesh test suite: the hub and the web app (bun), and the Mac app (cargo). First it says which
# hub tests will skip on this machine and why, so a green run without them isn't mistaken for full cover.
#   scripts/test-all.sh               all three
#   scripts/test-all.sh web tauri     just those
set -uo pipefail
cd "$(dirname "$0")/.."
parts="${*:-hub web tauri}"
models="${JAMSESH_HOME:-$HOME/.jamsesh}/models"

skips=()
[ -x /usr/bin/say ] || skips+=("No macOS voices (/usr/bin/say): the simulated rooms in hub/test/voices.test.ts (speaker labels, the join read, one line per utterance) skip.")
[ -f "$models/wespeaker_en.onnx" ] || skips+=("No speaker model ($models/wespeaker_en.onnx): those rooms skip too, and audio-fixes' relabel check passes without checking. dedupe.test.ts covers merging without it.")
[ -n "${JAMSESH_TEST_PARAKEET_DIR:-}" ] || skips+=("JAMSESH_TEST_PARAKEET_DIR isn't set: the end-to-end Parakeet test in transcription.test.ts skips.")
command -v cargo >/dev/null || skips+=("No cargo: the Mac app's tests can't run.")
echo "What skips on this machine:"
if [ ${#skips[@]} -eq 0 ]; then echo "  nothing"; else printf '  %s\n' "${skips[@]}"; fi

failed=()
for part in $parts; do
  echo
  echo "== $part"
  case "$part" in
    hub) JAMSESH_SILENT=1 bun test hub || failed+=(hub) ;;
    web) (cd web && bun test) || failed+=(web) ;;
    tauri) (cd app/src-tauri && cargo test) || failed+=(tauri) ;;
    *) echo "Unknown suite: $part (hub, web or tauri)" >&2; failed+=("$part") ;;
  esac
done
echo
if [ ${#failed[@]} -eq 0 ]; then echo "All passed: $parts"; else echo "Failed: ${failed[*]}" >&2; exit 1; fi
