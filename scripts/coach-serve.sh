#!/usr/bin/env bash
# Start the backend (localhost:8765). Extra arguments go to `python -m coach serve`, e.g.
#   bash scripts/coach-serve.sh --lan --tls-cert services/coach/.runtime/tls/server.crt --tls-key services/coach/.runtime/tls/server.key
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach serve "$@"
