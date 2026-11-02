#!/bin/sh
# One-time head-to-head against cpntodd/HOI4-MCP (decision M-7). Project tooling.
#
#   scripts/bench/hoi4-mcp/run.sh <game folder> <game user folder> <work folder>
#
# Clones HOI4-MCP at the pinned commit as data only (none of its code runs on the host), builds
# one image holding both servers, and runs driver.py in it with no network, the game and the
# game's user folder (mods, logs) read-only, and only <work folder>/out writable.
# Results: <work folder>/out/results.json.
set -eu

commit=e7101f6bee5b6536c965e05935659af4a7220cc5
game=$1
user=$2
work=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../../.." && pwd)

host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

mkdir -p "$work/context" "$work/out"
if [ ! -d "$work/context/theirs/.git" ]; then
  git -c core.autocrlf=false clone --quiet --no-checkout https://github.com/cpntodd/HOI4-MCP "$work/context/theirs"
fi
git -C "$work/context/theirs" -c core.autocrlf=false checkout --quiet "$commit"
rm -rf "$work/context/ours"
mkdir -p "$work/context/ours"
git -C "$repo" -c core.autocrlf=false archive HEAD package.json npm-shrinkwrap.json tsconfig.json tsconfig.build.json src \
  | tar -x -C "$work/context/ours"

docker build --quiet -t hoi4-bench-h2h:"$commit" -f "$here/Dockerfile" "$work/context"

export MSYS_NO_PATHCONV=1
docker run --rm --network none \
  --cpus 4 --memory 8g \
  -v "$(host_path "$game"):/game:ro" \
  -v "$(host_path "$user"):/user:ro" \
  -v "$(host_path "$here"):/bench:ro" \
  -v "$(host_path "$work/out"):/out" \
  hoi4-bench-h2h:"$commit"
