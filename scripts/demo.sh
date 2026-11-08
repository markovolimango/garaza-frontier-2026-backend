#!/usr/bin/env bash
# One command for the whole demo: brain, frontend, coach, coach→brain bridge and the camera.
#
#   bash scripts/demo.sh --camera 1        everything; the camera at OpenCV index 1 (find it: bash vision/run.sh --list-cameras)
#   bash scripts/demo.sh --no-camera       without the Mac camera (e.g. the iPhone app sends poses)
#   bash scripts/demo.sh --fresh           a new session instead of continuing the saved one (runs, reports, deck)
#
# Options:
#   --camera N | --no-camera   camera index (or DEMO_CAMERA=N in the environment / .env)
#   --fresh                    start a new session (the old one stays in data/sessions); without it BRAIN_FRESH
#                              from the environment / .env decides
#   --force                    vignette on every coach suggestion during a run, not only the run's targets
#   --no-coach                 brain + frontend only (no coach, bridge, camera)
#   --takeover                 stop whatever already listens on the demo ports (old terminals), and an old
#                              `coach brain-bridge`, instead of refusing
#   --no-open                  don't open the browser
#   --dev                      brain in watch mode (restarts on every code change; not for the stage)
# Ports: BRAIN_PORT (8787, or from .env), FRONTEND_PORT (5174), COACH_PORT (8765).
#
# The brain, frontend, coach and bridge are restarted if they crash (the brain continues the saved
# session). Ctrl+C stops everything; the brain saves the session first. Logs: data/demo-logs/<time>/.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRAIN_PORT="${BRAIN_PORT:-}"
[[ -z "$BRAIN_PORT" && -f .env ]] && BRAIN_PORT="$(sed -n 's/^BRAIN_PORT=\([0-9]*\).*/\1/p' .env | tail -1)"
BRAIN_PORT="${BRAIN_PORT:-8787}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
COACH_PORT="${COACH_PORT:-8765}"
CAMERA="${DEMO_CAMERA:-}"
[[ -z "$CAMERA" && -f .env ]] && CAMERA="$(sed -n 's/^DEMO_CAMERA=\([0-9]*\).*/\1/p' .env | tail -1)"
FRESH=0 FORCE=0 COACH=1 TAKEOVER=0 OPEN=1 DEV=0 NO_CAMERA=0

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --camera) [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "--camera needs an index, e.g. --camera 1" >&2; exit 2; }; CAMERA="$2"; shift ;;
    --no-camera) NO_CAMERA=1 ;;
    --fresh) FRESH=1 ;;
    --force) FORCE=1 ;;
    --no-coach) COACH=0 ;;
    --takeover) TAKEOVER=1 ;;
    --no-open) OPEN=0 ;;
    --dev) DEV=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[[ $NO_CAMERA == 1 || $COACH == 0 ]] && CAMERA=""

# ---------------------------------------------------------------- output
if [[ -t 1 ]]; then B=$'\033[1m' R=$'\033[0m' RED=$'\033[31m' GRN=$'\033[32m' YEL=$'\033[33m' DIM=$'\033[2m'; else B="" R="" RED="" GRN="" YEL="" DIM=""; fi
say()  { printf '%s[demo]%s %s\n' "$B" "$R" "$*"; }
warn() { printf '%s[demo] %s%s\n' "$YEL" "$*" "$R"; }
die()  { printf '%s[demo] %s%s\n' "$RED" "$*" "$R" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME/.local/node/bin" /opt/homebrew/bin /usr/local/bin; do [[ -x "$d/node" ]] && export PATH="$d:$PATH" && break; done
fi
command -v node >/dev/null 2>&1 || die "node not found (install Node 22+, or put it on PATH)"
if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); elif command -v corepack >/dev/null 2>&1; then PNPM=(corepack pnpm); else die "pnpm not found (corepack enable)"; fi
if [[ ! -d node_modules || ! -d apps/frontend/node_modules ]]; then
  say "installing node dependencies (once)…"
  "${PNPM[@]}" install --frozen-lockfile || die "pnpm install failed"
fi
if [[ $COACH == 1 && ! -x services/coach/.venv/bin/python ]]; then die "the coach is not set up: bash scripts/coach-setup.sh (or run with --no-coach)"; fi
if [[ -n "$CAMERA" && ! -x vision/.venv/bin/python ]]; then die "the camera is not set up: bash vision/setup.sh (or run with --no-camera)"; fi
if [[ $COACH == 1 && -z "$CAMERA" && $NO_CAMERA == 0 ]]; then
  warn "camera off: add --camera N (find N with: bash vision/run.sh --list-cameras), or --no-camera to silence this"
