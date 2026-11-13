#!/usr/bin/env bash
# Builds transcribe.cpp's shared library for Parakeet (hub/src/audio/stt-server.ts): arm64 with Metal
# (the shader library embedded), from Hex's fork, which adds Parakeet vocabulary rescoring to
# transcribe.cpp 0.4.1 with the same C ABI (header hash), so the transcribe-cpp@0.4.1 binding loads
# it in place of its prebuilt library.
# Usage: app/build-transcribe.sh <output dir>          builds it and installs it there
#        app/build-transcribe.sh --check <output dir>  says whether the libraries there are the pinned ones
#        app/build-transcribe.sh --print <output dir>  builds it into <output dir> and prints its hashes, unchecked
#                                                      (for pinning a new commit or toolchain; never bundled)
# transcribe.cpp and the fork are MIT (see NOTICE).
#
# Everything is pinned in app/transcribe-pins.json, which the hub reads too: the fork's commit, the
# binding's header hash, and each library's SHA-256. The build is reproducible (no build paths or
# dates in the output), so a fresh build must match those hashes or nothing is installed; the hub
# loads only files with those hashes. The libraries are built and checked in a folder beside the
# output and moved into place whole, so a failed build never leaves a mixed set.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PINS="$HERE/transcribe-pins.json"
pin() { bun -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split("/").reduce((o, k) => o?.[k], p); if (typeof v !== "string") process.exit(1); console.log(v)' "$PINS" "$1"; }
REPO="$(pin repo)"
COMMIT="$(pin commit)"
ABIHASH="$(pin abihash)"
LIBS=(libtranscribe.dylib libggml.0.dylib libggml-base.0.dylib libggml-cpu.0.dylib libggml-metal.0.dylib)
matches() { # <dir>: every library there has its pinned SHA-256, and nothing else is there
  [ -d "$1" ] || return 1
  [ "$(ls -A "$1" | sort)" = "$(printf '%s\n' "${LIBS[@]}" | sort)" ] || return 1
  for l in "${LIBS[@]}"; do
    [ -f "$1/$l" ] && [ ! -L "$1/$l" ] || return 1
    [ "$(shasum -a 256 "$1/$l" | cut -d' ' -f1)" = "$(pin "libs/$l")" ] || return 1
  done
}

if [ "${1:-}" = "--check" ]; then
  matches "${2:?output dir}"
  exit
fi
PRINT=0
if [ "${1:-}" = "--print" ]; then PRINT=1; shift; fi

OUT="${1:?output dir}"
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
# The fresh set is assembled beside the output (same disk), so moving it into place is one rename.
NEW="$(mktemp -d "$(dirname "$OUT")/.transcribe-new.XXXXXX")"
# One fixed work folder: the linker's UUID depends on where the objects are, so it must not move.
# (Two builds at once wait for each other.)
WORK="${TMPDIR:-/tmp}"
WORK="${WORK%/}/jamsesh-transcribe-build"
for i in $(seq 1 900); do mkdir "$WORK.lock" 2>/dev/null && break; [ "$i" = 900 ] && { echo "another build holds $WORK.lock (remove it if none is running)" >&2; exit 1; }; sleep 2; done
rm -rf "$WORK" && mkdir -p "$WORK"
trap 'rm -rf "$WORK" "$NEW"; rmdir "$WORK.lock"' EXIT
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
# Reproducible: source and build paths are mapped to fixed names, archive dates are zeroed.
MAP="-ffile-prefix-map=$WORK/src=/transcribe.cpp -ffile-prefix-map=$WORK/build=/build"
export ZERO_AR_DATE=1
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DTRANSCRIBE_BUILD_SHARED=ON -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DTRANSCRIBE_BUILD_TESTS=OFF -DTRANSCRIBE_BUILD_EXAMPLES=OFF \
  -DCMAKE_C_FLAGS="$MAP" -DCMAKE_CXX_FLAGS="$MAP" >/dev/null
# Compiler warnings go to a log, shown only when the build fails.
cmake --build "$WORK/build" --target transcribe -j >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log" >&2; exit 1; }
cmake --install "$WORK/build" --prefix "$WORK/inst" >/dev/null
# The real files under the names the libraries load each other by (@rpath, which is @loader_path).
for l in "${LIBS[@]}"; do cp -L "$WORK/inst/lib/$l" "$NEW/$l"; done
# Only these and system libraries may be linked, or it won't run from inside the app.
for l in "${LIBS[@]}"; do
  if otool -L "$NEW/$l" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/|@rpath/lib(transcribe|ggml))'; then
    echo "$l links a library outside the system and this build" >&2
    exit 1
  fi
done
if [ "$PRINT" = 1 ]; then
  for l in "${LIBS[@]}"; do printf '"%s": "%s",\n' "$l" "$(shasum -a 256 "$NEW/$l" | cut -d' ' -f1)"; done
elif ! matches "$NEW"; then
  echo "transcribe.cpp fork: this build doesn't match app/transcribe-pins.json (another compiler?); nothing installed." >&2
  for l in "${LIBS[@]}"; do echo "  $l $(shasum -a 256 "$NEW/$l" | cut -d' ' -f1)" >&2; done
  exit 1
fi
chmod 755 "$NEW"
OLD=""
if [ -e "$OUT" ]; then OLD="$(mktemp -d "$(dirname "$OUT")/.transcribe-old.XXXXXX")" && mv "$OUT" "$OLD/x"; fi
mv "$NEW" "$OUT"
if [ -n "$OLD" ]; then rm -rf "$OLD"; fi
echo "transcribe.cpp ${COMMIT:0:7} (Hex fork) -> $OUT"
