import asyncio

from conftest import T0, make_session
from coach.assistant import FeedbackDelivery, safe_generated_text
from coach.export import export_lines, read_export, replay
from coach.session import SessionManager
from coach.simulator import run_in_process


def test_generated_text_safety_filter():
    source = "Speaking rate is above your practice target (185 vs 165 words per minute)."
    assert safe_generated_text("Your pace is above target (185 vs 165). Slow the next sentence.", source)
    assert not safe_generated_text("You seem nervous, slow down.", source)               # emotional claim
    assert not safe_generated_text("Your pace is 210 words per minute.", source)          # invented number
    assert not safe_generated_text("x" * 400, source)
    assert not safe_generated_text(None, source)


class FakeAssistant:
    def __init__(self, reachable=True, rephrased=None):
        self.reachable, self.rephrased, self.spoken = reachable, rephrased, []

    async def status(self):
        return {"reachable": self.reachable, "tts": {"available": self.reachable},
                "reason": None if self.reachable else "not running"}

    async def rephrase(self, observation, action, language):
        return self.rephrased

    async def speak(self, text, language, playback_id):
        self.spoken.append(text)
        return {"state": "finished", "voice": "test-voice"}


def run_delivery(manager, clock, assistant):
    session = make_session(manager, clock, config={"coaching": {"speak": True, "rephrase_with_assistant": True}})
    delivery = FeedbackDelivery(assistant)
    feedback = session.coach._fire(clock.now(), __import__("coach.coaching", fromlist=["RuleEval"]).RuleEval(
        "speech.fillers", True, "good", False, ["e1"], {"count": 4, "window": 60}))

    async def go():
        delivery(session, feedback)
        await asyncio.gather(*delivery.tasks)
    asyncio.run(go())
    return session


def test_foundation_models_unavailable_falls_back_to_template(manager, clock):
    session = run_delivery(manager, clock, FakeAssistant(reachable=False, rephrased=None))
    events = [e for e in session.log.all_events() if e["event_type"] in ("coaching.feedback", "audio.playback")]
    assert events[0]["payload"]["text_source"] == "template"
    assert events[1]["payload"]["state"] == "skipped" and events[1]["payload"]["engine"] == "text_only"


def test_rephrase_and_playback_suppression(manager, clock):
    assistant = FakeAssistant(rephrased="Four filler words in the last 60 s. Pause briefly before your next point.")
    session = run_delivery(manager, clock, assistant)
    feedback = [e for e in session.log.all_events() if e["event_type"] == "coaching.feedback"][0]["payload"]
    assert feedback["text_source"] == "foundation_models"
    assert feedback["observation"].startswith("4 filler words")              # structured fields unchanged
    states = [e["payload"]["state"] for e in session.log.all_events() if e["event_type"] == "audio.playback"]
    assert states == ["started", "finished"] and assistant.spoken
    assert session.speech.suppression_intervals(T0 + 100)


def test_missing_watch_does_not_block_other_data(manager, clock):
    session = run_in_process(SessionManager(manager.settings), seed=3)
    assert session.summary()["speech"]["words"] > 0                           # speech continued
    assert session.counters["rejected"] == 0


def test_deterministic_replay_of_simulated_session(settings, tmp_path):
    settings.pose_buffer = 5000          # complete export: replay needs every retained frame
    original = run_in_process(SessionManager(settings))
    assert original.log.counts()["evicted_pose_frames"] == 0
    rules = [h["rule_id"] for h in original.coach.history]
    assert rules == ["body.hand_movement_high", "speech.rate_high", "heart.above_reference",
                     "body.torso_movement_high", "body.tracking_lost", "speech.long_pauses"]
    path = tmp_path / "session.jsonl"
    path.write_text("".join(export_lines(original)), encoding="utf-8")
    header, events = read_export(path)
    assert header["simulated"] is True and all(e["source"]["simulated"] for e in events)
    replayed = replay(SessionManager(settings), header, events)
    assert [h["rule_id"] for h in replayed.coach.history] == rules
    assert [round(h["t"] - original.coach.history[0]["t"], 1) for h in original.coach.history] == \
           [round(h["t"] - replayed.coach.history[0]["t"], 1) for h in replayed.coach.history]
    assert replayed.summary()["speech"]["words"] == original.summary()["speech"]["words"]


def test_incomplete_export_is_reported(settings, tmp_path):
    settings.pose_buffer = 100
    original = run_in_process(SessionManager(settings))
    path = tmp_path / "short.jsonl"
    path.write_text("".join(export_lines(original)), encoding="utf-8")
    header, _ = read_export(path)
    assert header["buffers"]["evicted_pose_frames"] > 0


def test_committed_fixture_replays_identically(settings):
    """fixtures/simulated_session.jsonl.gz (python -m coach fixture) is a regression reference."""
    from pathlib import Path
    path = Path(__file__).resolve().parents[3] / "fixtures" / "simulated_session.jsonl.gz"
    header, events = read_export(path)
    assert header["simulated"] is True and header["buffers"]["evicted_pose_frames"] == 0
    recorded = [e["payload"]["rule_id"] for e in events if e["event_type"] == "coaching.feedback"]
    replayed = replay(SessionManager(settings), header, events)
    assert [h["rule_id"] for h in replayed.coach.history] == recorded
