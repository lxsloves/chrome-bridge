#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_HOME="${CHROME_BRIDGE_HOME:-$HOME/.chrome-bridge}"
SKILLS_HOME="${CHROME_BRIDGE_SKILLS_HOME:-$HOME/.agents/skills}"

link_dir() {
  local source="$1" target="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    local existing
    existing="$(cd "$target" 2>/dev/null && pwd -P || true)"
    if [[ "$existing" != "$source" ]]; then
      echo "refusing to replace existing path: $target" >&2
      exit 1
    fi
    return
  fi
  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
}

link_dir "$ROOT" "$BRIDGE_HOME"
link_dir "$ROOT/skills/chrome-bridge" "$SKILLS_HOME/chrome-bridge"

echo "installed bridge: $BRIDGE_HOME"
echo "installed agent skill: $SKILLS_HOME/chrome-bridge"
echo "next: $BRIDGE_HOME/cb start"
echo "then load this unpacked extension in Chrome: $BRIDGE_HOME/extension"
