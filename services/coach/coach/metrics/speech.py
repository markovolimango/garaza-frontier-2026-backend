"""Speaking observations from VAD transitions and transcripts.

Rules this module follows:
- Speech/silence and pauses come only from speech.activity (VAD) events in audio time,
  never from transcription callback timing.
- Only finalized transcripts feed authoritative metrics; partial results are reported
  separately as provisional. A newer revision of an utterance replaces the older one, so
  revisions are never double counted.
- Nothing is counted outside running segments (before start, while paused) or inside
  synthesized-playback suppression intervals (the system must not analyse its own voice).
"""

from __future__ import annotations

import bisect
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

from coach.config import SpeechConfig

LEXICON_DIR = Path(__file__).resolve().parent.parent / "lexicons"
TOKEN_RE = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?", re.UNICODE)
SECONDS_PER_WORD_GUESS = 0.35

Interval = tuple[float, float]


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(unicodedata.normalize("NFKC", text).lower())


def load_lexicon(language: str) -> dict:
    primary = language.replace("_", "-").split("-")[0].lower()
    path = LEXICON_DIR / f"{primary}.json"
    if not path.is_file():
        return {"language": primary, "phrases": [], "available": False}
    data = json.loads(path.read_text(encoding="utf-8"))
    data["available"] = True
    return data


class FillerCounter:
    def __init__(self, phrases: list[str]):
        self.phrases = sorted({tuple(tokenize(p)) for p in phrases if tokenize(p)}, key=len, reverse=True)

    def find(self, tokens: list[str]) -> list[tuple[int, str]]:
        """Non-overlapping matches (longest phrase first): [(token_index, phrase)]."""
        hits, i = [], 0
        while i < len(tokens):
            for phrase in self.phrases:
                if tuple(tokens[i:i + len(phrase)]) == phrase:
                    hits.append((i, " ".join(phrase)))
                    i += len(phrase)
                    break
            else:
                i += 1
        return hits


def _overlap(a: Interval, b: Interval) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def _covered(t: float, intervals: list[Interval]) -> bool:
    return any(s <= t <= e for s, e in intervals)


