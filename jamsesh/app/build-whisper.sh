#!/usr/bin/env bash
# Builds whisper.cpp's whisper-server for the Mac app: one self-contained arm64 binary with Metal
# (the shader library embedded, ggml linked statically), so it runs from the app bundle.
# Usage: app/build-whisper.sh <output dir>. whisper.cpp is MIT (see NOTICE).
set -euo pipefail
OUT="${1:?output dir}"
TAG=v1.8.4
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF >/dev/null
cmake --build "$WORK/build" --target whisper-server -j >/dev/null
mkdir -p "$OUT"
cp "$WORK/build/bin/whisper-server" "$OUT/whisper-server"
# Only system libraries may be linked, or it won't run from inside the app.
if otool -L "$OUT/whisper-server" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/)'; then
  echo "whisper-server links a library outside the system" >&2
  exit 1
fi
echo "whisper-server $TAG -> $OUT/whisper-server"
