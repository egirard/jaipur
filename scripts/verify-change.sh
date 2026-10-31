#!/usr/bin/env bash
# The change gate the Git hooks and CI run: static checks, unit tests and
# the production build — everything the supported product (the AR
# tabletop) needs, with no Firebase emulator. The Firestore rules tests and
# the two-browser Playwright scenarios belong to the deprecated Firebase
# channel (DEPRECATIONS.md) and run on request: bun run verify:legacy.
set -euo pipefail
if [[ -z "${IN_NIX_SHELL:-}" ]]; then
  exec nix develop --command bun run verify:change
fi
git diff --cached --check
git diff --check
bun run check
bun run test:unit
bun run build
