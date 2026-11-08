"""Bridge coach -> brain: pure mapping and forwarding decisions (no network)."""

import asyncio
from datetime import datetime, timedelta, timezone

from coach.brain_bridge import (RULE_CATEGORY, RULE_KIND, RULE_SENSOR_BEHAVIOR, Bridge, coach_session_plan, hold_ms,
                                observation, sensor_status, vignette_for)

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
    assert b.stats == {"feedback": 2, "vignettes": 2, "behaviors": 1, "status": 0, "observations": 2}
    sent = [p for k, p in b.sensor.sent if k == "coach.observation"]
    assert [(p["rule"], p["kind"], p["category"]) for p in sent] == [
        ("body.torso_movement_high", "sway", "movement"), ("speech.rate_high", "pace_fast", "pace")]


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


def test_coach_session_follows_the_brain_run():
    run = lambda phase="presentation", paused=False, run_id="run_1": {"runId": run_id, "phase": phase, "paused": paused}
    mine = lambda state="running", run_id="run_1": {"id": "ses_1", "run_id": run_id, "state": state}
    assert coach_session_plan(None, run("countdown"), "running") == []
    assert coach_session_plan(None, run(), "running") == ["create", "start"]
    assert coach_session_plan(None, run(paused=True), "running") == ["create", "start", "pause"]
    assert coach_session_plan(mine(), run(), "running") == []
    assert coach_session_plan(mine(), run("qa"), "running") == []                      # Q&A is coached too
    assert coach_session_plan(mine(), run(paused=True), "running") == ["pause"]       # JJ is listening
    assert coach_session_plan(mine("paused"), run(), "running") == ["resume"]
    assert coach_session_plan(mine(), run("ended"), "running") == ["stop"]
    assert coach_session_plan(mine(), None, "debrief") == ["stop"]
    assert coach_session_plan(mine("ended"), None, "debrief") == []
    assert coach_session_plan(mine(), run(run_id="run_2"), "running") == ["stop", "create", "start"]


def test_bridge_runs_session_actions_in_order_and_once():
    calls = []

    async def scenario():
        b = Bridge("http://coach", "http://brain", lambda: "t")
        async def act(action):
            calls.append(action)
            if action == "create":
                b.coach_session = {"id": "ses_x", "run_id": b.run_state["runId"], "state": "created"}
            else:
                b.coach_session["state"] = {"start": "running", "pause": "paused", "resume": "running", "stop": "ended"}[action]
            return True
        b._session_action = act
        live = {"runId": "run_1", "phase": "presentation", "paused": False}
        b._on_brain({"type": "run.state", "payload": {"run": live, "sessionPhase": "running"}})
        b._on_brain({"type": "run.state", "payload": {"run": live, "sessionPhase": "running"}})   # same state again
        await b._session_task
        b._on_brain({"type": "run.state", "payload": {"run": {**live, "phase": "ended"}, "sessionPhase": "running"}})
        await b._session_task

    asyncio.run(scenario())
    assert calls == ["create", "start", "stop"]


def test_no_sessions_flag_leaves_coach_sessions_alone():
    async def scenario():
        b = Bridge("http://coach", "http://brain", lambda: "t", sessions=False)
        b._on_brain({"type": "run.state", "payload": {"run": {"runId": "r", "phase": "presentation", "paused": False},
                                                       "sessionPhase": "running"}})
        return b._session_task
    assert asyncio.run(scenario()) is None


def test_observation_payload_maps_rules_to_behaviours():
    assert observation({"rule_id": "speech.fillers", "display_text": "3 fillers"})["kind"] == "filler_burst"
    o = observation({"rule_id": "body.hand_movement_high", "display_text": "fast hands"})
    assert (o["kind"], o["category"], o["text"]) == ("fast_hands", "movement", "fast hands")
    mapped = {rule: (observation({"rule_id": rule})["kind"], observation({"rule_id": rule})["category"])
              for rule in ("body.arms_crossed", "body.face_touch", "body.looking_down")}
    assert mapped == {"body.arms_crossed": ("arms_crossed", "posture"), "body.face_touch": ("face_touch", "posture"),
                      "body.looking_down": ("looking_down", "gaze")}
    assert observation({"rule_id": "heart.above_reference"})["category"] is None
    assert observation({"rule_id": "body.tracking_lost"})["kind"] is None


