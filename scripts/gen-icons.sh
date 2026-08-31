#!/bin/bash
# Renders every icon slot from design/*.svg. The SVGs are the source of truth
# and this script never writes to design/.
#
# Three families, each with different rules:
#   extension/icons/*        browser toolbar — rounded plate, alpha kept
#   AppIcon mac-icon-*       macOS — rounded plate inset in a transparent canvas
#   AppIcon universal-*      iOS — full-bleed square, NO alpha (see below)
#
# The iOS slot must not carry an alpha channel: App Store Connect rejects the
# upload if it does. `-alpha remove` composites against the background and
# `-alpha off` drops the channel itself; both are needed, one alone leaves it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQUARE="$REPO/design/icon-square.svg"
TILE="$REPO/design/icon-tile.svg"
EXT_ICONS="$REPO/extension/icons"
APPICON="$REPO/apple/QuickGlot/Shared (App)/Assets.xcassets/AppIcon.appiconset"

command -v magick >/dev/null || { echo "ImageMagick required: brew install imagemagick" >&2; exit 1; }
# ImageMagick's built-in SVG renderer ignores linearGradient and fills the shape
# black without reporting an error, so rasterising goes through librsvg instead.
command -v rsvg-convert >/dev/null || { echo "librsvg required: brew install librsvg" >&2; exit 1; }

# ImageMagick stamps a creation time into every PNG, so identical artwork would
# produce different bytes on each run and dirty the repository for no reason.
# Excluding just the time chunks keeps the colour profile that -strip would drop.
export MAGICK_STABLE="-define png:exclude-chunk=date,time"
for f in "$SQUARE" "$TILE"; do [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }; done

# Rasterise the vector sources once at full size, then downsample from those —
# rendering tiny sizes straight from SVG loses thin geometry.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rsvg-convert -w 1024 -h 1024 -o "$WORK/tile.png" "$TILE"
rsvg-convert -w 1024 -h 1024 -o "$WORK/square.png" "$SQUARE"

echo "extension icons"
mkdir -p "$EXT_ICONS"
for size in 48 96 128 256 512; do
  # PNG32 keeps every slot truecolour+alpha; left alone, ImageMagick quietly
  # switches small images to an indexed palette and the gradient can band.
  magick "$WORK/tile.png" $MAGICK_STABLE -resize "${size}x${size}" "PNG32:$EXT_ICONS/icon-${size}.png"
  echo "  icon-${size}.png"
done

echo "macOS app icon"
# Apple's macOS grid leaves a margin around the plate: the rounded square covers
# 824 of a 1024 canvas, and the transparent border is what makes a Mac icon look
# like a Mac icon rather than a full-bleed square.
for slot in 16@1x:16 16@2x:32 32@1x:32 32@2x:64 128@1x:128 128@2x:256 256@1x:256 256@2x:512 512@1x:512 512@2x:1024; do
  name="${slot%%:*}"
  px="${slot##*:}"
  # Apple's macOS grid puts an 824pt plate on a 1024pt canvas. Integer division
  # truncates, which costs the 16, 32 and 64px slots a whole pixel — several
  # percent at those sizes — so round instead.
  plate=$(( (px * 824 + 512) / 1024 ))
  magick "$WORK/tile.png" $MAGICK_STABLE -resize "${plate}x${plate}" \
    -background none -gravity center -extent "${px}x${px}" \
    "PNG32:$APPICON/mac-icon-${name}.png"
  echo "  mac-icon-${name}.png (${px}px, plate ${plate}px)"
done

echo "iOS app icon"
magick "$WORK/square.png" $MAGICK_STABLE -resize 1024x1024 \
  -background white -alpha remove -alpha off \
  "PNG24:$APPICON/universal-icon-1024@1x.png"
echo "  universal-icon-1024@1x.png"

echo
echo "Verifying PNG colour types (iOS must be 2 = RGB, no alpha):"
python3 - "$APPICON/universal-icon-1024@1x.png" "$EXT_ICONS/icon-512.png" "$APPICON/mac-icon-512@2x.png" <<'PY'
import struct, sys, pathlib
KIND = {0: "grayscale", 2: "RGB", 3: "palette", 4: "gray+alpha", 6: "RGBA"}
for path in sys.argv[1:]:
    data = pathlib.Path(path).read_bytes()
    w, h, depth, ctype = struct.unpack(">IIBB", data[16:26])
    print(f"  {pathlib.Path(path).name:30} {w}x{h}  colortype={ctype} ({KIND.get(ctype, '?')})")
PY
