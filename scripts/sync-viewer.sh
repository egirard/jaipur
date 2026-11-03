#!/usr/bin/env bash
# Vendor the ARViewer phone page into this table's static files, so the
# table serves it itself at <table>/viewer/ and one deploy of the table
# publishes both (docs/CONNECTIVITY.md, "The bundled viewer"). Run after
# changing ARViewer's public/viewer or public/shared, then commit the copy.
#   bun run sync:viewer            # from ../ARViewer
#   ARVIEWER=/path/to/ARViewer bun run sync:viewer
set -euo pipefail
cd "$(dirname "$0")/.."
src="${ARVIEWER:-../ARViewer}"
[ -f "$src/public/viewer/index.html" ] || { echo "no ARViewer checkout at $src (set ARVIEWER=)" >&2; exit 1; }
hash=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)
dirty=$(git -C "$src" status --porcelain -- public/viewer public/shared 2>/dev/null | head -1)
rm -rf static/viewer static/shared
mkdir -p static/viewer static/shared
cp "$src"/public/viewer/* static/viewer/
cp "$src"/public/shared/* static/shared/
# The build stamp the Pages workflow substitutes; here it names the ARViewer commit.
stamp="$hash${dirty:++}·table"
grep -rl __BUILD__ static/viewer --include=*.html | xargs -r sed -i "s/__BUILD__/$stamp/g"
echo "$hash${dirty:++}" > static/viewer/ARVIEWER_COMMIT
echo "vendored ARViewer $stamp into static/viewer and static/shared"