def test_every_coach_rule_is_mapped_or_deliberately_not():
    from coach.coaching import RULE_IDS
    not_behaviours = {"body.tracking_lost", "heart.above_reference"}
    assert set(RULE_CATEGORY) == set(RULE_IDS) - not_behaviours
    assert set(RULE_KIND) == set(RULE_IDS) - not_behaviours
    # the protocol's SENSOR_BEHAVIORS (packages/protocol/src/messages.ts): camera behaviours only
    assert sorted(RULE_SENSOR_BEHAVIOR.values()) == ["arms_crossed", "face_touch", "fast_hands", "looking_down", "sway"]


def test_vignette_only_for_targets_when_the_run_has_some():
    targeted = {**LIVE, "targets": ["pace_fast"]}
    assert vignette_for(fb("speech.rate_high"), targeted, "running", now=NOW) is not None
    assert vignette_for(fb("body.torso_movement_high"), targeted, "running", now=NOW) is None
    assert vignette_for(fb("body.hand_movement_high"), targeted, "running", now=NOW) is None
    assert vignette_for(fb("body.hand_movement_high"), targeted, "running", force=True, now=NOW) is not None
    hands = {**LIVE, "targets": ["fast_hands", "looking_down"]}       # fast hands can be a target now
    assert vignette_for(fb("body.hand_movement_high"), hands, "running", now=NOW) is not None
    assert vignette_for(fb("body.looking_down"), hands, "running", now=NOW) is not None
    assert vignette_for(fb("body.arms_crossed"), hands, "running", now=NOW) is None


def test_posture_rules_send_behavior_start_and_end():
    async def scenario():
        b = make_bridge()
        b._on_brain({"type": "run.state", "payload": {"run": LIVE, "sessionPhase": "running"}})
        soon = datetime.now(timezone.utc)
        for rule in ("body.arms_crossed", "body.face_touch", "body.looking_down", "body.hand_movement_high"):
            await b.handle_event({"event_type": "coaching.feedback", "payload": fb(rule, expires_in=0.2, base=soon)})
        await asyncio.sleep(1.7)
        return b

    b = asyncio.run(scenario())
    behaviors = [(p["kind"], p["phase"]) for k, p in b.sensor.sent if k == "behavior"]
    kinds = ["arms_crossed", "face_touch", "looking_down", "fast_hands"]
    assert behaviors == [(k, "start") for k in kinds] + [(k, "end") for k in kinds]


class FakeCoach:
    created: list = []

    def __init__(self, url, token):
        self.http = type("H", (), {"close": lambda self: None})()

    def create_session(self, **body):
        FakeCoach.created.append(body)
        return {"session_id": "ses_t", "state": "created"}


def test_run_sessions_use_the_tuning_file(tmp_path, monkeypatch, caplog):
    import coach.brain_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "CoachClient", FakeCoach)
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    good.write_text('{"_note": "x", "pose": {"face_touch_max_distance": 0.3}}')
    bad.write_text('{"pose": {"face_touch_max_distanse": 0.3}}')

    async def create(path):
        b = Bridge("http://coach", "http://brain", lambda: "t", tuning=path)
        b.run_state = {"runId": "run_3"}
        return await b._session_action("create")

    FakeCoach.created = []
    assert asyncio.run(create(good)) and asyncio.run(create(bad)) and asyncio.run(create(None))
    assert [c["config"] for c in FakeCoach.created] == [{"pose": {"face_touch_max_distance": 0.3}}, None, None]
    assert FakeCoach.created[0]["label"] == "brain run_3"
    assert "face_touch_max_distanse" in caplog.text and "default thresholds" in caplog.text
