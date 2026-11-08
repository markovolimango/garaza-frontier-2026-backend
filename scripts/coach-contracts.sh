#!/usr/bin/env bash
# Regenerate contracts/ (JSON Schemas, OpenAPI, TypeScript types) from the Python wire models.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach contracts
