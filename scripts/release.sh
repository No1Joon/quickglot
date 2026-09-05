#!/bin/bash
# Archives the app for the App Store and uploads it, without Xcode's Organizer.
#
# The Organizer asks a person to pick an archive from a list. That list is what
# uploaded an iOS archive in place of the macOS one: a CLI-built archive was not
# shown, so the visible one was chosen. Here the archive that is uploaded is the
# one this run just built, and its platform is checked before it leaves the
# machine.
#
#   scripts/release.sh [macos|ios|all] [--no-upload]
#
# Environment (none of it is committed; check-sources.mjs blocks a Team ID):
#   QUICKGLOT_TEAM_ID         Apple Team ID (required)
#   QUICKGLOT_ASC_KEY_PATH    App Store Connect API key, AuthKey_<id>.p8
#   QUICKGLOT_ASC_KEY_ID      the key's ID
#   QUICKGLOT_ASC_ISSUER_ID   the key's issuer ID
#
# The three ASC values are required to upload. With --no-upload the archive is
# exported to build/release/ instead, which exercises distribution signing (a
# missing App Group profile fails here, not at upload) and needs no key.
#
# Version comes from extension/manifest.json, the single source. Build number
# is the UTC minute this run started, so it rises on every machine and branch
# without anyone editing the project; the project's own value stays at 1.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$REPO/apple/QuickGlot/QuickGlot.xcodeproj"
PBX="$PROJECT/project.pbxproj"

PLATFORMS=()
UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    macos|ios) PLATFORMS+=("$arg") ;;
    all) PLATFORMS=(macos ios) ;;
    --no-upload) UPLOAD=0 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done
[ "${#PLATFORMS[@]}" -gt 0 ] || PLATFORMS=(macos ios)

TEAM_ID="${QUICKGLOT_TEAM_ID:-}"
if [ -z "$TEAM_ID" ]; then
  echo "error: QUICKGLOT_TEAM_ID is not set" >&2
  exit 2
fi

AUTH=()
if [ "$UPLOAD" -eq 1 ]; then
  for v in QUICKGLOT_ASC_KEY_PATH QUICKGLOT_ASC_KEY_ID QUICKGLOT_ASC_ISSUER_ID; do
    if [ -z "${!v:-}" ]; then
      echo "error: $v is not set; it is required to upload (or pass --no-upload)" >&2
      exit 2
    fi
  done
  if [ ! -f "$QUICKGLOT_ASC_KEY_PATH" ]; then
    echo "error: QUICKGLOT_ASC_KEY_PATH does not exist: $QUICKGLOT_ASC_KEY_PATH" >&2
    exit 2
  fi
  AUTH=(-authenticationKeyPath "$QUICKGLOT_ASC_KEY_PATH"
        -authenticationKeyID "$QUICKGLOT_ASC_KEY_ID"
        -authenticationKeyIssuerID "$QUICKGLOT_ASC_ISSUER_ID")
fi

cd "$REPO"

# What ships must be what is committed. A stray edit is not visible in the
# uploaded binary, and the archive cannot be traced back to a commit otherwise.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit or stash before releasing" >&2
  git status --short >&2
  exit 1
fi

VERSION="$(node -p "require('./extension/manifest.json').version")"
if ! grep -q "MARKETING_VERSION = $VERSION;" "$PBX"; then
  echo "error: project MARKETING_VERSION differs from extension/manifest.json ($VERSION);" >&2
  echo "run scripts/regen-xcode.sh so the project picks the version up" >&2
  exit 1
fi
BUILD="$(date -u +%Y%m%d%H%M)"
COMMIT="$(git rev-parse --short HEAD)"

npm test
npm run build

ARCHIVE_DIR="$HOME/Library/Developer/Xcode/Archives/$(date +%F)"
OUT_DIR="$REPO/build/release/$VERSION-$BUILD"
mkdir -p "$ARCHIVE_DIR" "$OUT_DIR"

