"""Posture observations (arms crossed, face touch, looking down) from synthetic 2D keypoints."""

import pytest
from pydantic import ValidationError

from conftest import T0, Device, make_session
from coach.coaching import TEMPLATES, CoachingEngine, RuleEval
from coach.config import CoachingConfig, PoseConfig
from coach.metrics.body import BodyTracker

HEAD = {"nose": (0.50, 0.20), "left_eye": (0.52, 0.18), "right_eye": (0.48, 0.18), "left_ear": (0.545, 0.19),
        "right_ear": (0.455, 0.19)}
BODY = {**HEAD, "left_shoulder": (0.56, 0.33), "right_shoulder": (0.44, 0.33), "left_elbow": (0.60, 0.45),
        "right_elbow": (0.40, 0.45), "left_wrist": (0.60, 0.56), "right_wrist": (0.40, 0.56),
        "left_hip": (0.54, 0.58), "right_hip": (0.46, 0.58)}     # facing the camera, hands at the sides
CROSSED = {"left_wrist": (0.44, 0.45), "right_wrist": (0.56, 0.47)}   # each wrist near the opposite elbow
CLASPED = {"left_wrist": (0.52, 0.48), "right_wrist": (0.48, 0.48)}   # hands together in front, own sides
HAND_AT_FACE = {"right_wrist": (0.47, 0.24)}
HEAD_DOWN = {"nose": (0.50, 0.22)}                                     # nose 0.08 torso lengths lower


def pose(scale=1.0, size=(1920, 1080), mirror=False, drop=(), **joints):
    """2D frame with face points; keyword joints override BODY (normalized x, y)."""
    out = []
    for name, (x, y) in {**BODY, **joints}.items():
        if name in drop:
            continue
        x, y = 0.5 + (x - 0.5) * scale, 0.5 + (y - 0.5) * scale
        out.append({"name": name, "x": 1 - x if mirror else x, "y": y, "confidence": 0.9})
    return {"mode": "2d", "detector": "test", "image": {"width": size[0], "height": size[1], "mirrored": mirror},
            "persons_detected": 1, "tracking_state": "tracking", "joints_2d": out}


def measure(frame, seconds=6.0, hz=15):
    """Feed a constant frame (or frame(t_rel)) to a fresh tracker; return body metrics at the end."""
    tracker = BodyTracker(PoseConfig())
    t = T0
    for i in range(int(seconds * hz)):
        t = T0 + i / hz
        tracker.update(t, frame(t - T0) if callable(frame) else frame, f"e{i}")
    return tracker.metrics(t)


# ------------------------------------------------------------------------- measures
def test_posture_does_not_depend_on_camera_distance_resolution_or_mirroring():
    ref = measure(pose(**CROSSED))["posture"]
    for kw in ({"scale": 0.5}, {"size": (1280, 720)}, {"mirror": True}):
        other = measure(pose(**CROSSED, **kw))["posture"]
        for key in ("arms_cross", "face_touch_distance", "head_pitch"):
            assert other[key] == pytest.approx(ref[key], abs=0.01), (kw, key)


def test_arms_crossed_needs_both_wrists_across_in_the_chest_zone():
    crossed = measure(pose(**CROSSED))["posture"]
    assert crossed["arms_crossed"] and crossed["arms_in_zone"] and crossed["arms_cross"] > 0.3
    assert measure(pose())["posture"]["arms_cross"] < 0                                   # hands at the sides
    clasped = measure(pose(**CLASPED))["posture"]
    assert clasped["arms_in_zone"] and clasped["arms_cross"] < 0 and not clasped["arms_crossed"]
    pointing = measure(pose(left_wrist=(0.40, 0.45)))["posture"]                           # one hand across
    assert pointing["wrist_cross"]["left"] > 0.3 and not pointing["arms_crossed"]
    low = measure(pose(left_wrist=(0.45, 0.60), right_wrist=(0.55, 0.60)))["posture"]      # in front of the hips
    assert low["arms_cross"] > 0.1 and not low["arms_in_zone"] and not low["arms_crossed"]
    hidden = measure(pose(drop=("left_wrist",), **CROSSED))["posture"]                     # wrist hidden: unknown
    assert hidden["arms_cross"] is None and hidden["arms_crossed"] is None


