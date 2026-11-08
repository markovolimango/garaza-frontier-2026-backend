#!/usr/bin/env bash
# Print the live event stream of the latest (or given) session:
#   bash scripts/coach-stream.sh [--session ses_...] [--types "coaching.*,speech.metrics"] [--after 120] [--full]
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach stream "$@"
