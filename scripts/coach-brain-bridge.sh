#!/usr/bin/env bash
# Connect the coach backend (this repo, :8765) to the brain (garaza-frontier-2026-backend, :8787) over WebSockets.
# Both must be running (the bridge retries until they are). Extra arguments go to `python -m coach brain-bridge`:
#   bash scripts/coach-brain-bridge.sh [--brain http://127.0.0.1:8787] [--force] [--no-vignette]
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach brain-bridge "$@"
