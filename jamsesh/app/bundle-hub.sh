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

(cd hub && bun build --compile src/index.ts --outfile "$OUT/hub/jamsesh-hub" >/dev/null)
(cd web && bunx vite build >/dev/null) && cp -R web/dist "$OUT/web"
cp -R "$JAM/web-canvas" "$OUT/canvas"
cp skill/SKILL.md "$OUT/skill/"
for b in figcraft-server figcraft-cli; do cp "$JAM/bin/$b" "$OUT/bin/"; done
cp -R node_modules/sherpa-onnx-node "node_modules/sherpa-onnx-darwin-$(uname -m | sed 's/x86_64/x64/')" "$OUT/node_modules/"
cp "$JAM/models/wespeaker_en.onnx" "$OUT/models/"
du -sh "$OUT" | awk '{print "Hub bundle: " $1}'
