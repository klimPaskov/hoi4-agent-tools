#!/bin/sh
# Nightly real-game benchmark (decision M-12). Project tooling, not a packaged command.
#
#   scripts/bench/nightly.sh [checkout]
#
# The checkout (default: the one holding this script) should be a worktree kept only for the
# benchmark, for example `git worktree add --detach ../hoi4-agent-tools-wt-bench origin/main`.
# The script moves it to origin/main, reinstalls dependencies when the lockfile changed, runs the
# real suite and accepts the run as the new baseline when nothing regressed. Results, reports and
# the baseline stay in the benchmark data folder (HOI4_BENCH_DIR, else the platform default that
# scripts/bench/cli.ts names). The exit status is 1 when a case regressed.
set -eu

checkout=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
cd "$checkout"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "nightly benchmark: $checkout has local changes; refusing to move it to origin/main" >&2
  exit 2
fi
git fetch --quiet origin main
git -c advice.detachedHead=false checkout --quiet --detach origin/main

lock_hash=$(git hash-object npm-shrinkwrap.json)
stamp_file=node_modules/.bench-lock-hash
if [ ! -f "$stamp_file" ] || [ "$(cat "$stamp_file")" != "$lock_hash" ]; then
  npm ci --no-audit --no-fund
  printf '%s\n' "$lock_hash" > "$stamp_file"
fi

npm run --silent bench -- --suite real --watch-game --accept-if-clean
