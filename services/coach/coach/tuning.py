"""Camera tuning: the threshold file and a live readout of the body measures next to their thresholds.

services/coach/tuning.json (or $COACH_TUNING_FILE, or --tuning) holds SessionConfig overrides, e.g.
{"pose": {"face_touch_max_distance": 0.3}, "coaching": {"rules": {"body.face_touch": {"sustain_s": 1.5}}}}.
Keys starting with "_" are comments. The brain bridge passes it as the config of every session it
creates for a brain run (re-read each time); `coach tune` passes it to its own session and restarts
that session when the file is saved. A broken file is reported and the defaults are used.

  python -m coach tune [--url http://127.0.0.1:8765] [--tuning PATH] [--no-create] [--once]

The readout polls the REST snapshot of the newest active session (body metrics, every rule's
armed/pending/fired state, the active suggestion and the session's effective config), so it follows
the bridge's per-run sessions by itself. Without an active session it creates a "tune" session (unless
--no-create) that `vision/run.sh --coach` joins; it stops that session when a newer one appears (a brain
run, so the camera moves over) and on exit. Plain ANSI, no dependencies.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from pydantic import ValidationError

from coach.config import SERVICE_DIR, merge_config

DEFAULT_TUNING_FILE = SERVICE_DIR / "tuning.json"
TUNE_LABEL = "tune"


class TuningError(ValueError):
    pass


def tuning_path(arg: str | None) -> Path | None:
    """--tuning PATH > $COACH_TUNING_FILE > services/coach/tuning.json; an empty string disables it."""
    value = arg if arg is not None else os.environ.get("COACH_TUNING_FILE")
    if value is None:
        return DEFAULT_TUNING_FILE
    return Path(value).expanduser() if value.strip() else None


def _strip_comments(value):
    if isinstance(value, dict):
        return {k: _strip_comments(v) for k, v in value.items() if not str(k).startswith("_")}
    return value


def read_tuning(path: Path) -> dict | None:
    """Overrides from the file (None if it does not exist). Raises TuningError with a readable reason."""
    from coach.coaching import RULE_IDS

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise TuningError(f"not valid JSON (line {exc.lineno}, column {exc.colno}: {exc.msg})") from exc
    except OSError as exc:
        raise TuningError(f"cannot read it ({exc.strerror})") from exc
    if not isinstance(raw, dict):
        raise TuningError("the top level must be an object like {\"pose\": {...}}")
    overrides = _strip_comments(raw)
    try:
        config = merge_config(overrides)
    except ValidationError as exc:
        problems = [f"{'.'.join(str(p) for p in e['loc']) or 'config'}: {e['msg']}" for e in exc.errors()]
        raise TuningError("; ".join(problems[:5])) from exc
    unknown = sorted(set(config.coaching.rules) - set(RULE_IDS))
    if unknown:
        raise TuningError(f"unknown coaching rules {unknown} (known: {', '.join(RULE_IDS)})")
    return overrides


def load_tuning(path: Path | None, log: logging.Logger | None = None) -> dict | None:
    """read_tuning that never raises: a broken file is logged and the defaults are used (None)."""
    if path is None:
        return None
    try:
        return read_tuning(path)
    except TuningError as exc:
        (log or logging.getLogger("coach.tuning")).error("%s is invalid: %s. Using the default thresholds.", path, exc)
        return None


# ----------------------------------------------------------------------------- readout
# (label, rule, measure, comparison that fires, pose threshold key, pose clear key)
MEASURES = (
    ("fast hands", "body.hand_movement_high", "wrist speed", ">", "hand_movement_high_per_s", "hand_movement_clear_per_s"),
    ("moving around", "body.torso_movement_high", "torso speed", ">", "torso_movement_high_per_s",
     "torso_movement_clear_per_s"),
    ("arms crossed", "body.arms_crossed", "arms_cross", ">=", "arms_crossed_min_cross", "arms_crossed_clear_cross"),
    ("hand at face", "body.face_touch", "face_touch_distance", "<=", "face_touch_max_distance",
     "face_touch_clear_distance"),
    ("looking down", "body.looking_down", "head_pitch_delta", ">=", "looking_down_min_delta", "looking_down_clear_delta"),
)
CLEAR_OP = {">": "<", ">=": "<", "<=": ">"}
RED, YELLOW, GREEN, MAGENTA, DIM, BOLD, RESET = "\x1b[31m", "\x1b[33m", "\x1b[32m", "\x1b[35m", "\x1b[2m", "\x1b[1m", "\x1b[0m"


def _epoch(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _num(value: float | None, width: int = 6) -> str:
    return f"{value:{width}.2f}" if isinstance(value, (int, float)) else f"{'-':>{width}}"


def measure_value(body: dict, measure: str) -> float | None:
    if measure == "wrist speed":
        speeds = [v for v in (body.get("wrist_movement") or {}).values() if isinstance(v, (int, float))]
        return max(speeds) if speeds else None
    if measure == "torso speed":
        return (body.get("torso_movement") or {}).get("value")
    return (body.get("posture") or {}).get(measure)


def _past(value: float, op: str, limit: float) -> bool:
    return value > limit if op == ">" else value >= limit if op == ">=" else value <= limit


def rule_state(status: dict, rule_cfg: dict, now: float | None) -> tuple[str, str]:
    """(text, color) for one rule from the snapshot's coaching.rules entry."""
    if not status.get("enabled", True):
        return "off", DIM
    fired = status.get("fired", 0)
    tail = f" · fired {fired}x" if fired else ""
    since = _epoch(status.get("pending_since_at"))
    last = _epoch(status.get("last_fired_at"))
    cooling = None if last is None or now is None else rule_cfg.get("cooldown_s", 0) - (now - last)
    if since is not None and now is not None:
        extra = "" if status.get("armed", True) else ", waits to clear"
        extra += f", cooldown {cooling:.0f}s" if cooling and cooling > 0 else ""
        if not extra and now - since >= rule_cfg.get("sustain_s", 0):
            extra = ", held back: another suggestion or the global interval"   # one at a time, 8 s apart
        return f"pending {now - since:.1f}/{rule_cfg.get('sustain_s', 0):.1f}s{extra}{tail}", YELLOW
    if not status.get("armed", True):
        return f"fired, waits to clear{tail}", MAGENTA
    if cooling and cooling > 0:
        return f"cooldown {cooling:.0f}s{tail}", MAGENTA
    return f"ready{tail}", GREEN


