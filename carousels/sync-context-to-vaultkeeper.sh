#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="/Users/ericcromartie/Documents/Development/carousels-agent"
BRAND_ROOT="/Users/ericcromartie/Desktop/Rising Tide Team Teamplates"
TARGET="/Users/ericcromartie/Documents/Development/Vaultkeeper/6-Agent/Contexts/carousels-agent"

mkdir -p "$TARGET"

cp -f "$SOURCE_ROOT/AGENTS.md" "$TARGET/"
cp -f "$SOURCE_ROOT/CLAUDE.md" "$TARGET/"
cp -f "$SOURCE_ROOT/brand/_brand.css" "$TARGET/carousels-agent-_brand.css"
cp -f "$BRAND_ROOT/# Rising Tides — Brand Kit Design Specs.md" "$TARGET/"
cp -f "$BRAND_ROOT/# Midnight Press Carousel — Template Spec.md" "$TARGET/"
cp -f "$BRAND_ROOT/# Artist Case-File Carousel.md" "$TARGET/"

cat > "$TARGET/Context Sync.md" <<EOF
# Carousels Agent — Context Sync

This folder mirrors key context docs used by the carousels-agent project.

## Sources
- $SOURCE_ROOT/AGENTS.md
- $SOURCE_ROOT/CLAUDE.md
- $SOURCE_ROOT/brand/_brand.css
- $BRAND_ROOT/# Rising Tides — Brand Kit Design Specs.md
- $BRAND_ROOT/# Midnight Press Carousel — Template Spec.md
- $BRAND_ROOT/# Artist Case-File Carousel.md

## Last Sync
- $(date +%F)

## Notes
- This is a duplicated context set for Vaultkeeper/Obsidian workflow.
- Re-sync whenever source docs change.
EOF

echo "Synced context docs to: $TARGET"
