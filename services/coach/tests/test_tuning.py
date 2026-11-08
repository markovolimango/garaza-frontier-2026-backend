"""Camera tuning: the threshold file (tuning.json) and the `coach tune` readout."""

import json
import logging
import os

import pytest

from conftest import Device
from coach.config import SERVICE_DIR, merge_config
from coach.tuning import Tuner, TuningError, load_tuning, read_tuning, render, tuning_path
from test_posture import CROSSED, pose


def write(tmp_path, data, name="tuning.json"):
    path = tmp_path / name
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    return path


def test_committed_tuning_file_is_valid():
    overrides = read_tuning(SERVICE_DIR / "tuning.json")
    assert overrides["pose"] and not any(k.startswith("_") for k in overrides["pose"])
    merge_config(overrides)


def test_tuning_file_errors_are_readable(tmp_path):
    assert read_tuning(tmp_path / "missing.json") is None
    assert read_tuning(write(tmp_path, {"_c": 1, "pose": {"_c": "x", "face_touch_max_distance": 0.3}})) == {
        "pose": {"face_touch_max_distance": 0.3}}
    cases = {
        '{"pose": {"face_touch_max_distance": 0.3,}}': "line 1",                          # trailing comma
        '{"pose": {"face_touch_max_distanse": 0.3}}': "pose.face_touch_max_distanse",     # typo
        '{"pose": {"arms_crossed_clear_cross": 0.5}}': "arms_crossed_clear_cross must be below",
        '{"coaching": {"rules": {"body.arms_crosed": {"sustain_s": 1}}}}': "unknown coaching rules",
        '[1, 2]': "top level",
    }
    for text, expected in cases.items():
        with pytest.raises(TuningError, match=expected.replace(".", r"\.")):
            read_tuning(write(tmp_path, text))


def test_load_tuning_falls_back_to_defaults_with_an_error(tmp_path, caplog):
    with caplog.at_level(logging.ERROR):
        assert load_tuning(write(tmp_path, "{nope")) is None
    assert "is invalid" in caplog.text and "default thresholds" in caplog.text
    assert load_tuning(None) is None


def test_tuning_path_precedence(monkeypatch, tmp_path):
    monkeypatch.delenv("COACH_TUNING_FILE", raising=False)
    assert tuning_path(None) == SERVICE_DIR / "tuning.json"
    monkeypatch.setenv("COACH_TUNING_FILE", str(tmp_path / "env.json"))
    assert tuning_path(None) == tmp_path / "env.json"
    assert tuning_path(str(tmp_path / "arg.json")) == tmp_path / "arg.json"
    assert tuning_path("") is None


class LocalClient:
    """The REST calls Tuner makes, served by an in-process SessionManager."""

    def __init__(self, manager, clock):
        self.manager, self.clock = manager, clock

    def request(self, method, path, body=None):
        assert (method, path) == ("GET", "/v1/sessions")
        return {"sessions": [s.public() for s in self.manager.sessions.values()]}

    def create_session(self, label=None, timeline="live", config=None):
        return self.manager.create(label=label, mic_source="iphone", timeline=timeline, simulated=False,
                                   config=config, clock=self.clock).public()

    def action(self, session_id, action):
        return self.manager.get(session_id).transition(action)

    def snapshot(self, session_id):
        return self.manager.get(session_id).snapshot()


def feed(session, clock, seconds, frame, device=Device()):
    for _ in range(round(seconds * 15)):
        clock.advance(1 / 15)
        device.send(session, "pose.frame", frame, clock.now())


def test_render_shows_measures_thresholds_and_rule_states(manager, clock):
    client = LocalClient(manager, clock)
    s = manager.get(client.create_session(label="x", config={"pose": {"arms_crossed_min_cross": 0.2}})["session_id"])
    s.transition("start")
    feed(s, clock, 3, pose(**CROSSED))                       # pending, not fired yet (sustain 3 s)
    text = "\n".join(render(s.snapshot(), color=False))
    arms = next(line for line in text.splitlines() if line.strip().startswith("arms crossed"))
    assert ">= 0.20" in arms and "< 0.00" in arms and "body.arms_crossed" in arms and "pending" in arms
    assert "in chest zone 0.00-0.80: yes" in text
    assert "head-up reference" in text and "ready" in text
    feed(s, clock, 1, pose(**CROSSED))
    fired = [line for line in render(s.snapshot(), color=False) if "body.arms_crossed" in line][0]
    assert "waits to clear" in fired and "fired 1x" in fired
    assert "\x1b[31m" in "\n".join(render(s.snapshot()))     # past the threshold: red


def test_tuner_owns_a_session_restarts_it_on_save_and_yields_to_runs(manager, clock, tmp_path):
    path = write(tmp_path, {"pose": {"face_touch_max_distance": 0.3}})
    tuner = Tuner("http://coach", path, color=False)
    client = LocalClient(manager, clock)
    lines = tuner.step(client)
    first = tuner.owned
    assert manager.get(first).state == "running" and manager.get(first).config.pose.face_touch_max_distance == 0.3
    assert "applied" in lines[1] and "this tool's session" in lines[0]

    path.write_text(json.dumps({"pose": {"face_touch_max_distance": 0.25}}))
    os.utime(path, (1, 1))                                   # mtime changes even within the same second
    tuner.step(client)
    assert manager.get(first).state == "ended" and tuner.owned != first
    assert manager.get(tuner.owned).config.pose.face_touch_max_distance == 0.25

    path.write_text("{broken")
    os.utime(path, (2, 2))
    lines = tuner.step(client)
    assert "INVALID" in lines[1] and manager.get(tuner.owned).config.pose.face_touch_max_distance == 0.35

    clock.advance(1)
    run = client.create_session(label="brain run_1")         # the bridge starts a brain run
    client.action(run["session_id"], "start")
    owned = tuner.owned
    lines = tuner.step(client)
    assert manager.get(owned).state == "ended" and tuner.owned is None
    assert "created elsewhere" in lines[0] and "brain run_1" in "\n".join(lines)


def test_rule_state_explains_a_held_back_rule():
    from coach.tuning import rule_state
    status = {"enabled": True, "armed": True, "pending_since_at": "2026-11-08T10:00:00Z", "fired": 0}
    now = 1_794_132_002.5   # 10:00:02.5 UTC
    assert rule_state(status, {"sustain_s": 3.0}, now)[0] == "pending 2.5/3.0s"
    assert "held back" in rule_state(status, {"sustain_s": 1.0}, now)[0]
    assert rule_state({**status, "enabled": False}, {}, now)[0] == "off"


def test_tuner_without_create_only_follows(manager, clock):
    lines = Tuner("http://coach", None, create=False, color=False).step(LocalClient(manager, clock))
    assert "no active coach session" in lines[0] and not manager.sessions