OPTIONS="$(mktemp -d)"
trap 'rm -rf "$OPTIONS"' EXIT
if [ "$UPLOAD" -eq 1 ]; then DESTINATION=upload; else DESTINATION=export; fi
# manageAppVersionAndBuildNumber is off so the build number that was archived
# and verified below is the one App Store Connect receives.
cat > "$OPTIONS/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$DESTINATION</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
	<key>generateAppStoreInformation</key>
	<false/>
	<key>testFlightInternalTestingOnly</key>
	<false/>
</dict>
</plist>
PLIST

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null; }

# Prints the xcodebuild log's tail when a step fails; the full log stays on disk.
run_logged() {
  local log="$1"; shift
  if ! "$@" >"$log" 2>&1; then
    echo "error: failed, last lines of $log:" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
}

echo "QuickGlot $VERSION ($BUILD) from $COMMIT -> ${PLATFORMS[*]}, destination=$DESTINATION"

for platform in "${PLATFORMS[@]}"; do
  case "$platform" in
    macos) SCHEME="QuickGlot (macOS)"; DEST='generic/platform=macOS'; SDK=macosx ;;
    ios)   SCHEME="QuickGlot (iOS)";   DEST='generic/platform=iOS';   SDK=iphoneos ;;
  esac
  ARCHIVE="$ARCHIVE_DIR/QuickGlot-$platform-$VERSION-$BUILD.xcarchive"
  EXPORT="$OUT_DIR/$platform"
  mkdir -p "$EXPORT"

  echo "== $platform: archive"
  run_logged "$EXPORT/archive.log" \
    xcodebuild archive -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
      -destination "$DEST" -archivePath "$ARCHIVE" \
      DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" \
      -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

  # The checks below are the ones that have actually bitten: the wrong platform
  # uploaded, and a macOS build without a category that the store then refused.
  APP="$ARCHIVE/Products/$(plist "$ARCHIVE/Info.plist" ApplicationProperties:ApplicationPath)"
  if [ "$SDK" = macosx ]; then INFO="$APP/Contents/Info.plist"; else INFO="$APP/Info.plist"; fi
  echo "== $platform: verify"
  fail=0
  check() {
    local what="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
      echo "   $what = $actual"
    else
      echo "   $what: expected '$expected', archive has '$actual'" >&2; fail=1
    fi
  }
  check platform "$SDK" "$(plist "$INFO" DTPlatformName)"
  check version "$VERSION" "$(plist "$INFO" CFBundleShortVersionString)"
  check build "$BUILD" "$(plist "$INFO" CFBundleVersion)"
  check bundle com.quickglot.app "$(plist "$INFO" CFBundleIdentifier)"
  check encryption false "$(plist "$INFO" ITSAppUsesNonExemptEncryption)"
  if [ "$SDK" = macosx ]; then
    check category public.app-category.utilities "$(plist "$INFO" LSApplicationCategoryType)"
  fi
  if [ "$fail" -ne 0 ]; then
    echo "error: archive $ARCHIVE does not match what this run meant to build" >&2
    exit 1
  fi

  echo "== $platform: $DESTINATION"
  run_logged "$EXPORT/export.log" \
    xcodebuild -exportArchive -archivePath "$ARCHIVE" \
      -exportOptionsPlist "$OPTIONS/ExportOptions.plist" -exportPath "$EXPORT" \
      -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

  if [ "$UPLOAD" -eq 1 ]; then
    # Xcode records the upload in the archive itself; that record, not the
    # exit code, is what says the build reached Apple.
    STATE="$(plist "$ARCHIVE/Info.plist" Distributions:0:uploadEvent:state)"
    WHEN="$(plist "$ARCHIVE/Info.plist" Distributions:0:uploadEvent:date)"
    if [ "$STATE" != success ]; then
      echo "error: archive records upload state '$STATE'; see $EXPORT/export.log" >&2
      exit 1
    fi
    echo "   uploaded $WHEN"
  else
    echo "   exported to $EXPORT"
    ls "$EXPORT" | grep -E '\.(pkg|ipa)$' | sed 's/^/   /' || true
  fi
  echo "   archive $ARCHIVE"
done

echo
echo "QuickGlot $VERSION ($BUILD) done: ${PLATFORMS[*]}"
