#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
PATH="$HOME/.local/npm/bin:$PATH"
export PATH
export NO_UPDATE_NOTIFIER=1
case "${1:-}" in
  --version|--help)
    if command -v playwright-cli >/dev/null 2>&1; then
      exec playwright-cli "$@"
    fi
    exec ./node_modules/.bin/playwright cli "$@"
    ;;
esac
export XDG_CACHE_HOME="$PWD/.data/tool-cache"
mkdir -p "$XDG_CACHE_HOME" .data/playwright-cli
# System Chromium avoids downloading another browser or writing the home cache.
# An explicit executable can be supplied when Chromium is installed elsewhere.
tutorflow_browser="${TUTORFLOW_BROWSER_EXECUTABLE:-}"
if [ -z "$tutorflow_browser" ]; then
  tutorflow_browser="$(command -v chromium || command -v google-chrome || true)"
fi
if [ -z "$tutorflow_browser" ]; then
  echo 'Chromium not found. Set TUTORFLOW_BROWSER_EXECUTABLE to its executable.' >&2
  exit 1
fi
node --input-type=module - "$tutorflow_browser" "$PWD" <<'JS'
import { writeFileSync } from 'node:fs';
const [executablePath, root] = process.argv.slice(2);
writeFileSync(`${root}/.data/playwright-cli/config.json`, JSON.stringify({
  browser: { browserName: 'chromium', launchOptions: { executablePath, headless: true, chromiumSandbox: true } },
  outputDir: `${root}/.data/playwright-cli/output`,
}, null, 2) + '\n');
JS
tutorflow_command=
for tutorflow_arg do
  case "$tutorflow_arg" in
    -*) ;;
    *) tutorflow_command="$tutorflow_arg"; break ;;
  esac
done
# Only browser launch accepts --config; commands such as close and snapshot do not.
if [ "$tutorflow_command" = open ]; then
  set -- "$@" --config="$PWD/.data/playwright-cli/config.json"
fi
if command -v playwright-cli >/dev/null 2>&1; then
  exec playwright-cli "$@"
fi
# The project's pinned Playwright also exposes the official CLI, without npx.
exec ./node_modules/.bin/playwright cli "$@"