def render(snapshot: dict, *, header: list[str] = (), suggestions=(), color: bool = True) -> list[str]:
    """Readout lines for one session snapshot (GET /v1/sessions/{id}/snapshot)."""
    c = (lambda code, text: f"{code}{text}{RESET}") if color else (lambda code, text: text)
    session = snapshot.get("session") or {}
    config = session.get("config") or {}
    pose, rules_cfg = config.get("pose") or {}, (config.get("coaching") or {}).get("rules") or {}
    rules = (snapshot.get("coaching") or {}).get("rules") or {}
    body = snapshot.get("body") or {}
    posture = body.get("posture") or {}
    now = _epoch(snapshot.get("session_time"))
    window = body.get("window_s") or 0
    fps = body.get("frames_in_window", 0) / window if window else 0.0
    ref = body.get("reference") or {}
    lines = list(header)
    lines.append(f"{c(BOLD, 'session')} {session.get('session_id', '?')} \"{session.get('label') or ''}\" "
                 f"{session.get('state', '?')}  ·  camera: {body.get('tracking_state', '?')} ({body.get('quality', '?')})"
                 f" {body.get('mode') or ''} {fps:.1f} fps"
                 + (f" · torso {ref['value']:.0f} {ref.get('unit', '')}" if ref.get("value") else ""))
    lines.append("")
    lines.append(c(BOLD, f"  {'behaviour':<14}{'now':>7}  {'fires':<10}{'clears':<10}{'rule':<26}state"))
    for label, rule, measure, op, high_key, clear_key in MEASURES:
        value, high, clear = measure_value(body, measure), pose.get(high_key), pose.get(clear_key)
        shade = DIM
        if isinstance(value, (int, float)) and high is not None and clear is not None:
            shade = RED if _past(value, op, high) else GREEN if _past(value, CLEAR_OP[op], clear) else YELLOW
        state, state_color = rule_state(rules.get(rule) or {}, rules_cfg.get(rule) or {}, now)
        lines.append(f"  {label:<14}{c(shade, _num(value, 7))}  {op + ' ' + _num(high, 0):<10}"
                     f"{CLEAR_OP[op] + ' ' + _num(clear, 0):<10}{rule:<26}{c(state_color, state)}")
        if rule == "body.arms_crossed":
            cross, height = posture.get("wrist_cross") or {}, posture.get("wrist_height") or {}
            zone = {True: "yes", False: "no"}.get(posture.get("arms_in_zone"), "-")
            lines.append(c(DIM, f"      wrists across L{_num(cross.get('left'))} R{_num(cross.get('right'))} · "
                                f"height L{_num(height.get('left'))} R{_num(height.get('right'))} · in chest zone "
                                f"{pose.get('arms_crossed_min_height', 0):.2f}-{pose.get('arms_crossed_max_height', 0):.2f}: "
                                f"{zone}"))
        if rule == "body.looking_down":
            lines.append(c(DIM, f"      head pitch{_num(posture.get('head_pitch'))} ({posture.get('head_pitch_source') or '-'})"
                                f" · head-up reference{_num(posture.get('head_pitch_reference'))} (p"
                                f"{pose.get('head_pitch_reference_percentile', 0):.0f} over "
                                f"{pose.get('head_pitch_reference_window_s', 0):.0f}s, needs "
                                f"{pose.get('head_pitch_reference_min_s', 0):.0f}s)"))
    if posture.get("note"):
        lines.append(c(DIM, f"  {posture['note']}"))
    lines.append(c(DIM, f"  values in torso lengths (speeds per second), medians over {posture.get('window_s', '-')}s"
                        f" for postures · red = past 'fires', yellow = between, green = cleared"))
    lines.append("")
    lines.append(c(BOLD, "  last suggestions"))
    for when, fb in list(suggestions)[-5:] or [(None, None)]:
        lines.append(f"  {when} {fb.get('rule_id', ''):<26}{fb.get('display_text', '')[:90]}" if fb
                     else c(DIM, "  none yet"))
    return lines


