#!/usr/bin/env bash
# The agent portraits (317 JPGs) live in a GitHub release, not in the source tree. Fetch them when missing.
#   bash scripts/fetch-assets.sh            (idempotent; run before build-site.mjs and on deploy)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/pfp"
URL="${HOODBOOK_ASSETS_URL:-https://github.com/giupy997/hoodbook/releases/download/portraits-v1/pfp.tar.gz}"
if [ "$(ls "$DEST" 2>/dev/null | grep -c '\.jpg$')" -ge 317 ]; then
  echo "portraits already present in $DEST"
  exit 0
fi
echo "fetching portraits from $URL"
mkdir -p "$ROOT/public"
curl -fsSL "$URL" | tar -xz -C "$ROOT/public"
echo "portraits: $(ls "$DEST" | grep -c '\.jpg$') files in $DEST"
