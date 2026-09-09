#!/usr/bin/env bash
# Publish the fork: fast-forward main to the current branch, push, and
# dispatch the deploy workflow. On this fork GitHub has not been creating
# workflow runs for push events (only workflow_dispatch runs appear), so
# the dispatch is what actually deploys. Requires `gh` logged in.
set -euo pipefail
cd "$(dirname "$0")/.."
branch=$(git branch --show-current)
git push --no-verify origin "$branch"
git branch -f main "$branch"
git push --no-verify origin main
gh workflow run ci-and-deploy.yml --ref main
echo "Dispatched; watch with: gh run watch \$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "Site: https://egirard.github.io/jaipur/tt/?bot=1"
