#!/usr/bin/env bash
# Builds "ZUKU Studio.app" (Swift + AppKit + WKWebView, no Electron) for ONE explicit
# architecture with the Xcode toolchain, signs it ad hoc for LOCAL DEVELOPMENT only and
# runs the native self-test. It never notarizes and never uses distribution credentials.
#
#   build.sh --arch arm64|x86_64 [--out DIR] [--stage-runtime --node /abs/node] [--register]
#
# --stage-runtime  writes a development zuku-runtime/ sibling (managed Node copy + the
#                  packed @zukujs/cli installed with npm, like the user installer) and runs
#                  --stdio-test against the synthetic fixture.
# --register       registers the built app with LaunchServices (lsregister -f) so
#                  zuku://ai/connect resolves to it. Off by default.
set -euo pipefail

fail() { printf 'build.sh: %s\n' "$1" >&2; exit "${2:-1}"; }
[[ "$(uname -s)" == Darwin ]] || fail "macOS with Xcode is required (xcrun swiftc, codesign, plutil). This host is $(uname -s); nothing was built." 69

arch='' out='' stage=0 node='' register=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) [[ $# -ge 2 ]] || fail '--arch needs arm64 or x86_64'; arch=$2; shift 2 ;;
    --out) [[ $# -ge 2 ]] || fail '--out needs a directory'; out=$2; shift 2 ;;
    --stage-runtime) stage=1; shift ;;
    --node) [[ $# -ge 2 ]] || fail '--node needs an absolute path'; node=$2; shift 2 ;;
    --register) register=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
[[ "$arch" == arm64 || "$arch" == x86_64 ]] || fail '--arch must be arm64 or x86_64 (one explicit architecture per build).'

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$here/../../.." && pwd -P)
version=$(plutil -extract version raw -o - "$repo/package.json")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'package.json version is not a plain semver.'
[[ "$(plutil -extract name raw -o - "$repo/package.json")" == '@zukujs/cli' ]] || fail 'package.json is not @zukujs/cli.'
out=${out:-"$here/build/$arch"}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd -P)
[[ "$out" =~ ^/[A-Za-z0-9\ ._/+-]+$ ]] || fail 'Use an output path without quotes, backslashes or control characters.'

app="$out/ZUKU Studio.app"
contents="$app/Contents"
resources="$contents/Resources/zuku"
rm -rf -- "$app"
mkdir -p -- "$contents/MacOS" "$resources/studio/renderer" "$resources/lib/agent-protocol" "$resources/studio/native/macos/tests"

sdk=$(xcrun --sdk macosx --show-sdk-path)
printf 'Compiling ZukuStudio for %s (Swift 6 language mode, complete concurrency checking)\n' "$arch"
xcrun --sdk macosx swiftc -swift-version 6 -parse-as-library -O \
  -target "$arch-apple-macos13.0" -sdk "$sdk" \
  -framework AppKit -framework WebKit -framework JavaScriptCore \
  -o "$contents/MacOS/ZukuStudio" "$here"/Sources/*.swift
[[ "$(lipo -archs "$contents/MacOS/ZukuStudio")" == "$arch" ]] || fail "binary is not $arch only."

sed "s/@VERSION@/$version/g" "$here/Resources/Info.plist.in" > "$contents/Info.plist"
plutil -lint "$contents/Info.plist" >/dev/null
printf 'APPL????' > "$contents/PkgInfo"

for name in index.html main.mjs index.mjs app.mjs client.mjs state.mjs dom.mjs diff.mjs preview.mjs styles.css; do
  install -m 0644 "$repo/studio/renderer/$name" "$resources/studio/renderer/$name"
done
install -m 0644 "$repo/lib/agent-protocol/schema.mjs" "$resources/lib/agent-protocol/schema.mjs"
install -m 0644 "$repo/studio/native/bridge.js" "$resources/studio/native/bridge.js"
install -m 0644 "$here/Resources/native-codec.js" "$resources/studio/native/macos/native-codec.js"
install -m 0644 "$here/tests/stdio-fixture.mjs" "$resources/studio/native/macos/tests/stdio-fixture.mjs"

# Ad-hoc signature with the hardened runtime: LOCAL DEVELOPMENT ONLY. Gatekeeper will not
# trust it on other Macs. Official distribution needs a Developer ID Application identity,
# notarization (xcrun notarytool) and stapling, none of which this script performs.
codesign --force --options runtime --timestamp=none --sign - "$app"
codesign --verify --strict --deep "$app"
printf 'Signed ad hoc (local development only; not notarized, not for distribution).\n'

runs_here=0
if [[ "$(uname -m)" == "$arch" ]] || { [[ "$arch" == x86_64 ]] && arch -x86_64 /usr/bin/true 2>/dev/null; }; then runs_here=1; fi
if [[ $runs_here -eq 1 ]]; then
  "$contents/MacOS/ZukuStudio" --self-test
else
  printf 'Skipped --self-test: this Mac cannot execute %s binaries.\n' "$arch"
fi

if [[ $stage -eq 1 ]]; then
  [[ "$node" == /* && -f "$node" && -x "$node" && ! -L "$node" ]] || fail '--stage-runtime needs --node with the absolute path of a real Node.js 22+ binary.'
  [[ "$(lipo -archs "$node" 2>/dev/null)" == *"$arch"* ]] || fail "--node is not a $arch binary."
  command -v npm >/dev/null || fail 'npm is required on PATH to stage the CLI package.'
  runtime="$out/zuku-runtime"
  work=$(mktemp -d "$out/.stage-XXXXXXXX")
  trap 'rm -rf -- "$work"' EXIT
  rm -rf -- "$runtime"
  mkdir -p -- "$runtime/runtime/bin" "$runtime/npm"
  install -m 0755 "$node" "$runtime/runtime/bin/node"
  (cd -- "$repo" && NODE_OPTIONS='' npm pack --silent --pack-destination "$work" >/dev/null)
  tarball=$(ls "$work"/zukujs-cli-*.tgz)
  NODE_OPTIONS='' PATH="$runtime/runtime/bin:$PATH" npm install --global --ignore-scripts --no-audit --no-fund --update-notifier=false \
    --prefix "$runtime/npm" --cache "$work/npm-cache" "$tarball" >&2
  sha=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
  printf '{"schema":"zukujs-user-install/1","version":"%s","sha256":"%s","node":"%s"}\n' "$version" "$sha" "$runtime/runtime/bin/node" > "$runtime/install.json"
  chmod 0600 "$runtime/install.json"
  if [[ ! -f "$runtime/npm/lib/node_modules/@zukujs/cli/lib/studio-host.mjs" ]]; then
    printf 'Note: the packed CLI has no lib/studio-host.mjs yet; Studio will report STUDIO_RUNTIME_UNTRUSTED until the host entry ships.\n' >&2
  fi
  if [[ $runs_here -eq 1 ]]; then "$contents/MacOS/ZukuStudio" --stdio-test; fi
fi

if [[ $register -eq 1 ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
  printf 'Registered with LaunchServices: %s\n' "$app"
fi
printf 'Built %s (%s, version %s)\n' "$app" "$arch" "$version"
