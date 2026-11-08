from conftest import T0, Device, hr, make_session, transcript, vad
from coach.coaching import CoachingEngine, RuleEval
from coach.config import CoachingConfig, HeartConfig
from coach.metrics.heart import HeartTracker

WATCH = {"device_id": "watch-1", "kind": "watch", "simulated": False, "relay_device_id": "phone-1"}


def test_reference_requires_enough_fresh_samples():
    h = HeartTracker(HeartConfig(calibration_s=30, min_reference_samples=5))
    h.start_calibration(T0, None)
    for i in range(3):
        h.on_sample(T0 + i * 5, T0 + i * 5 + 1, hr(70, T0), f"s{i}")
    h.update_calibration(T0 + 31)
    assert h.calibration["status"] == "insufficient_data" and h.reference_bpm is None
    h.start_calibration(T0 + 40, 30)
    for i in range(8):
        h.on_sample(T0 + 40 + i * 3, T0 + 41 + i * 3, hr(70 + i % 2, T0), f"t{i}")
    h.update_calibration(T0 + 71)
    assert h.calibration["status"] == "ready" and h.reference_bpm == 70.5
    assert "not a clinical resting heart rate" in h.evaluate(T0 + 71)["reference"]["label"]


def test_watch_unreachable_and_stale_suppress_rule():
    h = HeartTracker(HeartConfig(fresh_max_age_s=20))
    h.reference_bpm = 70
    for i in range(5):
        h.on_sample(T0 + i * 5, T0 + i * 5 + 1, hr(95, T0), f"s{i}")
    good = h.evaluate(T0 + 21)
    assert good["above_reference"] is True and good["_rule"]["quality"] == "good"
    h.on_watch_status({"reachable": False})
    late = h.evaluate(T0 + 60)
    assert late["availability"] == "watch_unreachable" and late["above_reference"] is None
    assert h.evaluate(T0 + 21)["hrv"] == {"status": "unavailable"}


def rule(rule_id, condition, quality="good", clear=False):
    return RuleEval(rule_id, condition, quality, clear, ["ev1"], {"rate": 190, "target": 165, "count": 3,
                                                                  "threshold": 2, "window": 60, "delta": 18})


def test_duration_threshold_cooldown_and_hysteresis():
    cfg = CoachingConfig()
    cfg.rules["speech.rate_high"].sustain_s, cfg.rules["speech.rate_high"].cooldown_s = 8, 30
    engine = CoachingEngine(cfg)
    assert engine.evaluate(T0, [rule("speech.rate_high", True)]) is None
    assert engine.evaluate(T0 + 7.9, [rule("speech.rate_high", True)]) is None
    fb = engine.evaluate(T0 + 8, [rule("speech.rate_high", True)])
    assert fb["rule_id"] == "speech.rate_high" and fb["evidence_event_ids"] == ["ev1"]
    assert fb["suggested_action"] == "Try slowing your next sentence."
    assert fb["cooldown"]["rule_cooldown_s"] == 30 and fb["quality_state"] == "good"
    # still fast but not re-armed (hysteresis) even after the cooldown
    assert engine.evaluate(T0 + 50, [rule("speech.rate_high", True)]) is None
    engine.evaluate(T0 + 51, [rule("speech.rate_high", False, clear=True)])   # slowed down -> re-armed
    engine.evaluate(T0 + 52, [rule("speech.rate_high", True)])
    assert engine.evaluate(T0 + 60, [rule("speech.rate_high", True)])["rule_id"] == "speech.rate_high"


def test_priority_one_at_a_time_and_quality_suppression():
    cfg = CoachingConfig(global_min_interval_s=8, display_s=6)
    for r in cfg.rules.values():
        r.sustain_s = 0
    engine = CoachingEngine(cfg)
    both = [rule("heart.above_reference", True), rule("body.tracking_lost", True)]
    assert engine.evaluate(T0, both)["rule_id"] == "body.tracking_lost"           # priority 1 wins
    assert engine.evaluate(T0 + 3, both) is None                                   # one at a time
    assert engine.evaluate(T0 + 9, both)["rule_id"] == "heart.above_reference"     # waited its turn
    stale = [rule("speech.fillers", True, quality="stale")]
    assert engine.evaluate(T0 + 30, stale) is None
    assert engine.status()["speech.fillers"]["suppressed_by_quality"] == 1


def test_texts_are_observations_not_diagnoses():
    from coach.coaching import TEMPLATES
    text = " ".join(" ".join(pair) for lang in TEMPLATES.values() for pair in lang.values()).lower()
    for word in ("nervous", "anxious", "anxiety", "stress", "panic", "nervoz", "anksioz", "stres"):
        assert word not in text


def test_end_to_end_rate_rule_in_session(manager, clock):
    s = make_session(manager, clock, config={"speech": {"wpm_window_s": 15, "min_words_for_rate": 10,
                                                        "min_speaking_s_for_rate": 4},
                                             "coaching": {"rules": {"speech.rate_high": {"sustain_s": 4}}}})
    d = Device()
    t = T0
    for k in range(8):                                                  # 12 words per 3.4 s ~ 210 wpm
        words = " ".join(f"w{i}" for i in range(12)).replace("w", "word")
        segs = [{"text": f"word{i}", "start_s": i * 0.28, "duration_s": 0.25} for i in range(12)]
        d.send(s, "speech.activity", vad("speech_start"), t)
        d.send(s, "speech.activity", vad("speech_end"), t + 3.4)
        clock.observe(t + 3.7)
        d.send(s, "speech.transcript.final", transcript(f"u{k}", 0, words, start=t, segments=segs), t + 3.7)
        t += 3.7
    rules = [h["rule_id"] for h in s.coach.history]
    assert rules == ["speech.rate_high"]
    fb = [e for e in s.log.all_events() if e["event_type"] == "coaching.feedback"][0]["payload"]
    assert fb["evidence_event_ids"] and fb["text_source"] == "template"