def test_face_touch_distance_uses_the_nearest_wrist_and_face_point():
    near = measure(pose(**HAND_AT_FACE))["posture"]
    assert near["face_touch"] and near["face_touch_distance"] < 0.3
    chest = measure(pose(right_wrist=(0.45, 0.36)))["posture"]                              # gesture at chest height
    assert chest["face_touch_distance"] > 0.5 and not chest["face_touch"]
    assert measure(pose(drop=tuple(HEAD), **HAND_AT_FACE))["posture"]["face_touch_distance"] is None


def test_head_pitch_is_relative_to_a_head_up_reference_that_adapts_to_the_camera():
    early = measure(pose(), seconds=3)["posture"]
    assert early["head_pitch"] is not None and early["head_pitch_delta"] is None           # reference needs 5 s
    for nose_y in (0.20, 0.16):                         # camera at face height / camera low (nose higher vs. ears)
        up = measure(lambda t: pose(nose=(0.50, nose_y)), seconds=12)["posture"]
        assert abs(up["head_pitch_delta"]) < 0.01 and not up["looking_down"]
        down = measure(lambda t: pose(nose=(0.50, nose_y + (0.02 if t >= 9 else 0))), seconds=12)["posture"]
        assert down["looking_down"] and down["head_pitch_delta"] == pytest.approx(0.08, abs=0.01)
    no_ears = measure(lambda t: pose(drop=("left_ear", "right_ear"), nose=(0.50, 0.22 if t >= 9 else 0.20)),
                      seconds=12)["posture"]
    assert no_ears["head_pitch_source"] == "shoulders" and no_ears["looking_down"]


def test_3d_frames_report_arms_only():
    joints = {"root": [0, 0, 0], "center_shoulder": [0, 0.5, 0], "left_shoulder": [0.18, 0.5, 0],
              "right_shoulder": [-0.18, 0.5, 0], "left_elbow": [0.25, 0.25, 0], "right_elbow": [-0.25, 0.25, 0],
              "left_wrist": [-0.1, 0.25, 0.15], "right_wrist": [0.1, 0.25, 0.15], "left_hip": [0.1, 0, 0],
              "right_hip": [-0.1, 0, 0]}
    frame = {"mode": "3d", "detector": "test", "image": {"width": 10, "height": 10}, "persons_detected": 1,
             "tracking_state": "tracking", "joints_3d": [{"name": n, "position_m": p} for n, p in joints.items()]}
    posture = measure(frame)["posture"]
    assert posture["arms_crossed"] and posture["arms_cross"] == pytest.approx(0.2, abs=0.01)
    assert posture["face_touch_distance"] is None and posture["head_pitch"] is None and posture["note"]


def test_face_points_do_not_change_tracking_state():
    for frame in (pose(), pose(drop=tuple(HEAD))):
        tracker = BodyTracker(PoseConfig())
        for i in range(10):
            tracker.update(T0 + i / 15, frame, f"e{i}")
        assert tracker.tracking_state(T0 + 9 / 15) == "tracking" and tracker.last_joint_ratio == 1.0


@pytest.mark.parametrize("override", [{"arms_crossed_clear_cross": 0.2}, {"face_touch_clear_distance": 0.3},
                                      {"looking_down_clear_delta": 0.1}, {"arms_crossed_min_height": 0.9}])
def test_posture_thresholds_must_keep_hysteresis(override):
    with pytest.raises(ValidationError):
        PoseConfig(**override)


# ------------------------------------------------------------------------- rules
def drive(session, device, clock, seconds, frame):
    for _ in range(round(seconds * 15)):
        clock.advance(1 / 15)
        device.send(session, "pose.frame", frame, clock.now())
    return [h["rule_id"] for h in session.coach.history]


def posture_session(manager, clock, rule):
    rules = {rule: {"cooldown_s": 5}, "body.hand_movement_high": {"enabled": False}}
    return make_session(manager, clock, config={"coaching": {"global_min_interval_s": 0, "rules": rules}}), Device()


