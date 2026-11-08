"""Behaviour episodes: every occurrence of a behaviour, with a start and an end.

The coaching rules (coach/coaching.py) are throttled for live feedback: they wait (sustain), fire
once, need to clear before firing again, honour cooldowns and show one suggestion at a time. That
is right for nudging a presenter and wrong for a record of what happened. Episodes are the record:
several behaviours may be open at once, every occurrence counts, and each has its own times, so a
report can say "arms crossed 00:24-00:31" and a replay can jump to that moment.

The measures and thresholds are the coaching rules' own (body.metrics, config.pose): an episode is
"the rule's condition holds", with the rule's clear threshold as the exit (hysteresis). Only the
timing differs (config.episodes):
  - the condition must hold `min_on_s` before an episode starts; the start time is when it began;
  - it must be clear `min_off_s` before the episode ends; the end time is when it was last seen;
  - without a usable measure (joints hidden, tracking lost) an open episode survives
    `unknown_grace_s`, then ends with end_reason 'tracking_lost'. A missing measure never starts one.
Posture measures are medians over pose.posture_window_s (1 s), so a start lags the real onset by up
to about half of that. These are body positions and movements, not interpretations.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from coach.config import EpisodesConfig, EpisodeTiming, PoseConfig
from coach.timeutil import to_iso

KINDS = ("arms_crossed", "face_touch", "looking_down", "sway", "fast_hands")
MAX_EVIDENCE = 50


@dataclass(frozen=True)
class Reading:
    """One behaviour's current measure: its value, whether it meets the start threshold (enter) and
    whether it still meets the looser threshold an open episode needs to continue (stay)."""
    value: float
    enter: bool
    stay: bool


@dataclass(frozen=True)
class Measure:
    name: str
    unit: str
    active: str          # "above" or "below": which way the value goes while the behaviour is on
    enter: float
    exit: float


def measures(cfg: PoseConfig) -> dict[str, Measure]:
    return {
        "arms_crossed": Measure("wrist_cross", "torso_lengths", "above", cfg.arms_crossed_min_cross,
                                cfg.arms_crossed_clear_cross),
        "face_touch": Measure("wrist_to_face", "torso_lengths", "below", cfg.face_touch_max_distance,
                              cfg.face_touch_clear_distance),
        "looking_down": Measure("head_pitch_delta", "torso_lengths", "above", cfg.looking_down_min_delta,
                                cfg.looking_down_clear_delta),
        "sway": Measure("torso_movement", "torso_lengths_per_s", "above", cfg.torso_movement_high_per_s,
                        cfg.torso_movement_clear_per_s),
        "fast_hands": Measure("wrist_movement", "torso_lengths_per_s", "above", cfg.hand_movement_high_per_s,
                              cfg.hand_movement_clear_per_s),
    }


def readings(body: dict, cfg: PoseConfig) -> dict[str, Reading | None]:
    """body.metrics -> the current reading per behaviour (None = unknown). Same conditions as the rules."""
    if body.get("tracking_state") not in ("tracking", "partial"):
        return {kind: None for kind in KINDS}
    m = measures(cfg)
    posture = body.get("posture") or {}
    wrists = [v for v in (body.get("wrist_movement") or {}).values() if isinstance(v, (int, float))]
    values = {
        "arms_crossed": posture.get("arms_cross"),
        "face_touch": posture.get("face_touch_distance"),
        "looking_down": posture.get("head_pitch_delta"),
        "sway": (body.get("torso_movement") or {}).get("value"),
        "fast_hands": max(wrists) if wrists else None,
    }
    out: dict[str, Reading | None] = {}
    for kind, value in values.items():
        if value is None:
            out[kind] = None
            continue
        spec = m[kind]
        if spec.active == "above":
            strict = kind in ("sway", "fast_hands")      # the movement rules use '>', the posture rules '>='
            enter = value > spec.enter if strict else value >= spec.enter
            stay = value >= spec.exit
        else:
            enter, stay = value <= spec.enter, value <= spec.exit
        if kind == "arms_crossed" and not posture.get("arms_in_zone"):
            enter = stay = False                      # hands out of the chest zone: not folded arms
        out[kind] = Reading(value, enter, stay)
    return out


@dataclass
class _Open:
    episode_id: str
    started_t: float
    last_on_t: float
    peak: float
    off_since: float | None = None
    evidence: list[str] = field(default_factory=list)


@dataclass
class _State:
    pending_since: float | None = None
    pending_peak: float | None = None
    open: _Open | None = None


class EpisodeTracker:
    def __init__(self, cfg: EpisodesConfig, pose_cfg: PoseConfig):
        self.cfg = cfg
        self.measures = measures(pose_cfg)
        self.state = {kind: _State() for kind in KINDS}
        self.closed: list[dict] = []          # ended episodes (session summary)

    def _timing(self, kind: str) -> EpisodeTiming:
        return getattr(self.cfg, kind)

    def _more_extreme(self, kind: str, a: float, b: float) -> float:
        return max(a, b) if self.measures[kind].active == "above" else min(a, b)

    def update(self, now: float, current: dict[str, Reading | None], evidence: list[str],
               mode: str | None = None) -> list[dict]:
        """One evaluation. Returns behavior.episode payloads (start / end) in a stable order."""
        events: list[dict] = []
        for kind in KINDS:
            timing = self._timing(kind)
            if timing.enabled:
                event = self._step(kind, timing, now, current.get(kind), evidence, mode)
                if event:
                    events.append(event)
        return events

    def _step(self, kind: str, timing: EpisodeTiming, now: float, reading: Reading | None, evidence: list[str],
              mode: str | None) -> dict | None:
        st = self.state[kind]
        ep = st.open
        if reading is None:
            st.pending_since = st.pending_peak = None
            if ep and now - ep.last_on_t >= self.cfg.unknown_grace_s:
                return self._close(kind, "tracking_lost", mode)
            return None
        if ep:
            if reading.stay:
                ep.last_on_t, ep.off_since = now, None
                ep.peak = self._more_extreme(kind, ep.peak, reading.value)
                ep.evidence = (ep.evidence + [e for e in evidence if e not in ep.evidence])[-MAX_EVIDENCE:]
                return None
            ep.off_since = now if ep.off_since is None else ep.off_since
            return self._close(kind, "cleared", mode) if now - ep.off_since >= timing.min_off_s else None
        if not reading.enter:
            st.pending_since = st.pending_peak = None
            return None
        if st.pending_since is None:
            st.pending_since, st.pending_peak = now, reading.value
        st.pending_peak = self._more_extreme(kind, st.pending_peak, reading.value)
        if now - st.pending_since < timing.min_on_s:
            return None
        st.open = _Open(f"ep-{uuid.uuid4().hex[:12]}", st.pending_since, now, st.pending_peak,
                        evidence=list(evidence)[-MAX_EVIDENCE:])
        st.pending_since = st.pending_peak = None
        return self._payload(kind, "start", st.open, None, mode)

    def close_all(self, reason: str, mode: str | None = None) -> list[dict]:
        """End every open episode (session paused or ended); drop pending ones."""
        events = []
        for kind in KINDS:
            self.state[kind].pending_since = self.state[kind].pending_peak = None
            if self.state[kind].open:
                events.append(self._close(kind, reason, mode))
        return events

    def _close(self, kind: str, reason: str, mode: str | None) -> dict:
        st = self.state[kind]
        ep, st.open = st.open, None
        payload = self._payload(kind, "end", ep, reason, mode)
        self.closed.append(payload)
        return payload

    def _payload(self, kind: str, phase: str, ep: _Open, reason: str | None, mode: str | None) -> dict:
        spec = self.measures[kind]
        return {
            "episode_id": ep.episode_id,
            "behavior": kind,
            "phase": phase,
            "started_at": to_iso(ep.started_t),
            "ended_at": to_iso(ep.last_on_t) if phase == "end" else None,
            "duration_s": round(ep.last_on_t - ep.started_t, 2) if phase == "end" else None,
            "end_reason": reason,
            "measure": {"name": spec.name, "unit": spec.unit, "peak": round(ep.peak, 3), "enter": spec.enter,
                        "exit": spec.exit, "active": spec.active},
            "mode": mode,
            "evidence_event_ids": ep.evidence[-MAX_EVIDENCE:],
        }

    def summary(self) -> dict:
        out: dict = {}
        for ep in self.closed:
            s = out.setdefault(ep["behavior"], {"episodes": 0, "total_s": 0.0, "longest_s": 0.0})
            s["episodes"] += 1
            s["total_s"] = round(s["total_s"] + ep["duration_s"], 2)
            s["longest_s"] = max(s["longest_s"], ep["duration_s"])
        return out
