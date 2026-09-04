#!/usr/bin/env bash
# Wrapper for the Fastmail CLI.
# Resolves symlinks (from npm link) to find main.ts relative to the real script location.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"
TSX="$SCRIPT_DIR/../node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "fastmail: package-local tsx runtime is not installed" >&2
  exit 1
fi
exec "$TSX" "$SCRIPT_DIR/main.ts" "$@"
