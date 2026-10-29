#!/usr/bin/env bash
# Puts everything the hub needs into app/resources/, which the Mac app bundles. After this, a Mac
# hosts with the app alone: no checkout, Bun, or install script.
#   Needs, once on the build machine: jamsesh/install.sh (FigCraft binaries, canvas, models).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/app/resources"
JAM="${JAMSESH_HOME:-$HOME/.jamsesh}"
rm -rf "$OUT" && mkdir -p "$OUT"/{hub,bin,skill,models,node_modules}

(cd hub && bun build --compile src/index.ts src/pdfworker.ts --outfile "$OUT/hub/jamsesh-hub" >/dev/null)
(cd web && bunx vite build >/dev/null) && cp -R web/dist "$OUT/web"
cp -R "$JAM/web-canvas" "$OUT/canvas"
cp skill/SKILL.md "$OUT/skill/"
# whisper.cpp's server (MIT, see NOTICE), built once into the same folder as the FigCraft binaries.
# Only the pinned whisper-server build ships: a binary that isn't it (no stamp, another commit, changed
# since) is rebuilt, and the bundle stops if even that isn't it.
app/build-whisper.sh --check "$JAM/bin" || app/build-whisper.sh "$JAM/bin"
app/build-whisper.sh --check "$JAM/bin" || { echo "whisper-server in $JAM/bin isn't the pinned build" >&2; exit 1; }
for b in figcraft-server figcraft-cli whisper-server; do cp "$JAM/bin/$b" "$OUT/bin/"; done
cp -R node_modules/sherpa-onnx-node "node_modules/sherpa-onnx-darwin-$(uname -m | sed 's/x86_64/x64/')" "$OUT/node_modules/"
# The speaker model ships only as the pinned file (the same pin as install.sh).
WESPEAKER_SHA256=e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012
if [ "$(shasum -a 256 "$JAM/models/wespeaker_en.onnx" 2>/dev/null | cut -d' ' -f1)" != "$WESPEAKER_SHA256" ]; then
  echo "$JAM/models/wespeaker_en.onnx isn't the pinned speaker model; run install.sh to fetch it" >&2
  exit 1
fi
cp "$JAM/models/wespeaker_en.onnx" "$OUT/models/"
du -sh "$OUT" | awk '{print "Hub bundle: " $1}'
