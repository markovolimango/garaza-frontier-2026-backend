import pytest
from pydantic import ValidationError

from conftest import T0, Device, make_session, pose2d
from coach.session import SessionError
from coach.timeutil import to_iso
from coach.wire import EventIn


def envelope(**over):
    base = {"schema_version": "1.0", "event_id": "e1", "session_id": "ses_x",
            "source": {"device_id": "phone-1", "kind": "iphone"}, "sequence": 0, "event_type": "pose.frame",
            "captured_at": to_iso(T0), "payload": {}}
    base.update(over)
    return base


def test_envelope_validation():
    EventIn.model_validate(envelope())
    for bad in (envelope(captured_at="2027-01-15T08:00:00"),          # no timezone
                envelope(received_at=to_iso(T0)),                     # server-assigned field
                envelope(event_type="pose.unknown"),
                envelope(schema_version="2.0"),
                envelope(extra_field=1),
                envelope(sequence=-1),
                envelope(event_id="has space")):
        with pytest.raises(ValidationError):
            EventIn.model_validate(bad)


def test_lifecycle_and_invalid_transitions(manager, clock):
    s = make_session(manager, clock, running=False)
    with pytest.raises(SessionError) as err:
        s.transition("pause")
    assert err.value.status == 409 and err.value.code == "invalid_transition"
    for action, state in (("start", "running"), ("pause", "paused"), ("resume", "running"), ("stop", "ended")):
        assert s.transition(action)["state"] == state
    with pytest.raises(SessionError):
        s.transition("start")
    states = [e["payload"]["state"] for e in s.log.all_events() if e["event_type"] == "session.state"]
    assert states == ["created", "running", "paused", "running", "ended"]


def test_payload_validation_and_server_only_types(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    bad = pose2d()
    bad["joints_2d"][0]["confidence"] = 1.5
    assert d.send(s, "pose.frame", bad, T0)["code"] == "invalid_payload"
    forged = d.ev(s, "coaching.feedback", {}, T0)
    assert s.accept(forged, "phone-1", "iphone")["code"] == "type_not_allowed"
    assert s.counters["rejected"] == 2


def test_ended_session_rejects_events(manager, clock):
    s = make_session(manager, clock)
    s.transition("stop")
    assert Device().send(s, "pose.frame", pose2d(), T0)["code"] == "session_ended"


def test_unknown_rule_in_config_is_rejected(manager, clock):
    with pytest.raises(SessionError) as err:
        manager.create(label=None, mic_source="iphone", timeline="live", simulated=False,
                       config={"coaching": {"rules": {"made.up": {"priority": 1}}}}, clock=clock)
    assert err.value.code == "invalid_config"


def test_out_of_frame_3d_projection_is_valid(manager, clock):
    """Regression: real VNHumanBodyPose3DObservation projections of cropped joints exceed 0..1."""
    s = make_session(manager, clock)
    frame = {"mode": "3d", "detector": "VNDetectHumanBodyPose3DRequest", "image": {"width": 1280, "height": 720},
             "persons_detected": 1, "tracking_state": "tracking", "coordinate_space_3d": "vision_body_root_m",
             "joints_3d": [{"name": "left_ankle", "position_m": [0.1, -0.8, 0.0], "parent": "left_knee",
                            "image_point": {"x": 1.43, "y": 3.04}}]}
    assert Device().send(s, "pose.frame", frame, T0)["status"] == "accepted"
