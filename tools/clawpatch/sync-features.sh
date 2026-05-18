#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$repo_root/tools/clawpatch/features"
dst="$repo_root/.clawpatch/features"

mkdir -p "$dst"
cp "$src"/*.json "$dst"/
echo "Synced $(find "$src" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ') curated Clawpatch feature(s)."
