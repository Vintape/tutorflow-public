#!/bin/bash
# Complete normal user-profile setup from an ordinary terminal, without sudo.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --check ]]; then
  node --version
  npm --version
  codex --version
  npm config get prefix
  fish -c 'type -a playwright-cli; contains -- $HOME/.local/npm/bin $PATH'
  exit
fi
if [[ "${1:-}" != --apply ]]; then
  echo 'Usage: bash scripts/setup-codex-user.sh --check|--apply' >&2
  exit 2
fi
# Test both destinations before changing user configuration.
python3 - <<'PY'
from pathlib import Path
import tempfile
for p in [Path.home()/'.config/fish', Path.home()/'.codex']:
    try:
        p.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=p):
            pass
    except OSError as error:
        raise SystemExit(f'Cannot write {p}: {error.strerror}. Run from an ordinary user terminal.')
PY
case "$(npm config get prefix)" in
  /usr|/usr/*|/opt|/opt/*)
    mkdir -p "$HOME/.local/npm"
    npm config set prefix "$HOME/.local/npm"
    ;;
esac
tutorflow_prefix="$(npm config get prefix)"
export PATH="$tutorflow_prefix/bin:$HOME/.local/npm/bin:$PATH"
fish -c 'fish_add_path --universal $argv[1]' -- "$tutorflow_prefix/bin"
if ! command -v playwright-cli >/dev/null 2>&1; then
  npm install -g @playwright/cli@latest
fi
playwright-cli --version
# Choose actual selectors advertised by this Codex installation.
for tutorflow_name in build-web-apps superpowers codex-security; do
  tutorflow_selection="$(codex plugin list --available --json | python3 -c '
import json,sys
d=json.load(sys.stdin); name=sys.argv[1]
installed=[p for p in d.get("installed",[]) if p.get("name")==name]
if installed:
    print("installed" if installed[0].get("enabled") else installed[0]["pluginId"])
else:
    rows=[p for p in d.get("available",[]) if p.get("name")==name]
    rows.sort(key=lambda p: (p.get("marketplaceName")!="openai-curated",p.get("pluginId","")))
    print(rows[0]["pluginId"] if rows else "unavailable")
' "$tutorflow_name")"
  case "$tutorflow_selection" in
    installed) echo "$tutorflow_name already installed" ;;
    unavailable) echo "$tutorflow_name unavailable in configured marketplaces" >&2 ;;
    *) codex plugin add "$tutorflow_selection" --json ;;
  esac
done
# Context7 MCP is already project-scoped; avoid a second Context7 server/plugin.
fish -c 'type -a playwright-cli; playwright-cli --version'
echo 'User PATH/plugins checked. Context7/OpenAI Docs MCP: project .codex/config.toml.'
echo 'Verify real MCP calls: python3 scripts/check-dev-tools.py --mcp'
