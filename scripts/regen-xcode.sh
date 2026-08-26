#!/bin/bash
# Regenerates apple/ from dist/ with safari-web-extension-converter.
#
# The generated project references each extension file individually, so a file
# added under extension/ is silently missing from the built .appex until the
# project knows about it — Safari then reports "Unable to find <file> in the
# extension's resources". Rather than hand-editing project.pbxproj, regenerate
# and re-apply the handful of settings we own.
#
# Run after adding or removing any file that ends up in dist/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="QuickGlot"
BUNDLE_ID="com.no1joon.quickglot"
TEAM_ID="M25B65BYV8"
IOS_TARGET="26.0"
MACOS_TARGET="26.0"

SOURCES=(
  "$APP_NAME/Shared (App)/ViewController.swift"
  "$APP_NAME/Shared (Extension)/SafariWebExtensionHandler.swift"
)

cd "$REPO"
npm run build

STASH="$(mktemp -d)"
trap 'rm -rf "$STASH"' EXIT

for rel in "${SOURCES[@]}"; do
  if [ -f "apple/$rel" ]; then
    mkdir -p "$STASH/$(dirname "$rel")"
    cp "apple/$rel" "$STASH/$rel"
  fi
done

rm -rf apple
xcrun safari-web-extension-converter dist \
  --project-location apple \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift --no-open --no-prompt --force

for rel in "${SOURCES[@]}"; do
  [ -f "$STASH/$rel" ] && cp "$STASH/$rel" "apple/$rel"
done

PBX="apple/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
sed -i '' \
  -e "s/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*;/IPHONEOS_DEPLOYMENT_TARGET = $IOS_TARGET;/g" \
  -e "s/MACOSX_DEPLOYMENT_TARGET = [0-9.]*;/MACOSX_DEPLOYMENT_TARGET = $MACOS_TARGET;/g" \
  "$PBX"

python3 - "$PBX" "$TEAM_ID" <<'PY'
import re, sys
path, team = sys.argv[1], sys.argv[2]
with open(path) as f:
    s = f.read()
if 'DEVELOPMENT_TEAM' not in s:
    s, n = re.subn(r'([ \t]*)CODE_SIGN_STYLE = Automatic;',
                   lambda m: f'{m.group(1)}CODE_SIGN_STYLE = Automatic;\n{m.group(1)}DEVELOPMENT_TEAM = {team};',
                   s)
    with open(path, 'w') as f:
        f.write(s)
    print(f'DEVELOPMENT_TEAM applied to {n} configurations')
PY

echo
echo "Extension resources now referenced by the project:"
grep -o 'path = [^;]*dist[^;]*;' "$PBX" | sort -u
