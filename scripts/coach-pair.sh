#!/usr/bin/env bash
# Print a single-use pairing code (5 min) for the iPhone app. Pass --url https://<mac>.local:8765 --ca <ca.crt> in TLS mode.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach pair "$@"
