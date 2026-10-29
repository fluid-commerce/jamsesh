#!/usr/bin/env bash
# Installs JamSesh on the host machine (the Mac on the big screen).
#   ./jamsesh/install.sh
# Builds the FigCraft server, CLI, desktop app and browser canvas, builds the
# JamSesh web app, fetches the local voice model, and puts `jamsesh` on your PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
HOME_DIR="${JAMSESH_HOME:-$HOME/.jamsesh}"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/models"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

step "Checking tools"
command -v cargo >/dev/null || { echo "Install Rust first: https://rustup.rs" >&2; exit 1; }
command -v bun >/dev/null || { echo "Install Bun first: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
ok "cargo $(cargo --version | cut -d' ' -f2), bun $(bun --version)"
if jamsesh/app/build-whisper.sh --check "$HOME_DIR/bin"; then ok "whisper-server"
elif command -v cmake >/dev/null && [ "$(uname -s)" = Darwin ]; then jamsesh/app/build-whisper.sh "$HOME_DIR/bin" >/dev/null && ok "Built whisper-server"
elif command -v whisper-server >/dev/null; then ok "whisper-server (Homebrew)"
else warn "No whisper-server (needs cmake to build): transcription will use the gateway"; fi

step "Building FigCraft (server, CLI, desktop app)"
cargo build --release -p figcraft-server -p figcraft-cli -p figcraft
for b in figcraft-server figcraft-cli figcraft; do rm -f "$HOME_DIR/bin/$b"; cp "target/release/$b" "$HOME_DIR/bin/$b"; done
ok "Binaries in $HOME_DIR/bin"

step "Building the browser canvas"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
command -v trunk >/dev/null || { command -v brew >/dev/null && brew install trunk >/dev/null || cargo install trunk --locked; }
(cd apps/figcraft-web && trunk build --release >/dev/null)
rm -rf "$HOME_DIR/web-canvas" && cp -R dist/web "$HOME_DIR/web-canvas"
ok "Canvas in $HOME_DIR/web-canvas"

step "Building the JamSesh app"
(cd jamsesh && bun install >/dev/null && cd web && bunx vite build >/dev/null)
ok "Web app built"

step "Local models"
# The same pin as hub/src/audio/whisper.ts. Downloaded beside its final name and moved there only once its
# size and SHA-256 match, so an interrupted or tampered download is never taken for the model.
WHISPER_MODEL="$HOME_DIR/models/ggml-large-v3-turbo-q5_0.bin"
WHISPER_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
WHISPER_SHA256=394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
WHISPER_BYTES=574041195
mkdir -p "$HOME_DIR/models"
model_ok() { [ -f "$1" ] && [ "$(wc -c <"$1" | tr -d ' ')" = "$WHISPER_BYTES" ] && [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$WHISPER_SHA256" ]; }
if ! model_ok "$WHISPER_MODEL"; then
  rm -f "$WHISPER_MODEL.part"
  curl -fL --progress-bar -o "$WHISPER_MODEL.part" "$WHISPER_URL" || fail "Couldn't download the Whisper model"
  model_ok "$WHISPER_MODEL.part" || { rm -f "$WHISPER_MODEL.part"; fail "The Whisper model download didn't match its checksum"; }
  mv -f "$WHISPER_MODEL.part" "$WHISPER_MODEL"
fi
ok "Whisper large-v3-turbo"
# The speaker model, pinned the same way (bundle-hub.sh ships only this file). A stale or different one is replaced.
WESPEAKER="$HOME_DIR/models/wespeaker_en.onnx"
WESPEAKER_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
WESPEAKER_SHA256=e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012
sha_ok() { [ -f "$1" ] && [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]; }
if ! sha_ok "$WESPEAKER" "$WESPEAKER_SHA256"; then
  rm -f "$WESPEAKER.part"
  curl -fL --progress-bar -o "$WESPEAKER.part" "$WESPEAKER_URL" || fail "Couldn't download the speaker model"
  sha_ok "$WESPEAKER.part" "$WESPEAKER_SHA256" || { rm -f "$WESPEAKER.part"; fail "The speaker model download didn't match its checksum"; }
  mv -f "$WESPEAKER.part" "$WESPEAKER"
fi
ok "Voiceprint model (WeSpeaker)"

step "Installing the jamsesh command"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/jamsesh/bin/jamsesh" "$HOME/.local/bin/jamsesh"
chmod +x "$ROOT/jamsesh/bin/jamsesh"
ok "$HOME/.local/bin/jamsesh"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "Add ~/.local/bin to your PATH" ;; esac

printf '\n\033[1mDone.\033[0m Start the session with:  jamsesh host\n'
