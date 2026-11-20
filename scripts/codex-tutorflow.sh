#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Preserve the user's normal Codex home, authentication and permission settings.
PATH="$HOME/.local/npm/bin:$PATH"
export PATH
exec codex -C "$PWD" "$@"
