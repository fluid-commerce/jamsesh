#!/usr/bin/env bash
set -euxo pipefail
export CARGO_TARGET_DIR=/tmp/claude-501/apptest-target
STAGE=/tmp/claude-501/apptest-stage
cd ~/jamsesh-apptest
cargo build --release --locked -p figcraft-server -p figcraft-cli
(cd apps/figcraft-web && trunk build --release)
cp $CARGO_TARGET_DIR/release/figcraft-server $CARGO_TARGET_DIR/release/figcraft-cli "$STAGE/bin/"
rm -rf "$STAGE/web-canvas"; cp -R dist/web "$STAGE/web-canvas"
[ -f "$STAGE/models/wespeaker_en.onnx" ] || curl -fsSL -o "$STAGE/models/wespeaker_en.onnx" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
cd jamsesh && bun install --frozen-lockfile
JAMSESH_HOME="$STAGE" bash app/bundle-hub.sh
cd app/src-tauri && bunx @tauri-apps/cli@2 build --bundles app
echo BUILD_DONE
