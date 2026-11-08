import math
import random

from conftest import T0, Device, make_session, pose2d
from coach.config import PoseConfig
from coach.metrics.body import BodyTracker, OneEuro


def test_one_euro_reduces_jitter_and_resets():
    rng = random.Random(1)
    f = OneEuro(min_cutoff=1.5, beta=0.0)
    raw = [100 + rng.gauss(0, 2) for _ in range(200)]
    smooth = [f(i / 15, x) for i, x in enumerate(raw)]
    spread = lambda xs: max(xs[50:]) - min(xs[50:])  # noqa: E731
    assert spread(smooth) < spread(raw) / 2
    f.t = None
    assert f(100.0, 500.0) == 500.0                                    # reset: no lag from old state


def feed(tracker, frames, start=T0, hz=15):
    for i, payload in enumerate(frames):
        tracker.update(start + i / hz, payload, f"e{i}")
    return start + (len(frames) - 1) / hz


def test_tracking_lost_and_recovery_with_smoothing_reset():
    tracker = BodyTracker(PoseConfig())
    t = feed(tracker, [pose2d()] * 30)
    assert tracker.tracking_state(t) == "tracking"
    t = feed(tracker, [pose2d(present=False)] * 30, start=t + 1 / 15)
    assert tracker.tracking_state(t) == "lost" and tracker._filters == {}
    assert tracker.metrics(t)["body_present"] is False
    t = feed(tracker, [pose2d()] * 5, start=t + 1 / 15)
    assert tracker.tracking_state(t) == "tracking"
    assert tracker.tracking_state(t + 5) == "stale"                    # no frames at all -> stale, not 'lost'


def test_wrist_movement_is_normalised_by_body_reference():
    def movement(scale, size):
        tracker = BodyTracker(PoseConfig())
        frames = [pose2d(wrist_dx=0.03 * math.sin(i / 2), scale=scale, size=size) for i in range(60)]  # pose2d scales all joints
        t = feed(tracker, frames)
        return tracker.metrics(t)["wrist_movement"]["left"]
    near, far = movement(1.0, (1920, 1080)), movement(0.5, (1920, 1080))
    other_resolution = movement(1.0, (1280, 720))
    assert near and far and abs(near - far) / near < 0.05              # distance to camera does not matter
    assert abs(near - other_resolution) / near < 0.05                  # resolution does not matter


def test_angles_only_with_valid_joints_and_late_frames_not_smoothed():
    tracker = BodyTracker(PoseConfig())
    frame = pose2d()
    frame["joints_2d"] = [j if j["name"] != "left_wrist" else {**j, "confidence": 0.1} for j in frame["joints_2d"]]
    t = feed(tracker, [frame] * 10)
    angles = tracker.metrics(t)["joint_angles_deg"]
    assert angles["left_elbow"] is None and angles["right_elbow"]["plane"] == "image_2d"
    assert tracker.update(t - 2.0, pose2d(), "late") is False and tracker.late_frames == 1


def test_mode_switch_resets_state():
    tracker = BodyTracker(PoseConfig())
    t = feed(tracker, [pose2d()] * 10)
    frame3d = {"mode": "3d", "detector": "test", "image": {"width": 10, "height": 10}, "persons_detected": 1,
               "tracking_state": "tracking", "joints_3d": [
                   {"name": n, "position_m": p} for n, p in {
                       "root": [0, 0, 0], "center_shoulder": [0, 0.5, 0], "left_shoulder": [0.18, 0.5, 0],
                       "right_shoulder": [-0.18, 0.5, 0], "left_elbow": [0.25, 0.25, 0], "right_elbow": [-0.25, 0.25, 0],
                       "left_wrist": [0.27, 0.0, 0.1], "right_wrist": [-0.27, 0.0, 0.1], "left_hip": [0.1, 0, 0],
                       "right_hip": [-0.1, 0, 0]}.items()]}
    tracker.update(t + 0.05, frame3d, "e3d")
    metrics = tracker.metrics(t + 0.05)
    assert metrics["mode"] == "3d" and metrics["reference"]["unit"] == "m"
    assert metrics["joint_angles_deg"]["left_elbow"]["plane"] == "3d"
    assert metrics["torso_displacement"]["note"] == "needs root_camera_position_m"