def test_arms_crossed_rule_sustains_clears_and_rearms(manager, clock):
    s, d = posture_session(manager, clock, "body.arms_crossed")
    assert drive(s, d, clock, 3, pose()) == []
    assert drive(s, d, clock, 3, pose(**CROSSED)) == []                 # 3 s sustain + ~0.5 s median window
    assert drive(s, d, clock, 1, pose(**CROSSED)) == ["body.arms_crossed"]
    first = s.coach.history[0]
    assert first["observation"] == "Your arms have been crossed in front of you for 3 s." and first["evidence_event_ids"]
    assert drive(s, d, clock, 10, pose(**CROSSED)) == ["body.arms_crossed"]          # still crossed: not re-armed
    drive(s, d, clock, 2, pose(**CLASPED))                                            # a wrist back: clears
    assert drive(s, d, clock, 4, pose(**CROSSED)) == ["body.arms_crossed"] * 2
    drive(s, d, clock, 2, pose())
    assert drive(s, d, clock, 8, pose(**CLASPED)) == ["body.arms_crossed"] * 2       # clasped hands never fire
    assert drive(s, d, clock, 8, pose(left_wrist=(0.40, 0.45))) == ["body.arms_crossed"] * 2   # nor one hand across


def test_face_touch_rule_ignores_a_passing_hand(manager, clock):
    s, d = posture_session(manager, clock, "body.face_touch")
    drive(s, d, clock, 3, pose())
    drive(s, d, clock, 0.6, pose(**HAND_AT_FACE))
    assert drive(s, d, clock, 2, pose()) == []                           # passed the face: below 1 s sustain
    assert drive(s, d, clock, 1.0, pose(**HAND_AT_FACE)) == []
    assert drive(s, d, clock, 0.7, pose(**HAND_AT_FACE)) == ["body.face_touch"]
    assert drive(s, d, clock, 6, pose(**HAND_AT_FACE)) == ["body.face_touch"]
    drive(s, d, clock, 0.5, pose(right_wrist=(0.47, 0.30)))              # still near (0.35..0.5): does not clear
    assert drive(s, d, clock, 3, pose(**HAND_AT_FACE)) == ["body.face_touch"]
    drive(s, d, clock, 2, pose(right_wrist=(0.45, 0.36)))                # gesture at chest height: clears
    assert drive(s, d, clock, 2, pose(**HAND_AT_FACE)) == ["body.face_touch"] * 2


def test_looking_down_rule_waits_for_the_reference_and_rearms(manager, clock):
    s, d = posture_session(manager, clock, "body.looking_down")
    assert drive(s, d, clock, 4, pose(**HEAD_DOWN)) == []               # no head-up reference yet
    drive(s, d, clock, 10, pose())
    assert drive(s, d, clock, 3, pose(**HEAD_DOWN)) == []
    assert drive(s, d, clock, 1, pose(**HEAD_DOWN)) == ["body.looking_down"]
    assert s.coach.history[0]["quality_state"] == "good"
    assert drive(s, d, clock, 5, pose(**HEAD_DOWN)) == ["body.looking_down"]
    drive(s, d, clock, 2, pose())
    assert drive(s, d, clock, 4, pose(**HEAD_DOWN)) == ["body.looking_down"] * 2


def test_posture_templates_exist_in_both_languages_and_state_observations():
    assert set(TEMPLATES["en"]) == set(TEMPLATES["sr"])
    rules = {"body.arms_crossed": {"cross": 0.4}, "body.face_touch": {"distance": 0.2},
             "body.looking_down": {"delta": 0.08}}
    for language in ("en", "sr"):
        engine = CoachingEngine(CoachingConfig(language=language))
        for rule, values in rules.items():
            engine.state[rule].since = T0 - 3
            text = engine._fire(T0, RuleEval(rule, True, "good", False, values=values))["display_text"]
            assert "3 s" in text and "{" not in text
            assert not any(word in text.lower() for word in ("nervous", "anxious", "confident", "stress", "nerv"))
