"""Deterministic coaching rules.

Each rule turns current observations into a condition plus a quality state. A suggestion is
emitted only when
  - the condition has held for `sustain_s` (duration threshold),
  - the rule is armed (hysteresis: after firing it must first clear),
  - its cooldown and the global minimum interval have passed,
  - no other suggestion is active (at most one at a time; highest priority wins),
  - the data quality is good or limited (stale / unavailable / insufficient data suppress it).
Texts describe observations and a small action. They never claim emotional states.
Defaults are demo heuristics (see config.py).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from coach.config import CoachingConfig, HeartConfig, PoseConfig, SpeechConfig
from coach.timeutil import to_iso

USABLE_QUALITY = {"good", "limited"}

TEMPLATES = {
    "en": {
        "body.tracking_lost": ("Body tracking is lost; you may be outside the camera view.",
                               "Step back into the camera view."),
        "body.hand_movement_high": ("Your hands have been moving fast for a while ({speed:.1f} torso lengths per second).",
                                    "Try holding one gesture still while you make your next point."),
        "body.torso_movement_high": ("You have been moving around continuously ({speed:.1f} torso lengths per second).",
                                     "Try planting your feet while you make your next point."),
        "body.arms_crossed": ("Your arms have been crossed in front of you for {held_s:.0f} s.",
                              "Try letting your arms hang loosely and gesturing with one hand."),
        "body.face_touch": ("A hand has been at your face for about {held_s:.0f} s.",
                            "Try lowering your hand and keeping it free for gestures."),
        "body.looking_down": ("Your head has been tilted down for {held_s:.0f} s.",
                              "Try lifting your eyes to the audience for your next point."),
        "speech.rate_high": ("Speaking rate is above your practice target ({rate:.0f} vs {target:.0f} words per minute).",
                             "Try slowing your next sentence."),
        "speech.long_pauses": ("{count} long pauses (at least {threshold:.1f} s) in the last {window:.0f} s of speaking.",
                               "Try connecting your next two sentences with a shorter pause."),
        "speech.fillers": ("{count} filler words in the last {window:.0f} s.",
                           "Take a brief pause before your next point."),
        "heart.above_reference": ("Heart rate is above your session reference ({delta:+.0f} bpm).",
                                  "If it helps, take one slow breath before your next point."),
    },
    "sr": {
        "body.tracking_lost": ("Praćenje tela je izgubljeno; verovatno ste van kadra.",
                               "Vratite se u kadar kamere."),
        "body.hand_movement_high": ("Ruke se već neko vreme brzo pomeraju ({speed:.1f} dužina trupa u sekundi).",
                                    "Pokušajte da zadržite jedan pokret mirno dok iznosite sledeću tačku."),
        "body.torso_movement_high": ("Neprekidno se krećete ({speed:.1f} dužina trupa u sekundi).",
                                     "Pokušajte da stojite na mestu dok iznosite sledeću tačku."),
        "body.arms_crossed": ("Ruke su vam prekrštene ispred tela već {held_s:.0f} s.",
                              "Pokušajte da opustite ruke niz telo i gestikulirate jednom rukom."),
        "body.face_touch": ("Ruka vam je oko {held_s:.0f} s na licu.",
                            "Pokušajte da spustite ruku i ostavite je slobodnu za gestove."),
        "body.looking_down": ("Glava vam je oborena nadole već {held_s:.0f} s.",
                              "Pokušajte da pogledate publiku dok iznosite sledeću tačku."),
        "speech.rate_high": ("Tempo govora je iznad vašeg cilja za vežbu ({rate:.0f} naspram {target:.0f} reči u minuti).",
                             "Pokušajte da sledeću rečenicu izgovorite sporije."),
        "speech.long_pauses": ("{count} duge pauze (najmanje {threshold:.1f} s) u poslednjih {window:.0f} s govora.",
                               "Pokušajte da sledeće dve rečenice povežete kraćom pauzom."),
        "speech.fillers": ("{count} poštapalica u poslednjih {window:.0f} s.",
                           "Napravite kratku pauzu pre sledeće tačke."),
        "heart.above_reference": ("Puls je iznad referentne vrednosti ove sesije ({delta:+.0f} otk./min).",
                                  "Ako vam prija, polako udahnite pre sledeće tačke."),
    },
}
RULE_IDS = tuple(TEMPLATES["en"])


@dataclass
class RuleEval:
    rule_id: str
    condition: bool
    quality: str
    clear: bool
    evidence: list[str] = field(default_factory=list)
    values: dict = field(default_factory=dict)


@dataclass
class _RuleState:
    since: float | None = None
    armed: bool = True
    last_fired: float | None = None
    fired: int = 0
    suppressed_by_quality: int = 0


def _body_quality(body: dict, value: float | None) -> str:
    """Body rules need a visible body; partial tracking counts as limited quality."""
    quality = {"tracking": "good", "partial": "limited", "stale": "stale"}.get(body.get("tracking_state"),
                                                                              "unavailable")
    return "insufficient_data" if quality in USABLE_QUALITY and value is None else quality


def _movement_eval(rule_id: str, value: float | None, body: dict, high: float, clear: float,
                   evidence: list[str]) -> RuleEval:
    return RuleEval(rule_id, value is not None and value > high, _body_quality(body, value),
                    clear=value is not None and value < clear, evidence=evidence,
                    values={"speed": value or 0.0, "threshold": high})


def _posture_evals(body: dict, cfg: PoseConfig, evidence: list[str]) -> list[RuleEval]:
    """Posture rules on the medians in body.metrics `posture` (geometry: metrics/body.py)."""
    posture = body.get("posture") or {}
    cross, zone = posture.get("arms_cross"), posture.get("arms_in_zone")
    face = posture.get("face_touch_distance")
    delta = posture.get("head_pitch_delta")
    return [
        # both wrists past the midline in the chest zone; clears when a wrist is back or the hands leave the zone
        RuleEval("body.arms_crossed", cross is not None and bool(zone) and cross >= cfg.arms_crossed_min_cross,
                 _body_quality(body, cross), evidence=evidence, values={"cross": cross or 0.0},
                 clear=cross is not None and (not zone or cross < cfg.arms_crossed_clear_cross)),
        RuleEval("body.face_touch", face is not None and face <= cfg.face_touch_max_distance, _body_quality(body, face),
                 clear=face is not None and face > cfg.face_touch_clear_distance, evidence=evidence,
                 values={"distance": face or 0.0}),
        # head pitch against this person's head-up reference (unavailable until the reference has history)
        RuleEval("body.looking_down", delta is not None and delta >= cfg.looking_down_min_delta,
                 _body_quality(body, delta), clear=delta is not None and delta < cfg.looking_down_clear_delta,
                 evidence=evidence, values={"delta": delta or 0.0}),
    ]


def build_evals(now: float, body: dict, speech: dict, heart: dict, speech_cfg: SpeechConfig,
                heart_cfg: HeartConfig, cfg: CoachingConfig, pose_evidence: list[str],
                pose_cfg: PoseConfig | None = None) -> list[RuleEval]:
    evals: list[RuleEval] = []
    rules = cfg.rules
    pose_cfg = pose_cfg or PoseConfig()

    # body.tracking_lost: needs fresh frames that report no usable body.
    state = body.get("tracking_state", "unknown")
    if state == "unknown":
        quality = "insufficient_data"
    elif state == "stale":
        quality = "stale"
    else:
        quality = "good"
    evals.append(RuleEval("body.tracking_lost", state == "lost", quality, clear=state in ("tracking", "partial"),
                          evidence=pose_evidence))

    # body.hand_movement_high: the faster wrist, relative to the torso (walking does not count).
    wrist = body.get("wrist_movement") or {}
    known = [wrist[side] for side in ("left", "right") if wrist.get(side) is not None]
    evals.append(_movement_eval("body.hand_movement_high", max(known) if known else None, body,
                                pose_cfg.hand_movement_high_per_s, pose_cfg.hand_movement_clear_per_s,
                                pose_evidence))

    # body.torso_movement_high: torso-center speed along its path (pacing back and forth counts).
    evals.append(_movement_eval("body.torso_movement_high", (body.get("torso_movement") or {}).get("value"), body,
                                pose_cfg.torso_movement_high_per_s, pose_cfg.torso_movement_clear_per_s,
                                pose_evidence))
    evals.extend(_posture_evals(body, pose_cfg, pose_evidence))

    sr = speech.get("_rule", {})
    rate = sr.get("rate")
    target = speech_cfg.target_wpm_max
    evals.append(RuleEval("speech.rate_high", rate is not None and rate > target,
                          "good" if rate is not None else "insufficient_data",
                          clear=rate is not None and rate < target - speech_cfg.rate_clear_margin_wpm,
                          evidence=sr.get("rate_evidence", []), values={"rate": rate or 0.0, "target": target}))

    pause_rule = rules["speech.long_pauses"]
    recent_pauses = [p for p in sr.get("long_pauses", []) if now - p["ended_at_t"] <= pause_rule.window_s]
    evals.append(RuleEval("speech.long_pauses", len(recent_pauses) >= pause_rule.count,
                          "good" if sr.get("vad_seen") else "unavailable",
                          clear=len(recent_pauses) < pause_rule.count,
                          evidence=[e for p in recent_pauses for e in p["evidence"]],
                          values={"count": len(recent_pauses), "threshold": speech_cfg.long_pause_s,
                                  "window": pause_rule.window_s}))

    filler_rule = rules["speech.fillers"]
    recent_fillers = [f for f in sr.get("fillers_window", []) if now - f[0] <= filler_rule.window_s]
    has_lexicon = speech.get("final", {}).get("filler_lexicon", {}).get("phrases", 0) > 0
    evals.append(RuleEval("speech.fillers", len(recent_fillers) >= filler_rule.count,
                          "good" if has_lexicon else "unavailable",
                          clear=len(recent_fillers) < filler_rule.count,
                          evidence=sorted({f[2] for f in recent_fillers}),
                          values={"count": len(recent_fillers), "window": filler_rule.window_s}))

    hr = heart.get("_rule", {})
    delta = heart.get("delta_from_reference_bpm")
    evals.append(RuleEval("heart.above_reference", bool(heart.get("above_reference")), hr.get("quality", "unavailable"),
                          clear=delta is not None and delta < heart_cfg.rise_threshold_bpm - heart_cfg.clear_margin_bpm,
                          evidence=hr.get("evidence", []), values={"delta": delta or 0.0}))
    return evals


class CoachingEngine:
    def __init__(self, cfg: CoachingConfig):
        unknown = set(cfg.rules) - set(RULE_IDS)
        if unknown:
            raise ValueError(f"unknown coaching rules: {sorted(unknown)}")
        self.cfg = cfg
        self.language = cfg.language.split("-")[0].lower() if cfg.language.split("-")[0].lower() in TEMPLATES else "en"
        self.state = {rule_id: _RuleState() for rule_id in RULE_IDS}
        self.last_feedback_at: float | None = None
        self.active_until: float | None = None
        self.active: dict | None = None
        self.history: list[dict] = []

    def evaluate(self, now: float, evals: list[RuleEval]) -> dict | None:
        ready: list[tuple[int, float, RuleEval]] = []
        for ev in evals:
            rule_cfg = self.cfg.rules[ev.rule_id]
            st = self.state[ev.rule_id]
            if not rule_cfg.enabled:
                continue
            if ev.clear:
                st.armed = True
            if ev.quality not in USABLE_QUALITY:
                if ev.condition or st.since is not None:
                    st.suppressed_by_quality += 1
                st.since = None
                continue
            if not ev.condition:
                st.since = None
                continue
            if st.since is None:
                st.since = now
            cooled = st.last_fired is None or now - st.last_fired >= rule_cfg.cooldown_s
            if st.armed and cooled and now - st.since >= rule_cfg.sustain_s:
                ready.append((rule_cfg.priority, st.since, ev))

        if self.active_until is not None and now < self.active_until:
            return None
        self.active = None
        if self.last_feedback_at is not None and now - self.last_feedback_at < self.cfg.global_min_interval_s:
            return None
        if not ready:
            return None
        ready.sort(key=lambda item: (item[0], item[1]))
        _, _, ev = ready[0]
        return self._fire(now, ev)

    def _fire(self, now: float, ev: RuleEval) -> dict:
        rule_cfg = self.cfg.rules[ev.rule_id]
        st = self.state[ev.rule_id]
        st.armed, st.last_fired, st.fired = False, now, st.fired + 1
        self.last_feedback_at = now
        self.active_until = now + self.cfg.display_s
        observation_t, action = TEMPLATES[self.language][ev.rule_id]
        observation = observation_t.format(held_s=now - (st.since or now), **ev.values)  # held_s: posture texts
        feedback = {
            "feedback_id": f"fb-{uuid.uuid4().hex[:12]}",
            "rule_id": ev.rule_id,
            "evidence_event_ids": ev.evidence[:50],
            "observation": observation,
            "suggested_action": action,
            "priority": rule_cfg.priority,
            "quality_state": ev.quality,
            "cooldown": {"rule_cooldown_s": rule_cfg.cooldown_s,
                         "next_eligible_at": to_iso(now + rule_cfg.cooldown_s),
                         "rearm": "condition must clear first (hysteresis)",
                         "global_min_interval_s": self.cfg.global_min_interval_s,
                         "sustained_s": round(now - (st.since or now), 2)},
            "language": self.language,
            "display_text": f"{observation} {action}",
            "text_source": "template",
            "expires_at": to_iso(now + self.cfg.display_s),
        }
        self.active = feedback
        self.history.append({"t": now, **feedback})
        return feedback

    def status(self) -> dict:
        return {rule_id: {"armed": st.armed, "pending_since_t": st.since, "last_fired_t": st.last_fired,
                          "fired": st.fired, "suppressed_by_quality": st.suppressed_by_quality,
                          "enabled": self.cfg.rules[rule_id].enabled}
                for rule_id, st in self.state.items()}
