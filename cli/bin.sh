#!/usr/bin/env bash
# Wrapper for the Fastmail CLI.
# Resolves symlinks (from npm link) to find main.ts relative to the real script location.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"
exec npx tsx "$SCRIPT_DIR/main.ts" "$@"
