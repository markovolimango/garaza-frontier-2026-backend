"""Bridge coach -> brain: pure mapping and forwarding decisions (no network)."""

import asyncio
from datetime import datetime, timedelta, timezone

from coach.brain_bridge import Bridge, hold_ms, sensor_status, vignette_for

NOW = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)
LIVE = {"phase": "presentation", "paused": False, "feedbackLevel": "strong", "enabledCategories": ["movement", "pace"]}


def fb(rule="body.torso_movement_high", expires_in=4.0, base=NOW):
    return {"rule_id": rule, "display_text": "x", "expires_at": (base + timedelta(seconds=expires_in)).isoformat()}


def test_sensor_status_maps_tracking_states():
    body = {"body_present": True, "tracking_state": "tracking", "frames_in_window": 24, "window_s": 2.0}
    assert sensor_status(body) == {"camera": "ok", "fps": 12.0, "posePresent": True}
    assert sensor_status({**body, "tracking_state": "lost", "body_present": False})["camera"] == "no_person"
    assert sensor_status({**body, "tracking_state": "stale"})["camera"] == "error"
    assert sensor_status({"tracking_state": "unknown", "window_s": 0})["fps"] == 0.0


def test_hold_follows_expiry_clamped():
    assert hold_ms(fb(expires_in=4.0), NOW) == 4000
    assert hold_ms(fb(expires_in=60), NOW) == 6000
    assert hold_ms(fb(expires_in=-5), NOW) == 1500
    assert hold_ms({"rule_id": "x"}, NOW) == 3000


def test_vignette_only_during_a_live_run_with_feedback_on():
    v = vignette_for(fb(), LIVE, "running", now=NOW)
    assert v == {"action": "vignette", "kind": "warn", "intensity": 0.7, "holdMs": 4000}
    assert vignette_for(fb(), {**LIVE, "feedbackLevel": "gentle"}, "running", now=NOW)["intensity"] == 0.4
    assert vignette_for(fb(), {**LIVE, "phase": "qa"}, "running", now=NOW) is not None
    # not live
    assert vignette_for(fb(), None, "running") is None
    assert vignette_for(fb(), LIVE, "debrief") is None
    assert vignette_for(fb(), {**LIVE, "paused": True}, "running") is None      # JJ is listening
    assert vignette_for(fb(), {**LIVE, "phase": "countdown"}, "running") is None
    # the brain's run settings
    assert vignette_for(fb(), {**LIVE, "feedbackLevel": "off"}, "running") is None   # baseline / test run
    assert vignette_for(fb("speech.fillers"), LIVE, "running") is None             # disfluencies not enabled
    # not a behaviour
    assert vignette_for(fb("heart.above_reference"), LIVE, "running") is None
    assert vignette_for(fb("body.tracking_lost"), LIVE, "running") is None


def test_force_ignores_level_and_categories_but_not_run_state():
    off = {**LIVE, "feedbackLevel": "off", "enabledCategories": []}
    assert vignette_for(fb("speech.fillers"), off, "running", force=True, now=NOW)["intensity"] == 0.7
    assert vignette_for(fb(), {**LIVE, "paused": True}, "running", force=True) is None


class FakeLink:
    def __init__(self):
        self.sent = []

    async def send(self, kind, payload):
        self.sent.append((kind, payload))
        return True


def make_bridge(**kw):
    b = Bridge("http://coach", "http://brain", lambda: "token", **kw)
    b.sensor, b.operator = FakeLink(), FakeLink()
    return b


def test_bridge_tracks_run_state_and_sends_vignette_and_sway():
    async def scenario():
        b = make_bridge()
        b._on_brain({"type": "run.state", "payload": {"run": LIVE, "sessionPhase": "running"}})
        await b.handle_event({"event_type": "coaching.feedback",
                              "payload": fb(expires_in=0.2, base=datetime.now(timezone.utc))})
        await b.handle_event({"event_type": "coaching.feedback", "payload": fb("speech.rate_high")})
        await asyncio.sleep(1.7)   # sway ends after the (clamped) hold
        return b

    b = asyncio.run(scenario())
    assert [k for k, _ in b.operator.sent] == ["operator.override", "operator.override"]
    behaviors = [p for k, p in b.sensor.sent if k == "behavior"]
    assert [(p["kind"], p["phase"]) for p in behaviors] == [("sway", "start"), ("sway", "end")]
    assert b.stats == {"feedback": 2, "vignettes": 2, "behaviors": 1, "status": 0}


def test_bridge_no_vignette_outside_runs_and_status_throttled():
    async def scenario():
        b = make_bridge()
        await b.handle_event({"event_type": "coaching.feedback", "payload": fb()})
        body = {"body_present": True, "tracking_state": "tracking", "frames_in_window": 24, "window_s": 2.0}
        for _ in range(5):
            await b.handle_event({"event_type": "body.metrics", "payload": body})
        await b.handle_event({"event_type": "body.metrics", "payload": {**body, "tracking_state": "lost"}})
        for t in b._behavior_end.values():
            t.cancel()
        return b

    b = asyncio.run(scenario())
    assert b.operator.sent == []
    statuses = [p["camera"] for k, p in b.sensor.sent if k == "sensor.status"]
    assert statuses == ["ok", "no_person"]


def test_no_vignette_flag_never_uses_operator():
    b = Bridge("http://coach", "http://brain", lambda: "t", vignette=False)
    assert b.operator is None