fi

# ports: refuse (or with --takeover, stop) whatever already listens there, e.g. services left in old terminals
PORTS=("$BRAIN_PORT:brain" "$FRONTEND_PORT:frontend")
[[ $COACH == 1 ]] && PORTS+=("$COACH_PORT:coach")
busy=0
for entry in "${PORTS[@]}"; do
  port="${entry%%:*}" name="${entry#*:}"
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u | paste -sd, -)"
  [[ -z "$pids" ]] && continue
  if [[ $TAKEOVER == 1 ]]; then
    warn "port $port ($name) is taken; stopping: $(ps -o command= -p "$pids" 2>/dev/null | cut -c1-100 | paste -sd';' -)"
    kill ${pids//,/ } 2>/dev/null
    for _ in $(seq 1 40); do lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.25; done
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 && die "port $port is still taken (pids: $pids)"
  else
    printf '%s[demo] port %s (%s) is already in use by:%s\n' "$RED" "$port" "$name" "$R" >&2
    ps -o pid=,command= -p "$pids" 2>/dev/null | cut -c1-160 | sed 's/^/         /' >&2
    busy=1
  fi
done
# a bridge from an old terminal (scripts/coach-brain-bridge.sh) holds no port, but would take the brain's
# sensor role from the demo's own bridge
if [[ $COACH == 1 ]]; then
  old="$(pgrep -f 'coach brain-bridge' 2>/dev/null | paste -sd' ' -)"
  if [[ -n "$old" && $TAKEOVER == 1 ]]; then
    warn "stopping an old coach bridge (pids $old)"
    kill $old 2>/dev/null
    for _ in $(seq 1 20); do pgrep -f 'coach brain-bridge' >/dev/null 2>&1 || break; sleep 0.25; done
  elif [[ -n "$old" ]]; then
    printf '%s[demo] a coach bridge is already running:%s\n' "$RED" "$R" >&2
    ps -o pid=,command= -p "${old// /,}" 2>/dev/null | cut -c1-160 | sed 's/^/         /' >&2
    busy=1
  fi
fi
[[ $busy == 1 ]] && die "stop those (close their terminals), or run again with --takeover"

# ---------------------------------------------------------------- processes
LOGS="$ROOT/data/demo-logs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOGS"
STOP="$LOGS/.stopping"

# every process below PID (not PID itself)
descendants() {
  ps -A -o pid= -o ppid= | awk -v root="$1" '
    { parent[$1] = $2 }
    END { for (p in parent) { q = p; while ((q in parent) && q != root && q > 1) q = parent[q]; if (q == root && p != root) print p } }'
}

cleanup() {
  trap - INT EXIT
  trap '' TERM
  touch "$STOP"
  echo
  say "stopping (the brain saves the session)…"
  # only what this script started: the process group also holds the parent (`pnpm demo` would exit 143)
  kill -TERM $(descendants $$) 2>/dev/null
  wait 2>/dev/null
  say "stopped. Logs: ${LOGS#$ROOT/}"
}
trap cleanup INT TERM EXIT

# supervise NAME COLOR RESTARTS CMD...: run CMD with prefixed output (and a log file); restart it up to
# RESTARTS times when it exits with an error (exit 0 = stopped on purpose, e.g. Q in the camera window).
supervise() {
  local name="$1" color="$2" restarts="$3"; shift 3
  (
    local n=0 code
    while :; do
      "$@" < /dev/null 2>&1 | tee -a "$LOGS/$name.log" | awk -v p="$(printf '\033[%sm%-9s\033[0m' "$color" "$name")" '{ print p " " $0; fflush() }'
      code=${PIPESTATUS[0]}
      # Ctrl+C reaches every process at once: give the main script a moment to mark the stop, and treat
      # an exit by SIGINT/SIGTERM (130/143) as a stop too (background subshells ignore SIGINT themselves).
      sleep 0.5
      [[ -e "$STOP" || $code == 0 || $code == 130 || $code == 143 ]] && exit 0
      if [[ $n -ge $restarts ]]; then printf '%s[demo] %s exited (%s); not restarting%s\n' "$RED" "$name" "$code" "$R"; exit "$code"; fi
      n=$((n + 1))
      printf '%s[demo] %s exited (%s); restart %s/%s in 2 s%s\n' "$YEL" "$name" "$code" "$n" "$restarts" "$R"
      sleep 2
    done
  ) &
}

wait_http() {   # URL NAME SECONDS
  local i
  for ((i = 0; i < $3 * 4; i++)); do
    curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null && return 0
    [[ -e "$STOP" ]] && return 1
    sleep 0.25
  done
  warn "$2 did not answer at $1 within $3 s (see ${LOGS#$ROOT/}/$2.log)"
  return 1
}

# The brain: --fresh only on the first start (else BRAIN_FRESH from the environment / .env); a crash
# restart continues the session.
run_brain() {
  local vars=("BRAIN_PORT=$BRAIN_PORT")
  if [[ -e "$LOGS/.brain-started" ]]; then vars+=(BRAIN_FRESH=0)
  elif [[ $FRESH == 1 ]]; then vars+=(BRAIN_FRESH=1); fi
  touch "$LOGS/.brain-started"
  if [[ $DEV == 1 ]]; then env "${vars[@]}" "${PNPM[@]}" --silent dev:brain
  else env "${vars[@]}" "${PNPM[@]}" --silent --filter @coach/brain start; fi
}
run_frontend() {
  VITE_SIGNAL_SOURCE=brain VITE_BRAIN_URL="http://localhost:$BRAIN_PORT" \
    "${PNPM[@]}" --silent --filter tanstack_start_ts exec vite dev --port "$FRONTEND_PORT" --strictPort
}
run_bridge() {
  local extra=()
  [[ $FORCE == 1 ]] && extra+=(--force)
  bash scripts/coach-brain-bridge.sh --url "http://127.0.0.1:$COACH_PORT" --brain "http://127.0.0.1:$BRAIN_PORT" ${extra[@]+"${extra[@]}"}
}

say "starting${DIM} (logs: ${LOGS#$ROOT/})${R}"
supervise brain 35 20 run_brain
supervise frontend 36 20 run_frontend
wait_http "http://127.0.0.1:$BRAIN_PORT/health" brain 60 || exit 1
if [[ $COACH == 1 ]]; then
  supervise coach 33 20 bash scripts/coach-serve.sh --port "$COACH_PORT" --log-level warning
  wait_http "http://127.0.0.1:$COACH_PORT/health" coach 60 || exit 1
  supervise bridge 34 20 run_bridge
  if [[ -n "$CAMERA" ]]; then
    supervise camera 32 3 bash vision/run.sh --camera "$CAMERA" --coach "http://127.0.0.1:$COACH_PORT"
  fi
fi
wait_http "http://localhost:$FRONTEND_PORT/" frontend 90 || exit 1
# warm Vite up: the first visit of each screen compiles it; do that now, not in front of the audience
for route in / /presenter /judges /report; do curl -fsS -o /dev/null --max-time 60 "http://localhost:$FRONTEND_PORT$route" 2>/dev/null; done

session="$(curl -fsS --max-time 2 "http://127.0.0.1:$BRAIN_PORT/api/session" 2>/dev/null || true)"
echo
printf '%s  ready%s\n' "$GRN$B" "$R"
printf '  app        http://localhost:%s/\n' "$FRONTEND_PORT"
printf '  brain      http://127.0.0.1:%s   session %s\n' "$BRAIN_PORT" "$(sed -n 's/.*"sessionId":"\([^"]*\)".*"phase":"\([a-z]*\)".*"runs":\([0-9]*\).*/\1 (\2, \3 runs)/p' <<<"$session")"
if [[ -z "${GEMINI_API_KEY:-}" ]] && ! grep -qE '^GEMINI_API_KEY=.+' .env 2>/dev/null; then
  printf '  JJ         %sfake (no GEMINI_API_KEY in .env): the loop works, JJ is silent%s\n' "$YEL" "$R"
fi
if [[ $COACH == 1 ]]; then
  printf '  coach      http://127.0.0.1:%s   bridge → brain%s\n' "$COACH_PORT" "$([[ $FORCE == 1 ]] && echo ' (--force: vignette on every suggestion)')"
  printf '  camera     %s\n' "$([[ -n "$CAMERA" ]] && echo "index $CAMERA (video window)" || echo "${YEL}off${R}")"
fi
printf '  %sCtrl+C stops everything. New session: --fresh, or curl -X POST localhost:%s/api/session/reset%s\n\n' "$DIM" "$BRAIN_PORT" "$R"
[[ $OPEN == 1 ]] && command -v open >/dev/null 2>&1 && open "http://localhost:$FRONTEND_PORT/"

wait