def test_tracking_lost_coaching_waits_for_sustain(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    for i in range(30):
        clock.advance(1 / 15)
        d.send(s, "pose.frame", pose2d(), clock.now())
    for i in range(30):                                                 # 2 s without a person
        clock.advance(1 / 15)
        d.send(s, "pose.frame", pose2d(present=False), clock.now())
    assert not s.coach.history                                          # 1 s lost < 3 s sustain
    for i in range(45):
        clock.advance(1 / 15)
        d.send(s, "pose.frame", pose2d(present=False), clock.now())
    assert [h["rule_id"] for h in s.coach.history] == ["body.tracking_lost"]


def shifted(payload, dx):
    """Move the whole body horizontally (walking), keeping its shape."""
    out = dict(payload)
    out["joints_2d"] = [{**j, "x": j["x"] + dx} for j in payload["joints_2d"]]
    return out


def test_torso_movement_counts_pacing_back_and_forth():
    tracker = BodyTracker(PoseConfig())
    frames = [shifted(pose2d(), 0.15 * math.sin(i / 15 * 1.2)) for i in range(90)]  # back and forth
    t = feed(tracker, frames)
    m = tracker.metrics(t)
    assert m["torso_movement"]["value"] > 0.4                          # path speed: direction changes add up
    still = BodyTracker(PoseConfig())
    t = feed(still, [pose2d()] * 90)
    assert still.metrics(t)["torso_movement"]["value"] < 0.05


def test_hand_and_torso_movement_rules_fire_with_hysteresis(manager, clock):
    rules = {"body.hand_movement_high": {"sustain_s": 2, "cooldown_s": 5},
             "body.torso_movement_high": {"sustain_s": 2, "cooldown_s": 5}}
    s = make_session(manager, clock, config={"coaching": {"global_min_interval_s": 0, "rules": rules}})
    d = Device()

    def run(seconds, frame):
        for _ in range(int(seconds * 15)):
            clock.advance(1 / 15)
            d.send(s, "pose.frame", frame(clock.now()), clock.now())

    run(3, lambda t: pose2d())
    assert not s.coach.history                                          # standing still: nothing
    run(6, lambda t: pose2d(wrist_dx=0.12 * math.sin(t * 6)))           # fast hand movement only
    assert [h["rule_id"] for h in s.coach.history] == ["body.hand_movement_high"]
    assert s.coach.history[0]["evidence_event_ids"]
    run(8, lambda t: pose2d(wrist_dx=0.12 * math.sin(t * 6)))           # still high: not re-armed
    assert len(s.coach.history) == 1
    run(6, lambda t: shifted(pose2d(), 0.15 * math.sin(t * 1.2)))       # walking, hands still
    assert [h["rule_id"] for h in s.coach.history] == ["body.hand_movement_high", "body.torso_movement_high"]


def test_movement_rules_need_a_visible_body(manager, clock):
    rules = {"body.hand_movement_high": {"sustain_s": 0}, "body.tracking_lost": {"enabled": False}}
    s = make_session(manager, clock, config={"coaching": {"global_min_interval_s": 0, "rules": rules}})
    d = Device()
    for _ in range(60):
        clock.advance(1 / 15)
        d.send(s, "pose.frame", pose2d(present=False), clock.now())
    assert not s.coach.history
    assert s.coach.status()["body.hand_movement_high"]["fired"] == 0


def test_movement_thresholds_must_keep_hysteresis(manager, clock):
    import pytest
    from coach.session import SessionError
    with pytest.raises(SessionError):
        make_session(manager, clock, config={"pose": {"hand_movement_clear_per_s": 2.0}})
