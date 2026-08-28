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
# Not committed: the Apple Team ID is a personal identifier, so it is supplied
# per-machine. Leave it unset to have Xcode resolve the team itself.
TEAM_ID="${QUICKGLOT_TEAM_ID:-}"
IOS_TARGET="26.0"
MACOS_TARGET="26.0"

SOURCES=(
  "$APP_NAME/Shared (App)/ViewController.swift"
  "$APP_NAME/Shared (Extension)/SafariWebExtensionHandler.swift"
)

cd "$REPO"
npm run build

# This script deletes apple/ and lets the converter rebuild it, restoring only
# the settings listed below. Anything else added to the project — a test target,
# an extra scheme, a new source file — would be destroyed without a word. Refuse
# rather than discard work that cannot be reconstructed.
PBX_BEFORE="apple/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
if [ -f "$PBX_BEFORE" ]; then
  EXPECTED=4   # app and extension, macOS and iOS
  ACTUAL=$(/usr/bin/grep -c "isa = PBXNativeTarget;" "$PBX_BEFORE" || true)
  if [ "$ACTUAL" -ne "$EXPECTED" ]; then
    echo "error: project has $ACTUAL targets, expected $EXPECTED." >&2
    echo "Regenerating would delete the extra target(s). Register new dist/ files" >&2
    echo "by hand in Xcode instead, or update this script to restore them." >&2
    exit 1
  fi
fi

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

# The Xcode template stamps the machine owner's name into every generated
# source header. The repository is public and the name serves no purpose here.
/usr/bin/find apple -name '*.swift' -exec sed -i '' '/^\/\/  Created by /d' {} +

PBX="apple/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"

# The converter grants the container app outbound network and read-only file
# access by default. Neither target makes a network request or opens a file, and
# a sandbox that cannot reach the network is what actually backs the privacy
# claim rather than merely asserting it.
sed -i '' \
  -e 's/ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;/ENABLE_OUTGOING_NETWORK_CONNECTIONS = NO;/g' \
  -e 's/ENABLE_USER_SELECTED_FILES = readonly;/ENABLE_USER_SELECTED_FILES = NO;/g' \
  "$PBX"

# No network means nothing to declare for export compliance; saying so up front
# removes the question from every submission.
for plist in "apple/$APP_NAME/iOS (App)/Info.plist" "apple/$APP_NAME/macOS (App)/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$plist"
done
sed -i '' \
  -e "s/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*;/IPHONEOS_DEPLOYMENT_TARGET = $IOS_TARGET;/g" \
  -e "s/MACOSX_DEPLOYMENT_TARGET = [0-9.]*;/MACOSX_DEPLOYMENT_TARGET = $MACOS_TARGET;/g" \
  "$PBX"

if [ -n "$TEAM_ID" ]; then
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
else
  echo "QUICKGLOT_TEAM_ID not set - leaving signing team to Xcode"
fi

echo
echo "Extension resources now referenced by the project:"
grep -o 'path = [^;]*dist[^;]*;' "$PBX" | sort -u
