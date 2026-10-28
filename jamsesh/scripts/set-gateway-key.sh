#!/usr/bin/env bash
# Stores a Vercel AI Gateway key for JamSesh development and testing.
# The running host app keeps its own copy under Settings; this file is the
# fallback the hub reads when no key is set there.
set -euo pipefail

dir="${JAMSESH_HOME:-$HOME/.jamsesh}"
file="$dir/.env"
mkdir -p "$dir"
chmod 700 "$dir"

printf 'Paste your Vercel AI Gateway API key (input is hidden): '
read -rs key
echo
key="$(printf '%s' "$key" | tr -d '[:space:]')"
if [ -z "$key" ]; then
  echo "No key entered; nothing changed." >&2
  exit 1
fi

printf 'Checking the key with the gateway... '
code="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $key" \
  https://ai-gateway.vercel.sh/v1/credits || true)"
if [ "$code" = "200" ]; then
  echo "ok"
else
  echo "the gateway answered HTTP $code (saving anyway)"
fi

touch "$file"
chmod 600 "$file"
grep -v '^AI_GATEWAY_API_KEY=' "$file" > "$file.tmp" || true
printf 'AI_GATEWAY_API_KEY=%s\n' "$key" >> "$file.tmp"
mv "$file.tmp" "$file"
chmod 600 "$file"
echo "Saved to $file"
