#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/daemon.py" --check
bash -n "$ROOT/cb" "$ROOT/install.sh"
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/extension/background.js"
  node --check "$ROOT/extension/popup.js"
  node -e '
const { withTimeout, dragEndpoints, commandTimeoutMs } = require(process.argv[1]);
withTimeout(new Promise(() => {}), 1, "timeout").then(
  () => process.exit(1),
  (e) => { if (e.message !== "timeout") throw e; }
);
const a = dragEndpoints({ coordinate: [1, 2], endCoordinate: [3, 4] }, 0, () => null);
if (!a.from || a.from[0] !== 1 || !a.to || a.to[0] !== 3) throw new Error("alias endCoordinate failed");
const b = dragEndpoints({ from_coordinate: [5, 6], to_coordinate: [7, 8] }, 0, () => null);
if (b.from[0] !== 5 || b.to[0] !== 7) throw new Error("from/to_coordinate failed");
if (commandTimeoutMs({ action: "click" }) !== 90000) throw new Error("default timeout");
if (commandTimeoutMs({ action: "batch" }) !== 180000) throw new Error("batch timeout");
console.log("js helpers ok");
' "$ROOT/extension/background.js"
else
  echo "node not found; skipped JavaScript syntax check"
fi
python3 -m json.tool "$ROOT/extension/manifest.json" >/dev/null

# CLI formatting/flag behavior, with curl stubbed so no live daemon is needed.
(
  FAKE_RESPONSE='{"id":"x","ok":true,"data":[{"id":7,"title":"A B","url":"https://a.test/x"},{"id":8,"title":"Other","url":"https://b.test"}]}'
  export FAKE_RESPONSE
  curl() { printf '%s' "$FAKE_RESPONSE"; }
  export -f curl

  out=$("$ROOT/cb" --brief tabs a.test)
  [[ "$out" == $'7\tA B\thttps://a.test/x' ]] || { echo "tabs --brief failed: $out" >&2; exit 1; }

  FAKE_RESPONSE='{"id":"x","ok":true,"data":{"path":"/tmp/shot.jpg","elements":[{"id":1}]}}'
  out=$("$ROOT/cb" capture --brief)
  [[ "$out" == "{\"ok\":true,\"elements\":1,\"index\":\"$ROOT/last.txt\",\"shot\":\"/tmp/shot.jpg\"}" ]] || {
    echo "capture --brief failed: $out" >&2
    exit 1
  }

  FAKE_RESPONSE='{"id":"x","ok":true,"data":{"text":"hello","textPath":"/tmp/read.txt"}}'
  out=$("$ROOT/cb" read --text)
  [[ "$out" == "hello" ]] || { echo "read --text failed: $out" >&2; exit 1; }
)

echo "all checks passed"
