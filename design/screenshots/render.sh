#!/usr/bin/env bash
#
# Renders the App Store screenshot templates to PNGs at Apple's required sizes.
#
# The captures inside the templates are screen recordings of the running app and
# are not committed; put them in captures/ before rendering. Output is written to
# out/, or to $QUICKGLOT_SHOTS_OUT.
#
# Canvas size comes from the file name so a new shot needs no wiring:
#   mac-*     2880x1800   iphone-*  1320x2868   ipad-*  2064x2752
#
# App Store Connect rejects a screenshot with an alpha channel, so every render
# is flattened onto white and stripped before it is written.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
out=${QUICKGLOT_SHOTS_OUT:-"$here/out"}
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

[ -x "$chrome" ] || { echo "Chrome not found at $chrome; set CHROME." >&2; exit 1; }
command -v magick >/dev/null || { echo "ImageMagick (magick) is required." >&2; exit 1; }

mkdir -p "$out"
shopt -s nullglob
rendered=0

for template in "$here"/*.html; do
  name=$(basename "$template" .html)
  case "$name" in
    mac-*)    size=2880,1800 ;;
    iphone-*) size=1320,2868 ;;
    ipad-*)   size=2064,2752 ;;
    *)        echo "skip $name (no size for this prefix)"; continue ;;
  esac

  "$chrome" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="$size" \
    --screenshot="$out/$name-raw.png" "$template" 2>/dev/null

  magick "$out/$name-raw.png" -background white -alpha remove -alpha off \
    -strip "PNG24:$out/$name.png"
  rm -f "$out/$name-raw.png"

  echo "$name -> $(magick identify -format '%wx%h' "$out/$name.png")"
  rendered=$((rendered + 1))
done

echo "rendered $rendered screenshot(s) into $out"
