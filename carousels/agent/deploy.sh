#!/usr/bin/env bash
# Deploy the agent binary to ~/bin and restart the launchd service.
#
# Why ~/bin (not target/release): macOS launchd-spawned processes hang in
# dyld __open() when loading freshly-built executables from cargo's target/
# directory (provenance-tracking interaction). Copying to ~/bin/ produces a
# fresh inode that dyld can load without the hang.
#
# Run this after every `cargo build --release` you want to ship.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${REPO_ROOT}/agent/target/release/rt-carousel-agent"
DST="${HOME}/bin/rt-carousel-agent"
PLIST="${HOME}/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist"
LABEL="com.risingtides.rt-carousel-agent"

if [[ ! -x "$SRC" ]]; then
    echo "error: $SRC not found — run 'cargo build --release' first" >&2
    exit 1
fi

mkdir -p "${HOME}/bin"
cp "$SRC" "$DST"
chmod +x "$DST"

# Ad-hoc codesign so Gatekeeper's launchd path doesn't object.
codesign --force --sign - "$DST" >/dev/null

echo "deployed → $DST ($(stat -f%z "$DST") bytes)"

# Restart the launchd service if it's loaded; otherwise bootstrap it.
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
    echo "kickstarted ${LABEL}"
else
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "bootstrapped ${LABEL}"
fi

# Brief wait then probe /health.
sleep 4
if curl -sS --max-time 3 http://127.0.0.1:7677/health | grep -q '"ok":true'; then
    echo "✓ /health green"
else
    echo "✗ /health did not respond — check /tmp/rt-carousel-agent.err"
    tail -10 /tmp/rt-carousel-agent.err
    exit 1
fi
