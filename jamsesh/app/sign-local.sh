#!/usr/bin/env bash
# Signs a JamSesh.app build with this Mac's own signing identity, so macOS keeps the app's
# permissions (microphone, screen recording, accessibility) across rebuilds. An ad-hoc signature
# changes with every build, and macOS then treats each build as a new app that has to be allowed
# again, at the Mac. Not for builds you give to other people: those need a Developer ID.
#   jamsesh/app/sign-local.sh                     sets up the identity (once per Mac)
#   jamsesh/app/sign-local.sh path/to/JamSesh.app  signs a build with it
# The identity lives in its own keychain under ~/.jamsesh/signing; the login keychain and the
# keychain search list are left alone.
set -euo pipefail
NAME="JamSesh Local Signing"
DIR="${JAMSESH_SIGNING_DIR:-$HOME/.jamsesh/signing}"
KC="$DIR/jamsesh-signing.keychain-db"
PASS_FILE="$DIR/keychain-password"
HERE="$(cd "$(dirname "$0")" && pwd)"

# One `security` command from stdin; a failure is reported by what the next step finds missing.
sec() { printf '%s\n' "$1" | security -i >/dev/null; }

set_up() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  [ -f "$PASS_FILE" ] || (umask 077 && openssl rand -hex 16 > "$PASS_FILE")
  # The keychain password never goes in a command's arguments (any process can read those): openssl
  # reads it from the 0600 file, and `security` gets its commands on stdin (`security -i`). The
  # password is random hex, so it needs no quoting there. macOS's own openssl (LibreSSL) is used because
  # Homebrew's OpenSSL 3/4 writes .p12 files `security import` rejects as a wrong password.
  local pass; pass="$(cat "$PASS_FILE")"
  [ -f "$KC" ] || sec "create-keychain -p $pass \"$KC\""
  security set-keychain-settings "$KC" # no auto-lock
  sec "unlock-keychain -p $pass \"$KC\""
  if ! security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; then
    local tmp; tmp="$(mktemp -d)"
    printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=%s\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' "$NAME" > "$tmp/cnf"
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$DIR/cert.pem" -days 3650 -config "$tmp/cnf" 2>/dev/null
    /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$DIR/cert.pem" -out "$tmp/id.p12" -passout file:"$PASS_FILE" -name "$NAME"
    sec "import \"$tmp/id.p12\" -k \"$KC\" -P $pass -T /usr/bin/codesign"
    rm -rf "$tmp"
  fi
  sec "set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $pass \"$KC\""
  [ -f "$DIR/cert.pem" ] || security find-certificate -c "$NAME" -p "$KC" > "$DIR/cert.pem"
}

trusted() { security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -q "$NAME"; }

set_up
if ! trusted; then
  echo "One step left, once per Mac: trust the signing certificate (macOS asks for your password):" >&2
  echo "  security add-trusted-cert -r trustRoot -p codeSign -k \"$KC\" \"$DIR/cert.pem\"" >&2
  exit 1
fi
[ $# -eq 0 ] && { echo "Ready: $NAME"; exit 0; }

APP="$1"
[ -d "$APP" ] || { echo "No app at $APP" >&2; exit 1; }
codesign --force --deep --options runtime --keychain "$KC" --sign "$NAME" \
  --entitlements "$HERE/src-tauri/Entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"
echo "Signed $APP with $NAME"
