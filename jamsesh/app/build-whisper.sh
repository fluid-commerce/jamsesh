#!/usr/bin/env bash
# Builds whisper.cpp's whisper-server for the Mac app: one self-contained arm64 binary with Metal
# (the shader library embedded, ggml linked statically), so it runs from the app bundle.
# Usage: app/build-whisper.sh <output dir>          builds it, with a build stamp beside it
#        app/build-whisper.sh --check <output dir>  says whether the binary there is this pinned build
# whisper.cpp is MIT (see NOTICE).
#
# The stamp (whisper-server.build) records the commit it was built from and the binary's SHA-256. A
# binary without a stamp, from another commit, or changed since it was built is not this build.
set -euo pipefail
TAG=v1.8.4
# The commit that tag named when it was pinned: a tag can be moved, a commit can't.
COMMIT=9386f239401074690479731c1e41683fbbeac557

if [ "${1:-}" = "--check" ]; then
  OUT="${2:?output dir}"
  BIN="$OUT/whisper-server"
  STAMP="$OUT/whisper-server.build"
  [ -x "$BIN" ] && [ -f "$STAMP" ] || exit 1
  [ "$(sed -n 's/^commit=//p' "$STAMP")" = "$COMMIT" ] || exit 1
  [ "$(sed -n 's/^sha256=//p' "$STAMP")" = "$(shasum -a 256 "$BIN" | cut -d' ' -f1)" ] || exit 1
  exit 0
fi

OUT="${1:?output dir}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$WORK/src"
if [ "$(git -C "$WORK/src" rev-parse HEAD)" != "$COMMIT" ]; then
  echo "whisper.cpp $TAG is no longer commit $COMMIT; check the new commit before pinning it" >&2
  exit 1
fi
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
printf 'tag=%s\ncommit=%s\nsha256=%s\n' "$TAG" "$COMMIT" "$(shasum -a 256 "$OUT/whisper-server" | cut -d' ' -f1)" >"$OUT/whisper-server.build"
echo "whisper-server $TAG -> $OUT/whisper-server"
