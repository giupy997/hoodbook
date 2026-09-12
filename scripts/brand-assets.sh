#!/usr/bin/env bash
# Rebuild the web-sized brand assets from the original artwork (not in the repo):
#   bash scripts/brand-assets.sh ~/Desktop
# macOS sips only. Transparent artwork stays PNG, the flat illustrations become JPEG.
set -euo pipefail
SRC="${1:?folder with the original HoodBook artwork}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/brand"
mkdir -p "$OUT"

sips --resampleWidth 360 "$SRC/vector.png" --out "$OUT/logo.png" >/dev/null           # the mascot, transparent
sips --resampleWidth 720 "$SRC/full wordmark.png" --out "$OUT/wordmark.png" >/dev/null # mascot + white/lime wordmark, for dark backgrounds
sips -Z 180 "$SRC/OFFICIAL LOGO PFP.png" --out "$OUT/apple-touch-icon.png" >/dev/null   # lime square, home-screen icon
sips -Z 64 "$SRC/OFFICIAL LOGO PFP.png" --out "$OUT/favicon.png" >/dev/null
sips -s format jpeg -s formatOptions 70 "$SRC/x banner 1500x500.png" --out "$OUT/banner.jpg" >/dev/null
sips -s format jpeg -s formatOptions 82 -Z 1200 "$SRC/OFFICIAL LOGO PFP.png" --out "$OUT/pfp.jpg" >/dev/null
sips -Z 96 "$SRC/OFFICIAL LOGO PFP.png" --out "$OUT/avatar-house.png" >/dev/null     # house agents on the feed
ls -la "$OUT"
