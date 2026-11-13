#!/usr/bin/env bash
# Builds transcribe.cpp's shared library for Parakeet (hub/src/audio/stt-server.ts): arm64 with Metal
# (the shader library embedded), from Hex's fork, which adds Parakeet vocabulary rescoring to
# transcribe.cpp 0.4.1 with the same C ABI (header hash), so the transcribe-cpp@0.4.1 binding loads
# it in place of its prebuilt library.
# Usage: app/build-transcribe.sh <output dir>          builds it, installs it there, and records its hashes
#        app/build-transcribe.sh --check <output dir>  says whether the libraries there are the recorded ones
# transcribe.cpp and the fork are MIT (see NOTICE).
#
# The input is pinned in app/transcribe-pins.json: the fork's commit and the binding's header hash,
# both checked before anything is built. The output is recorded: in the same run that builds and
# installs the libraries, their SHA-256s are written to hub/src/audio/transcribe-pins.generated.ts
# (gitignored). The hub loads only files with those hashes; bundle-hub.sh runs this before it
# compiles the hub, so the app's hub carries the hashes of the app's own libraries. The build is
# reproducible on one toolchain (no build paths or dates in the output). The libraries are built in a
# folder beside the output and moved into place whole, so a failed build never leaves a mixed set,
# and an interrupted swap puts the old set back.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PINS="$HERE/transcribe-pins.json"
GENERATED="$HERE/../hub/src/audio/transcribe-pins.generated.ts"
pin() { bun -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = p[process.argv[2]]; if (typeof v !== "string") process.exit(1); console.log(v)' "$PINS" "$1"; }
REPO="$(pin repo)"
COMMIT="$(pin commit)"
ABIHASH="$(pin abihash)"
LIBS=(libtranscribe.dylib libggml.0.dylib libggml-base.0.dylib libggml-cpu.0.dylib libggml-metal.0.dylib)
recorded() { # <library>: its SHA-256 as the last build recorded it, for this commit
  bun -e 'const m = await import(process.argv[1]); if (m.LIBRARY_COMMIT !== process.argv[2]) process.exit(1); const v = m.LIBRARY_HASHES?.[process.argv[3]]; if (typeof v !== "string") process.exit(1); console.log(v)' "$GENERATED" "$COMMIT" "$1" 2>/dev/null
}
matches() { # <dir>: every library there has its recorded SHA-256, and nothing else is there
  [ -d "$1" ] && [ -f "$GENERATED" ] || return 1
  [ "$(ls -A "$1" | sort)" = "$(printf '%s\n' "${LIBS[@]}" | sort)" ] || return 1
  for l in "${LIBS[@]}"; do
    [ -f "$1/$l" ] && [ ! -L "$1/$l" ] || return 1
    [ "$(shasum -a 256 "$1/$l" | cut -d' ' -f1)" = "$(recorded "$l")" ] || return 1
  done
}

if [ "${1:-}" = "--check" ]; then
  matches "${2:?output dir}"
  exit
fi

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
OLD=""
cleanup() {
  # Interrupted between moving the old set aside and moving the new one in: the old set goes back.
  if [ -n "$OLD" ] && [ -e "$OLD/x" ] && [ ! -e "$OUT" ]; then mv "$OLD/x" "$OUT"; fi
  if [ -n "$OLD" ]; then rm -rf "$OLD"; fi
  rm -rf "$WORK" "$NEW"
  rmdir "$WORK.lock"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
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
chmod 755 "$NEW"
# The hashes of exactly what was built, taken before it moves.
HASHES="$(for l in "${LIBS[@]}"; do printf '  "%s": "%s",\n' "$l" "$(shasum -a 256 "$NEW/$l" | cut -d' ' -f1)"; done)"
# The old set is moved aside (one rename) and the new one in (another); if the second fails or the
# script is stopped between them, cleanup moves the old set back, so a folder is always there.
if [ -e "$OUT" ]; then OLD="$(mktemp -d "$(dirname "$OUT")/.transcribe-old.XXXXXX")" && mv "$OUT" "$OLD/x"; fi
mv "$NEW" "$OUT"
if [ -n "$OLD" ]; then rm -rf "$OLD"; OLD=""; fi
# Record what was just installed, for the hub (written beside its name, then renamed over it).
{
  echo "// Generated by jamsesh/app/build-transcribe.sh when it built the libraries: don't edit, don't commit."
  echo "// The hub loads Parakeet's library only when every file has the hash recorded here."
  printf 'export const LIBRARY_COMMIT = "%s";\n' "$COMMIT"
  echo "export const LIBRARY_HASHES: Record<string, string> = {"
  echo "$HASHES"
  echo "};"
} >"$GENERATED.tmp"
mv -f "$GENERATED.tmp" "$GENERATED"
echo "transcribe.cpp ${COMMIT:0:7} (Hex fork) -> $OUT"
