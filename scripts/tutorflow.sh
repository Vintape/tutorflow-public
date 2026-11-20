#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
tutorflow_runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$tutorflow_runtime/node/bin/node" ]; then
    PATH="$tutorflow_runtime/node/bin:$tutorflow_runtime/bin/fallback:$PATH"
    export PATH
  else
    echo 'Установите Node.js 22.16 или новее и pnpm.' >&2
    exit 1
  fi
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -x "$tutorflow_runtime/bin/fallback/pnpm" ]; then
  PATH="$tutorflow_runtime/bin/fallback:$PATH"
  export PATH
fi
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm "$@"
elif command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm "$@"
else
  echo 'Установите pnpm: npm install -g pnpm@11.25.0' >&2
  exit 1
fi
