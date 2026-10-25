#!/usr/bin/env bash
# Share Finni with one public HTTPS link (for the QR code on the slides): builds the website, starts the
# backend (which serves the site, the API and the voice), and opens a free Cloudflare tunnel to it.
# The link carries an access code, so only people with the link can spend credits. Stop with Ctrl+C.
#
#   scripts/share.sh            (from the repo root; needs .env, Node, uv and cloudflared)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cloudflared >/dev/null || { echo "Install cloudflared first:  brew install cloudflared"; exit 1; }
[ -f .env ] || { echo "No .env here: it needs ANTHROPIC_API_KEY (and ELEVENLABS_API_KEY for the voice)."; exit 1; }

code=$(grep -E '^FINNI_ACCESS_CODE=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
if [ -z "$code" ]; then
  code=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)
  printf '\nFINNI_ACCESS_CODE=%s\n' "$code" >> .env
  echo "Added an access code to .env: $code"
fi

echo "Building the website…"
(cd app && npm run build >/dev/null)

echo "Starting the backend on :8000 (log: /tmp/finni-server.log)…"
uv run --env-file .env uvicorn server.app:app --host 127.0.0.1 --port 8000 >/tmp/finni-server.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:8000/buildings >/dev/null && break
  sleep 1
done

echo "Opening the tunnel…"
cloudflared tunnel --url http://localhost:8000 2>&1 | while read -r line; do
  url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' || true)
  if [ -n "$url" ]; then
    printf '\n  Share this link (make the QR code from it):\n\n  %s/?code=%s\n\n' "$url" "$code"
  fi
done
