from conftest import T0, Device, make_session, transcript, vad
from coach.config import SpeechConfig
from coach.metrics.speech import FillerCounter, SpeechTracker, tokenize

RUN = [(T0, T0 + 1000)]


def words_payload(uid, rev, n, start, step=0.3):
    words = [f"word{chr(97 + i % 26)}" for i in range(n)]
    segs = [{"text": w, "start_s": i * step, "duration_s": step * 0.9} for i, w in enumerate(words)]
    p = transcript(uid, rev, " ".join(words), start=start, segments=segs)
    p["_audio_start_t"] = start
    return p


def test_revisions_replace_and_partials_never_count():
    sp = SpeechTracker(SpeechConfig(min_words_for_rate=1, min_speaking_s_for_rate=0.1))
    sp.on_activity(T0, vad("speech_start"), "v1")
    sp.on_activity(T0 + 6, vad("speech_end"), "v2")
    assert sp.on_transcript(T0 + 2, words_payload("u1", 0, 5, T0), False, "p0") == "applied"
    assert sp.evaluate(T0 + 7, RUN)["final"]["words_total"] == 0      # partial is provisional only
    assert sp.on_transcript(T0 + 6.3, words_payload("u1", 1, 18, T0), True, "f1") == "applied"
    assert sp.on_transcript(T0 + 6.5, words_payload("u1", 2, 20, T0), True, "f2") == "replaced"
    assert sp.on_transcript(T0 + 6.6, words_payload("u1", 1, 18, T0), True, "f1b") == "stale_revision"
    assert sp.on_transcript(T0 + 6.7, words_payload("u1", 3, 2, T0), False, "late-partial") == "ignored_after_final"
    out = sp.evaluate(T0 + 7, RUN)
    assert out["final"]["words_total"] == 20 and out["final"]["revisions_replaced"] == 1


def test_rate_uses_speech_active_time_up_to_last_final():
    sp = SpeechTracker(SpeechConfig(wpm_window_s=20, min_words_for_rate=5, min_speaking_s_for_rate=2))
    for k in range(3):                                                 # 3 x (10 words in 4 s) + 1 s pauses
        start = T0 + k * 5
        sp.on_activity(start, vad("speech_start"), f"s{k}")
        sp.on_activity(start + 4, vad("speech_end"), f"e{k}")
        sp.on_transcript(start + 4.3, words_payload(f"u{k}", 0, 10, start, step=0.4), True, f"f{k}")
    sp.on_activity(T0 + 15, vad("speech_start"), "s3")                 # ongoing utterance, no final yet
    out = sp.evaluate(T0 + 18, RUN)
    # 30 words / ~12 s of speech up to the end of the last finalized word (13.96 s); the ongoing
    # utterance's speech time is excluded because its words are not final yet.
    assert abs(out["final"]["rate_wpm"] - 150.0) < 1.0
    assert out["activity"]["current_state"] == "speech"


def test_pauses_come_from_vad_not_transcript_delay():
    sp = SpeechTracker(SpeechConfig(long_pause_s=2.0))
    sp.on_activity(T0, vad("speech_start"), "a")
    sp.on_activity(T0 + 3, vad("speech_end"), "b")
    sp.on_activity(T0 + 3.5, vad("speech_start"), "c")                 # 0.5 s pause only
    sp.on_activity(T0 + 6, vad("speech_end"), "d")
    sp.on_transcript(T0 + 12, words_payload("u", 0, 8, T0), True, "f")  # final arrives 6 s later
    out = sp.evaluate(T0 + 13, RUN)
    assert out["activity"]["long_pauses_total"] == 0
    sp.on_activity(T0 + 9, vad("speech_start"), "e")                   # 3 s silence between speech
    assert sp.evaluate(T0 + 13, RUN)["activity"]["long_pauses_total"] == 1


def test_silence_before_start_and_while_paused_is_not_a_pause(manager, clock):
    s = make_session(manager, clock, running=False)
    d = Device()
    d.send(s, "speech.activity", vad("speech_start"), T0 + 1)
    d.send(s, "speech.activity", vad("speech_end"), T0 + 2)
    clock.advance(10)
    s.transition("start")                                              # 8 s of silence before start
    d.send(s, "speech.activity", vad("speech_start"), T0 + 11)
    d.send(s, "speech.activity", vad("speech_end"), T0 + 13)
    clock.advance(4)
    s.transition("pause")
    clock.advance(10)                                                  # silence while paused
    s.transition("resume")
    d.send(s, "speech.activity", vad("speech_start"), T0 + 25)
    d.send(s, "speech.activity", vad("speech_end"), T0 + 27)
    clock.advance(4)
    out = s.speech.evaluate(clock.now(), s.running_intervals(clock.now()))
    assert out["activity"]["long_pauses_total"] == 0


def test_playback_suppresses_own_voice():
    sp = SpeechTracker(SpeechConfig(playback_tail_s=0.5, min_words_for_rate=1, min_speaking_s_for_rate=0.1))
    sp.on_playback(T0 + 2, {"playback_id": "pb1", "state": "started"})
    sp.on_playback(T0 + 5, {"playback_id": "pb1", "state": "finished"})
    sp.on_activity(T0 + 2.2, vad("speech_start"), "a")                 # the synthesizer heard by the mic
    sp.on_activity(T0 + 4.9, vad("speech_end"), "b")
    sp.on_transcript(T0 + 5.2, words_payload("tts", 0, 8, T0 + 2.2), True, "f")
    out = sp.evaluate(T0 + 6, RUN)
    assert out["final"]["words_total"] == 0 and out["activity"]["speaking_time_s"] == 0
    assert out["activity"]["suppressed_intervals"] == 1


def test_filler_lexicons():
    assert tokenize("Um, you know — it's ZNAČI fine.") == ["um", "you", "know", "it's", "znači", "fine"]
    counter = FillerCounter(["um", "you know", "ovaj", "овај"])
    hits = counter.find(tokenize("um so you know um I mean"))
    assert [h[1] for h in hits] == ["um", "you know", "um"]
    sr = SpeechTracker(SpeechConfig(language="sr-RS"))
    assert sr.lexicon_info["source"] == "builtin" and sr.lexicon_info["language"] == "sr"
    assert [h[1] for h in sr.fillers.find(tokenize("Ovaj, ja mislim da овај znači"))] == ["ovaj", "овај", "znači"]
    unknown = SpeechTracker(SpeechConfig(language="xx-YY"))
    assert unknown.lexicon_info["source"] == "none"
