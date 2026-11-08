# Shared helpers for the coach scripts (sourced, not executed).
COACH_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COACH_DIR="$COACH_ROOT/services/coach"
COACH_PY="$COACH_DIR/.venv/bin/python"
coach_require_venv() {
  if [[ ! -x "$COACH_PY" ]]; then
    echo "services/coach/.venv is missing. Run first: bash scripts/coach-setup.sh" >&2
    exit 1
  fi
}
