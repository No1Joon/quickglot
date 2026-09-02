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
BUNDLE_ID="com.quickglot.app"
# Not committed: the Apple Team ID is a personal identifier, so it is supplied
# per-machine. Leave it unset to have Xcode resolve the team itself.
TEAM_ID="${QUICKGLOT_TEAM_ID:-}"
IOS_TARGET="26.0"
MACOS_TARGET="26.0"
# iPhone only. The App Store requires a 13-inch iPad screenshot from any app that
# declares iPad support, and one cannot be produced without the hardware: the
# simulator ships no on-device translation models, so every screen it renders is
# the unsupported-pair error. An iPhone-only build still registers its Safari
# extension on iPad, so the extension keeps working there.
DEVICE_FAMILY="1"

SOURCES=(
  "$APP_NAME/Shared (App)/ViewController.swift"
  "$APP_NAME/Shared (Extension)/SafariWebExtensionHandler.swift"
  "$APP_NAME/macOS (App)/QuickGlot-macOS.entitlements"
  "$APP_NAME/macOS (Extension)/QuickGlotExtension-macOS.entitlements"
  "$APP_NAME/iOS (App)/QuickGlot-iOS.entitlements"
  "$APP_NAME/iOS (Extension)/QuickGlotExtension-iOS.entitlements"
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

# The app group is what lets the app and the extension share one setting. The
# team prefix is expanded by Xcode at build time so the team id stays out of the
# repository, and the same value is mirrored into Info.plist for the code to read.
python3 - "$PBX" <<'PYX'
import re, sys
path = sys.argv[1]
with open(path) as f:
    s = f.read()

def entitlements_for(bundle, sdk):
    mac = sdk.startswith('macosx')
    ext = bundle.endswith('.Extension')
    plat = 'macOS' if mac else 'iOS'
    kind = 'Extension' if ext else 'App'
    return f"{plat} ({kind})/QuickGlot{'Extension' if ext else ''}-{plat}.entitlements"

def patch(m):
    body = m.group(0)
    if 'CODE_SIGN_ENTITLEMENTS' in body:
        return body
    bid = re.search(r'PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);', body)
    sdk = re.search(r'SDKROOT = ([^;]+);', body)
    if not (bid and sdk):
        return body
    indent = re.search(r'\n(\s*)PRODUCT_BUNDLE_IDENTIFIER', body).group(1)
    return body.replace(
        f'{indent}PRODUCT_BUNDLE_IDENTIFIER',
        f'{indent}CODE_SIGN_ENTITLEMENTS = "{entitlements_for(bid.group(1), sdk.group(1))}";\n{indent}PRODUCT_BUNDLE_IDENTIFIER', 1)

s = re.sub(r'/\* (?:Debug|Release) \*/ = \{\n\s*isa = XCBuildConfiguration;\n\s*buildSettings = \{.*?\n\s*\};',
           patch, s, flags=re.S)
with open(path, 'w') as f:
    f.write(s)
print('CODE_SIGN_ENTITLEMENTS restored')
PYX

for entry in "macOS (App):\$(TeamIdentifierPrefix)group.com.quickglot.app" \
             "macOS (Extension):\$(TeamIdentifierPrefix)group.com.quickglot.app" \
             "iOS (App):group.com.quickglot.app" \
             "iOS (Extension):group.com.quickglot.app"; do
  dir="${entry%%:*}"; value="${entry#*:}"
  plist="apple/$APP_NAME/$dir/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :AppGroupIdentifier string $value" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :AppGroupIdentifier $value" "$plist"
done

# No network means nothing to declare for export compliance; saying so up front
# removes the question from every submission.
for plist in "apple/$APP_NAME/iOS (App)/Info.plist" "apple/$APP_NAME/macOS (App)/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$plist"
done
sed -i '' \
  -e "s/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*;/IPHONEOS_DEPLOYMENT_TARGET = $IOS_TARGET;/g" \
  -e "s/MACOSX_DEPLOYMENT_TARGET = [0-9.]*;/MACOSX_DEPLOYMENT_TARGET = $MACOS_TARGET;/g" \
  -e "s/TARGETED_DEVICE_FAMILY = \"[0-9,]*\";/TARGETED_DEVICE_FAMILY = \"$DEVICE_FAMILY\";/g" \
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

# The converter copies the manifest icons straight into the asset catalogue,
# which overwrites the slots gen-icons.sh produced — including turning the iOS
# icon back into RGBA, which App Store Connect rejects.
if command -v magick >/dev/null && command -v rsvg-convert >/dev/null; then
  "$REPO/scripts/gen-icons.sh" >/dev/null
  echo "icons regenerated"
else
  echo "warning: magick/rsvg-convert missing - app icons are the converter's, run scripts/gen-icons.sh" >&2
fi

echo
echo "Extension resources now referenced by the project:"
grep -o 'path = [^;]*dist[^;]*;' "$PBX" | sort -u