class Tuner:
    """Polls the newest active session and redraws the readout; owns a 'tune' session when there is none."""

    def __init__(self, url: str, tuning: Path | None, *, create: bool = True, interval: float = 0.5,
                 color: bool | None = None, ca_file: str | None = None):
        self.url, self.tuning, self.create, self.interval, self.ca_file = url, tuning, create, interval, ca_file
        self.color = sys.stdout.isatty() if color is None else color
        self.owned: str | None = None              # session id this tool created
        self.mtime = self._mtime()
        self.file_note = ""
        self.suggestions: deque[tuple[str, dict]] = deque(maxlen=5)
        self._seen: set[str] = set()

    def _mtime(self) -> float | None:
        try:
            return self.tuning.stat().st_mtime if self.tuning else None
        except OSError:
            return None

    def _client(self):
        from coach.client import CoachClient, operator_token
        return CoachClient(self.url, operator_token(), ca_file=self.ca_file)

    def _create(self, client) -> str:
        overrides = None
        if self.tuning:
            try:
                overrides = read_tuning(self.tuning)
                self.file_note = f"{self.tuning}: applied" if overrides is not None else f"{self.tuning}: not found, defaults"
            except TuningError as exc:
                self.file_note = f"{self.tuning} is INVALID, using the defaults: {exc}"
        session = client.create_session(label=TUNE_LABEL, timeline="live", config=overrides)
        client.action(session["session_id"], "start")
        return session["session_id"]

    def _stop_owned(self, client) -> None:
        if self.owned:
            try:
                client.action(self.owned, "stop")
            except Exception:   # already ended or gone
                pass
            self.owned = None

    def step(self, client) -> list[str]:
        """One poll: pick the session, handle file edits, return the readout lines."""
        active = [s for s in client.request("GET", "/v1/sessions")["sessions"] if s["state"] != "ended"]
        newest = max(active, key=lambda s: s["created_at"]) if active else None
        if self.owned and newest and newest["session_id"] != self.owned:
            self._stop_owned(client)     # a brain run started: let the camera move to its session
        mtime = self._mtime()
        if mtime != self.mtime:
            self.mtime = mtime
            if self.owned:
                self._stop_owned(client)  # restart with the new thresholds; the camera re-joins in ~2 s
                newest = None
            else:
                self.file_note = f"{self.tuning} changed: applies to the next session (next run)"
        if newest is None:
            if not self.create:
                return ["no active coach session: start a run in the app (with the bridge running), "
                        "or run without --no-create / --once to get a 'tune' session"]
            self.owned = self._create(client)
            newest = {"session_id": self.owned}
        snapshot = client.snapshot(newest["session_id"])
        active_fb = (snapshot.get("coaching") or {}).get("active")
        if active_fb and active_fb.get("feedback_id") not in self._seen:
            self._seen.add(active_fb["feedback_id"])
            self.suggestions.append((time.strftime("%H:%M:%S"), active_fb))
        owner = "this tool's session (saving the file restarts it)" if newest["session_id"] == self.owned \
            else "a session created elsewhere (bridge / app)"
        header = [f"coach tune · {self.url} · {time.strftime('%H:%M:%S')} · following {owner}",
                  f"tuning: {self.file_note or (str(self.tuning) if self.tuning else 'disabled (defaults)')}"]
        return render(snapshot, header=header, suggestions=self.suggestions, color=self.color)

    def run(self, once: bool = False) -> int:
        tty = sys.stdout.isatty() and not once
        if tty:
            sys.stdout.write("\x1b[?25l\x1b[2J")
        client = None
        try:
            while True:
                try:
                    client = client or self._client()
                    lines = self.step(client)
                except SystemExit as exc:   # no operator token yet: the coach has not started
                    lines, client = [f"waiting for the coach: {exc}"], None
                except Exception as exc:    # coach down or restarting (a restarted coach has no sessions)
                    lines, client = [f"coach not reachable at {self.url} ({type(exc).__name__}: {exc}); retrying"], None
                if tty:
                    sys.stdout.write("\x1b[H" + "".join(f"{line}\x1b[K\n" for line in lines) + "\x1b[J")
                else:
                    sys.stdout.write("\n".join(lines) + "\n\n")
                sys.stdout.flush()
                if once:
                    return 0
                time.sleep(self.interval)
        except KeyboardInterrupt:
            return 0
        finally:
            if tty:
                sys.stdout.write("\x1b[?25h\n")
            if self.owned:              # leave no orphan "tune" session for the camera to keep sending to
                try:
                    self._stop_owned(client or self._client())
                except (Exception, SystemExit):
                    pass
