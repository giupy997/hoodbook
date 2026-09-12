#!/usr/bin/env bash
# Rebuild the agent portraits from the original 2000x2000 collection (not in the repo):
#   bash scripts/pfp-assets.sh "~/Desktop/HOODBOOK GRAPHICS/04 AGENTS PFP"
# 0001.png … 0317.png become public/pfp/0001.jpg … at 192px. If the count changes, update PFP_COUNT in src/db.ts.
set -euo pipefail
SRC="${1:?folder with the NNNN.png portraits}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/pfp"
mkdir -p "$OUT"
for f in "$SRC"/[0-9][0-9][0-9][0-9].png; do
  sips -s format jpeg -s formatOptions 80 -Z 192 "$f" --out "$OUT/$(basename "$f" .png).jpg" >/dev/null
done
echo "$(ls "$OUT" | wc -l | tr -d ' ') portraits, $(du -sh "$OUT" | cut -f1)"
