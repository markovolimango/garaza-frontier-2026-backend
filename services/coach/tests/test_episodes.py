"""Behaviour episodes: every occurrence with a start and an end, on the coaching rules' own measures."""

from datetime import datetime

import pytest

from conftest import T0, Device, make_session
from coach.config import EpisodesConfig, PoseConfig
from coach.metrics.episodes import KINDS, EpisodeTracker, Reading, readings
from test_posture import CROSSED, HAND_AT_FACE, pose


def at(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


ON, HOLD, OFF = Reading(1.0, True, True), Reading(0.5, False, True), Reading(0.0, False, False)


def drive(tracker, steps, start=T0, hz=10):
    """steps: [(seconds, {kind: Reading | None})]. Returns (events, end time)."""
    events, t = [], start
    for seconds, current in steps:
        for _ in range(round(seconds * hz)):
            events += tracker.update(t, current, ["ev"])
            t += 1 / hz
    return events, t


def tracker():
    return EpisodeTracker(EpisodesConfig(), PoseConfig())


# ----------------------------------------------------------------------------- tracker
def test_start_is_backdated_to_onset_and_end_is_the_last_sighting():
    events, _ = drive(tracker(), [(1, {"arms_crossed": OFF}), (3, {"arms_crossed": ON}), (2, {"arms_crossed": OFF})])
    start, end = events                                                     # arms_crossed: min_on 1 s, min_off 1 s
    assert (start["behavior"], start["phase"], end["phase"]) == ("arms_crossed", "start", "end")
    assert start["episode_id"] == end["episode_id"]
    assert at(start["started_at"]) == pytest.approx(T0 + 1.0, abs=2e-3)    # onset, not onset + min_on_s
    assert at(end["ended_at"]) == pytest.approx(T0 + 3.9, abs=2e-3)        # last frame it held
    assert end["duration_s"] == pytest.approx(2.9, abs=0.01) and end["end_reason"] == "cleared"
    assert end["measure"] == {"name": "wrist_cross", "unit": "torso_lengths", "peak": 1.0, "active": "above",
                              "enter": PoseConfig().arms_crossed_min_cross, "exit": PoseConfig().arms_crossed_clear_cross}


def test_too_short_never_starts_and_flicker_does_not_split():
    t = tracker()
    events, _ = drive(t, [(0.8, {"arms_crossed": ON}), (1, {"arms_crossed": OFF})])
    assert events == []                                                     # 0.8 s < min_on_s
    events, _ = drive(t, [(2, {"arms_crossed": ON}), (0.5, {"arms_crossed": OFF}),
                          (2, {"arms_crossed": ON}), (2, {"arms_crossed": OFF})], start=T0 + 10)
    assert [e["phase"] for e in events] == ["start", "end"]                 # 0.5 s gap < min_off_s


def test_hysteresis_between_enter_and_stay():
    t = tracker()
    events, end = drive(t, [(3, {"arms_crossed": HOLD})])
    assert events == []                                                     # only the looser threshold: no start
    events, _ = drive(t, [(2, {"arms_crossed": ON}), (3, {"arms_crossed": HOLD})], start=end)
    assert [e["phase"] for e in events] == ["start"]                        # still within exit: stays open


def test_unknown_keeps_an_episode_for_the_grace_period_then_ends_it():
    t = tracker()                                                           # unknown_grace_s 1.5
    events, end = drive(t, [(2, {"arms_crossed": ON}), (1, {"arms_crossed": None}), (2, {"arms_crossed": ON})])
    assert [e["phase"] for e in events] == ["start"]                        # 1 s hidden: same episode
    events, _ = drive(t, [(2, {"arms_crossed": None})], start=end)
    assert [(e["phase"], e["end_reason"]) for e in events] == [("end", "tracking_lost")]
    events, _ = drive(t, [(5, {})], start=end + 5)
    assert events == []                                                     # unknown never starts one


def test_several_behaviours_at_once():
    events, _ = drive(tracker(), [(3, {"arms_crossed": ON, "looking_down": ON, "sway": OFF}),
                                  (3, {"arms_crossed": OFF, "looking_down": OFF})])
    assert [(e["behavior"], e["phase"]) for e in events] == [
        ("arms_crossed", "start"), ("looking_down", "start"), ("arms_crossed", "end"), ("looking_down", "end")]


def test_disabled_detector_close_all_and_summary():
    cfg = EpisodesConfig.model_validate({"face_touch": {"enabled": False, "min_on_s": 0.5, "min_off_s": 0.5}})
    t = EpisodeTracker(cfg, PoseConfig())
    events, _ = drive(t, [(3, {"arms_crossed": ON, "face_touch": ON})])
    assert [e["behavior"] for e in events] == ["arms_crossed"]
    closed = t.close_all("session_paused")
    assert [(e["behavior"], e["end_reason"]) for e in closed] == [("arms_crossed", "session_paused")]
    assert t.summary()["arms_crossed"]["episodes"] == 1


# ----------------------------------------------------------------------------- readings = the rules' conditions
def body(**over):
    base = {"tracking_state": "tracking", "torso_movement": {"value": 0.1}, "wrist_movement": {"left": 0.2, "right": None},
            "posture": {"arms_cross": -0.3, "arms_in_zone": False, "face_touch_distance": 0.9, "head_pitch_delta": 0.0}}
    return {**base, **over}


def test_readings_use_the_rule_thresholds_with_their_clear_values_as_exit():
    cfg = PoseConfig()
    crossed = readings(body(posture={"arms_cross": cfg.arms_crossed_min_cross, "arms_in_zone": True}), cfg)
    assert crossed["arms_crossed"].enter and crossed["arms_crossed"].stay
    between = (cfg.arms_crossed_min_cross + cfg.arms_crossed_clear_cross) / 2
    loose = readings(body(posture={"arms_cross": between, "arms_in_zone": True}), cfg)["arms_crossed"]
    assert (loose.enter, loose.stay) == (False, True)
    out_of_zone = readings(body(posture={"arms_cross": 1.0, "arms_in_zone": False}), cfg)["arms_crossed"]
    assert (out_of_zone.enter, out_of_zone.stay) == (False, False)
    face = readings(body(posture={"face_touch_distance": cfg.face_touch_max_distance}), cfg)["face_touch"]
    assert face.enter and face.stay                                         # a distance: active below
    fast = readings(body(wrist_movement={"left": cfg.hand_movement_high_per_s + 0.1, "right": 0.1}), cfg)["fast_hands"]
    assert fast.enter and fast.value == pytest.approx(cfg.hand_movement_high_per_s + 0.1)
    assert not readings(body(torso_movement={"value": cfg.torso_movement_high_per_s}), cfg)["sway"].enter  # rule: '>'


def test_readings_are_unknown_without_a_fresh_body_or_a_measure():
    cfg = PoseConfig()
    assert readings(body(tracking_state="lost"), cfg) == {kind: None for kind in KINDS}
    partial = readings(body(posture={}, torso_movement={"value": None}, wrist_movement={"left": None}), cfg)
    assert all(partial[kind] is None for kind in KINDS)


# ----------------------------------------------------------------------------- session
def episodes_of(session):
    return [e["payload"] for e in session.log.all_events() if e["event_type"] == "behavior.episode"]


def run_frames(session, clock, device, seconds, frame, hz=12):
    for _ in range(round(seconds * hz)):
        clock.advance(1 / hz)
        device.send(session, "pose.frame", frame, clock.now())


def test_session_publishes_an_arms_crossed_episode_next_to_the_rule(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    run_frames(s, clock, d, 2, pose())
    onset = clock.now()
    run_frames(s, clock, d, 6, pose(**CROSSED))
    run_frames(s, clock, d, 4, pose())
    eps = [e for e in episodes_of(s) if e["behavior"] == "arms_crossed"]
    assert [e["phase"] for e in eps] == ["start", "end"]
    assert at(eps[0]["started_at"]) == pytest.approx(onset, abs=0.8)        # medians over 1 s lag the onset
    assert eps[1]["duration_s"] == pytest.approx(6, abs=1.0) and eps[1]["mode"] == "2d"
    assert eps[1]["evidence_event_ids"]
    assert s.summary()["body"]["episodes"]["arms_crossed"]["episodes"] == 1
    assert [h["rule_id"] for h in s.coach.history] == ["body.arms_crossed"]  # the throttled rule fires once too


def test_a_hand_at_the_face_is_an_episode(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    run_frames(s, clock, d, 2, pose())
    run_frames(s, clock, d, 3, pose(**HAND_AT_FACE))
    run_frames(s, clock, d, 3, pose())
    assert [(e["behavior"], e["phase"]) for e in episodes_of(s)] == [("face_touch", "start"), ("face_touch", "end")]


def test_pause_ends_open_episodes_before_the_state_event(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    run_frames(s, clock, d, 4, pose(**CROSSED))
    s.transition("pause")
    tail = [(e["event_type"], e["payload"].get("phase"), e["payload"].get("end_reason") or e["payload"].get("state"))
            for e in s.log.all_events()][-2:]
    assert tail == [("behavior.episode", "end", "session_paused"), ("session.state", None, "paused")]
    run_frames(s, clock, d, 3, pose(**CROSSED))                             # paused: nothing new
    assert len(episodes_of(s)) == 2


def test_losing_the_body_ends_an_episode(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    run_frames(s, clock, d, 4, pose(**CROSSED))
    gone = {"mode": "2d", "detector": "test", "image": {"width": 1920, "height": 1080},
            "persons_detected": 0, "tracking_state": "no_person", "joints_2d": []}
    run_frames(s, clock, d, 3, gone)
    assert [(e["phase"], e["end_reason"]) for e in episodes_of(s)] == [("start", None), ("end", "tracking_lost")]
