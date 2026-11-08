#!/usr/bin/env bash
# Start the optional macOS helper (speech synthesis + Foundation Models) on 127.0.0.1:8766.
# The backend finds it automatically and reads the shared token file. Add --silent to render speech
# without playing it.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
cd "$COACH_ROOT/apple"
log="$(mktemp "${TMPDIR:-/tmp}/assistant-build.XXXXXX")"
if ! swift build --product MacAssistant >"$log" 2>&1; then
  grep -E "error:" "$log" >&2 || tail -n 40 "$log" >&2
  rm -f "$log"
  echo "MacAssistant build failed; not starting a stale binary." >&2
  exit 1
fi
grep -E "Build complete" "$log" || true
rm -f "$log"
BIN="$(swift build --show-bin-path)"
mkdir -p "$COACH_DIR/.runtime"
exec "$BIN/MacAssistant" --token-file "$COACH_DIR/.runtime/assistant_token" "$@"