class SpeechTracker:
    def __init__(self, cfg: SpeechConfig):
        self.cfg = cfg
        lexicon = load_lexicon(cfg.language)
        phrases = cfg.filler_lexicon if cfg.filler_lexicon is not None else lexicon["phrases"]
        self.lexicon_info = {"language": lexicon["language"], "source": "session_config" if cfg.filler_lexicon
                             is not None else ("builtin" if lexicon["available"] else "none"),
                             "phrases": len(phrases), "note": lexicon.get("note")}
        self.fillers = FillerCounter(phrases)
        self._vad: list[tuple[float, str, str]] = []      # (t, transition, event_id), sorted by t
        self.vad_method: str | None = None
        self.vad_calibrated = False
        self.finals: dict[str, dict] = {}
        self.partials: dict[str, dict] = {}
        self._playback: dict[str, list] = {}              # playback_id -> [start, end|None]
        self.revisions_replaced = 0
        self.stale_revisions = 0
        self._static_cache: tuple | None = None

    # ----------------------------------------------------------------------- inputs
    def on_activity(self, t: float, payload: dict, event_id: str) -> None:
        bisect.insort(self._vad, (t, payload["transition"], event_id))
        self.vad_method = payload.get("vad_method")
        self.vad_calibrated = self.vad_calibrated or bool(payload.get("calibrated"))

    def on_playback(self, t: float, payload: dict) -> None:
        pid, state = payload["playback_id"], payload["state"]
        if state in ("scheduled", "started"):
            interval = self._playback.setdefault(pid, [t, None])
            interval[0] = min(interval[0], t)
        elif state in ("finished", "interrupted", "skipped"):
            interval = self._playback.setdefault(pid, [t, None])
            interval[1] = t + self.cfg.playback_tail_s

    def on_transcript(self, t: float, payload: dict, final: bool, event_id: str) -> str:
        uid, revision = payload["utterance_id"], payload["revision"]
        if final:
            stored = self.finals.get(uid)
            if stored and revision <= stored["revision"]:
                self.stale_revisions += 1
                return "stale_revision"
            if stored:
                self.revisions_replaced += 1
            self.finals[uid] = self._utterance(t, payload, event_id)
            self.partials.pop(uid, None)
            return "replaced" if stored else "applied"
        if uid in self.finals:
            return "ignored_after_final"
        stored = self.partials.get(uid)
        if stored and revision <= stored["revision"]:
            self.stale_revisions += 1
            return "stale_revision"
        self.partials[uid] = self._utterance(t, payload, event_id)
        return "applied"

    def _utterance(self, t: float, payload: dict, event_id: str) -> dict:
        start = payload.get("_audio_start_t")
        words: list[tuple[float, str]] = []
        segments = payload.get("segments") or []
        if segments and start is not None:
            for seg in segments:
                for token in tokenize(seg["text"]):
                    words.append((start + seg["start_s"], token))
        else:
            tokens = tokenize(payload["text"])
            begin = start if start is not None else t - len(tokens) * SECONDS_PER_WORD_GUESS
            span = max(t - begin, 1e-3)
            words = [(begin + span * (i + 0.5) / max(len(tokens), 1), tok) for i, tok in enumerate(tokens)]
        tokens = [w for _, w in words]
        fillers = [(words[i][0], phrase) for i, phrase in self.fillers.find(tokens)]
        audio_end = t
        if segments and start is not None:
            audio_end = max(start + seg["start_s"] + seg["duration_s"] for seg in segments)
        return {"revision": payload["revision"], "event_id": event_id, "end_t": t, "audio_end_t": audio_end,
                "words": words,
                "fillers": fillers, "timing": "segments" if segments and start is not None else "estimated"}

    # ----------------------------------------------------------------------- intervals
    def suppression_intervals(self, now: float) -> list[Interval]:
        return [(s, e if e is not None else now) for s, e in self._playback.values()]

    def speech_intervals(self, now: float) -> list[Interval]:
        closed, open_start = self._vad_pairs()
        return closed + ([(open_start, now)] if open_start is not None and open_start <= now else [])

    def _vad_pairs(self) -> tuple[list[Interval], float | None]:
        intervals, open_start = [], None
        for t, transition, _ in self._vad:
            if transition == "speech_start":
                if open_start is None:
                    open_start = t
            elif open_start is not None:
                intervals.append((open_start, t))
                open_start = None
        return intervals, open_start

    @staticmethod
    def _clip(intervals: list[Interval], allowed: list[Interval], blocked: list[Interval]) -> list[Interval]:
        result = []
        for s, e in intervals:
            for a, b in allowed:
                lo, hi = max(s, a), min(e, b)
                if hi > lo:
                    result.append((lo, hi))
        for bs, be in blocked:
            cut = []
            for s, e in result:
                if be <= s or bs >= e:
                    cut.append((s, e))
                    continue
                if bs > s:
                    cut.append((s, bs))
                if be < e:
                    cut.append((be, e))
            result = cut
        return sorted(result)

    def _version_key(self) -> tuple:
        return (len(self._vad), self._vad[-1] if self._vad else None, tuple(sorted(
            (k, v[0], v[1]) for k, v in self._playback.items())),
            tuple((uid, u["revision"]) for uid, u in self.finals.items()),
            tuple((uid, u["revision"]) for uid, u in self.partials.items()))

    def _static(self, running: list[tuple[float, float | None]]) -> dict:
        """Everything that depends only on inputs (not on 'now'); rebuilt when inputs change."""
        key = (self._version_key(), tuple(running))
        if self._static_cache is not None and self._static_cache[0] == key:
            return self._static_cache[1]
        inf = float("inf")
        allowed = [(s, e if e is not None else inf) for s, e in running]
        blocked = [(s, e if e is not None else inf) for s, e in self._playback.values()]

        def countable(t: float) -> bool:
            return _covered(t, allowed) and not _covered(t, blocked)

        finals = sorted((t, w, u["event_id"]) for u in self.finals.values() for t, w in u["words"] if countable(t))
        partials = sorted((t, w, u["event_id"]) for u in self.partials.values() for t, w in u["words"] if countable(t))
        fillers = sorted((t, p, u["event_id"]) for u in self.finals.values() for t, p in u["fillers"] if countable(t))
        closed, open_start = self._vad_pairs()
        clipped = self._clip(closed, allowed, blocked)
        boundary = clipped + (self._clip([(open_start, open_start + 1e-6)], allowed, blocked) if open_start else [])
        evidence = {t: eid for t, _, eid in self._vad}
        pauses = []
        for (s1, e1), (s2, _e2) in zip(boundary, boundary[1:]):
            if s2 <= e1:
                continue
            same_segment = any(a <= e1 and s2 <= b for a, b in allowed)
            if not same_segment or any(_overlap((e1, s2), b) > 0 for b in blocked):
                continue
            pauses.append({"started_at_t": e1, "ended_at_t": s2, "duration_s": round(s2 - e1, 2),
                           "evidence": [x for x in (evidence.get(e1), evidence.get(s2)) if x]})
        static = {
            "finals": finals, "final_times": [w[0] for w in finals],
            "partials": partials, "partial_times": [w[0] for w in partials],
            "fillers": fillers, "filler_times": [f[0] for f in fillers],
            "clipped": clipped, "clipped_ends": [e for _, e in clipped],
            "open_start": open_start, "pauses": pauses,
            "speaking_closed": sum(e - s for s, e in clipped),
            "fillers_total": dict(Counter(p for _, p, _ in fillers)),
            "final_horizon": max((u["audio_end_t"] for u in self.finals.values()), default=None),
            "blocked": blocked,
        }
        self._static_cache = (key, static)
        return static

    # ----------------------------------------------------------------------- outputs
    def evaluate(self, now: float, running: list) -> dict:
        """`running`: session running segments [(start, end or None while running)]."""
        cfg = self.cfg
        running = [(s, e) for s, e in running]
        st = self._static([(s, None if e is None or e >= now else e) for s, e in running])
        running_closed = [(s, e if e is not None and e < now else now) for s, e in running]
        blocked_now = [(s, min(e, now)) for s, e in st["blocked"] if s <= now]
        vad_seen = bool(self._vad)
        open_part = []
        if st["open_start"] is not None and st["open_start"] <= now:
            open_part = self._clip([(st["open_start"], now)], running_closed, blocked_now)
        speech = st["clipped"] + open_part
        basis = "speech_active_time" if vad_seen else "elapsed_running_time"
        final_horizon = min(now, st["final_horizon"]) if st["final_horizon"] is not None else now

        def speaking(window: Interval) -> float:
            if not vad_seen:
                return sum(_overlap(i, window) for i in running_closed)
            total = sum(_overlap(i, window) for i in open_part)
            index = bisect.bisect_left(st["clipped_ends"], window[0])
            for s0, e0 in st["clipped"][index:]:
                if s0 >= window[1]:
                    break
                total += _overlap((s0, e0), window)
            return total

        def window_slice(items: list, times: list, window: Interval) -> list:
            return items[bisect.bisect_left(times, window[0]):bisect.bisect_right(times, window[1])]

        final_window = (final_horizon - cfg.wpm_window_s, final_horizon)
        live_window = (now - cfg.wpm_window_s, now)
        final_words = window_slice(st["finals"], st["final_times"], final_window)
        provisional_words = (window_slice(st["finals"], st["final_times"], live_window)
                             + window_slice(st["partials"], st["partial_times"], live_window))
        speaking_final, speaking_live = speaking(final_window), speaking(live_window)

        def rate(count: int, spoken: float) -> float | None:
            if count < cfg.min_words_for_rate or spoken < cfg.min_speaking_s_for_rate:
                return None
            return round(count / (spoken / 60.0), 1)

        final_rate = rate(len(final_words), speaking_final)
        speaking_total = st["speaking_closed"] + sum(e - s for s, e in open_part) if vad_seen else None
        filler_window = window_slice(st["fillers"], st["filler_times"], (now - cfg.filler_window_s, now))
        long_pauses = [p for p in st["pauses"] if p["duration_s"] >= cfg.long_pause_s]
        countable_now = _covered(now, running_closed) and not _covered(now, blocked_now)
        current_silence = None
        if vad_seen and self._vad[-1][1] == "speech_end" and countable_now:
            current_silence = round(now - self._vad[-1][0], 2)
        quality = "good" if vad_seen else "degraded"
        if final_rate is None and quality == "good":
            quality = "insufficient_data"
        return {
            "language": cfg.language,
            "final": {
                "words_in_window": len(final_words),
                "rate_wpm": final_rate,
                "rate_basis": basis,
                "window_s": cfg.wpm_window_s,
                "window_end_at_t": final_horizon,
                "words_total": len(st["finals"]),
                "rate_wpm_session": (round(len(st["finals"]) / (speaking_total / 60.0), 1)
                                     if speaking_total and speaking_total >= cfg.min_speaking_s_for_rate else None),
                "fillers_in_window": len(filler_window),
                "filler_window_s": cfg.filler_window_s,
                "fillers_total": st["fillers_total"],
                "filler_lexicon": self.lexicon_info,
                "utterances": len(self.finals),
                "revisions_replaced": self.revisions_replaced,
            },
            "provisional": {"words_in_window": len(provisional_words),
                            "rate_wpm": rate(len(provisional_words), speaking_live),
                            "open_utterances": len(self.partials), "note": "includes partial results; may change"},
            "activity": {
                "vad_method": self.vad_method or "none",
                "vad_calibrated": self.vad_calibrated,
                "current_state": ("unknown" if not vad_seen else
                                  "speech" if self._vad[-1][1] == "speech_start" else "silence"),
                "speaking_time_s": None if speaking_total is None else round(speaking_total, 2),
                "speaking_time_in_window_s": round(speaking_final, 2),
                "current_silence_s": current_silence,
                "long_pause_threshold_s": cfg.long_pause_s,
                "long_pauses_total": len(long_pauses),
                "long_pauses_recent": [p for p in long_pauses if now - p["ended_at_t"] <= cfg.filler_window_s],
                "suppressed_intervals": len(st["blocked"]),
                "suppressed_now": not countable_now and _covered(now, blocked_now),
                "limitations": "Energy VAD is a heuristic: background noise and other voices count as speech.",
            },
            "quality": quality,
            "_rule": {"rate": final_rate, "rate_evidence": sorted({e for _, _, e in final_words})[-10:],
                      "fillers_window": filler_window, "long_pauses": long_pauses, "vad_seen": vad_seen},
        }
