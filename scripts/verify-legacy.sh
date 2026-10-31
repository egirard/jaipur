#!/usr/bin/env bash
# The deprecated Firebase channel's checks (DEPRECATIONS.md): Firestore
# rules tests and the Playwright scenarios, both under the Firebase
# emulators (Java 21+). Not part of the change gate; the tabletop scenario
# (tests/e2e/012) still expects the pre-relay join flow and the screenshot
# baselines date from August 2026, so expect red until they are reworked.
set -euo pipefail
if [[ -z "${IN_NIX_SHELL:-}" ]]; then
  exec nix develop --command bun run verify:legacy
fi
bun run test:rules
bun run test:e2e
