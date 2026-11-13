#!/usr/bin/env bash
# Builds transcribe.cpp's shared library for Parakeet (hub/src/audio/stt-server.ts): arm64 with Metal
# (the shader library embedded), from Hex's fork, which adds Parakeet vocabulary rescoring to
# transcribe.cpp 0.4.1 with the same C ABI (header hash), so the transcribe-cpp@0.4.1 binding loads
# it in place of its prebuilt library (TRANSCRIBE_LIBRARY).
# Usage: app/build-transcribe.sh <output dir>          builds it, with a build stamp beside it
#        app/build-transcribe.sh --check <output dir>  says whether the library there is this pinned build
# transcribe.cpp and the fork are MIT (see NOTICE).
#
# The stamp (transcribe.build) records the commit and each library's SHA-256. Like build-whisper.sh's,
# --check only tells a dev install (install.sh) whether to rebuild; bundle-hub.sh always builds.
set -euo pipefail
REPO=https://github.com/anomalyco/transcribe.cpp
# transcribe.cpp 0.4.1 plus Hex's patches (hex/parakeet-vocabulary, hex/vocabulary-sounds-like).
COMMIT=bcb639faa4c74a2300ba19e30360cb2355b1663a
# The binding's PUBLIC_HEADER_HASH (transcribe-cpp@0.4.1): a fork with another ABI is refused.
ABIHASH=f99ad4169374b8f3
LIBS=(libtranscribe.dylib libggml.0.dylib libggml-base.0.dylib libggml-cpu.0.dylib libggml-metal.0.dylib)

stamp() {
  printf 'repo=%s\ncommit=%s\n' "$REPO" "$COMMIT"
  for l in "${LIBS[@]}"; do printf '%s=%s\n' "$l" "$(shasum -a 256 "$1/$l" | cut -d' ' -f1)"; done
}

if [ "${1:-}" = "--check" ]; then
  OUT="${2:?output dir}"
  [ -f "$OUT/transcribe.build" ] || exit 1
  for l in "${LIBS[@]}"; do [ -f "$OUT/$l" ] || exit 1; done
  [ "$(stamp "$OUT")" = "$(cat "$OUT/transcribe.build")" ] || exit 1
  exit 0
fi

OUT="${1:?output dir}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init --quiet "$WORK/src"
git -C "$WORK/src" fetch --quiet --depth 1 "$REPO" "$COMMIT"
git -C "$WORK/src" checkout --quiet FETCH_HEAD
if [ "$(git -C "$WORK/src" rev-parse HEAD)" != "$COMMIT" ]; then
  echo "transcribe.cpp fork: fetched $(git -C "$WORK/src" rev-parse HEAD), not $COMMIT" >&2
  exit 1
fi
if [ "$(tr -d '[:space:]' <"$WORK/src/include/transcribe.abihash")" != "$ABIHASH" ]; then
  echo "transcribe.cpp fork: header hash isn't $ABIHASH, so transcribe-cpp@0.4.1 can't load it" >&2
  exit 1
fi
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DTRANSCRIBE_BUILD_SHARED=ON -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF -DTRANSCRIBE_BUILD_TESTS=OFF \
  -DTRANSCRIBE_BUILD_EXAMPLES=OFF >/dev/null
# Compiler warnings go to a log, shown only when the build fails.
cmake --build "$WORK/build" --target transcribe -j >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log" >&2; exit 1; }
cmake --install "$WORK/build" --prefix "$WORK/inst" >/dev/null
mkdir -p "$OUT"
# The real files under the names the libraries load each other by (@rpath, which is @loader_path).
for l in "${LIBS[@]}"; do cp -L "$WORK/inst/lib/$l" "$OUT/$l"; done
# Only these and system libraries may be linked, or it won't run from inside the app.
for l in "${LIBS[@]}"; do
  if otool -L "$OUT/$l" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/|@rpath/lib(transcribe|ggml))'; then
    echo "$l links a library outside the system and this build" >&2
    exit 1
  fi
done
stamp "$OUT" >"$OUT/transcribe.build"
echo "transcribe.cpp ${COMMIT:0:7} (Hex fork) -> $OUT/libtranscribe.dylib"
