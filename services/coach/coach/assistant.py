"""Adapter to the optional native macOS helper (apple/MacAssistant): speech synthesis and
Foundation Models. Everything here is optional: timeouts and failures fall back to the
deterministic templates, and the baseline system never waits on it longer than the timeout.

Foundation Models output is only used for `display_text` / narratives, after a safety check:
no emotional or medical claims, no numbers that were not in the input, bounded length.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from typing import TYPE_CHECKING

import httpx

from coach.config import Settings
from coach.wire import EventType

if TYPE_CHECKING:
    from coach.session import Session

BANNED = re.compile(
    r"nerv|anxi|stress|panic|fear|afraid|scared|worr|calm down|diagnos|medical|disease|disorder|heart (attack|problem)|"
    r"emotion|anksi|stres|panik|strah|uplaš|smiri|bolest|dijagno",
    re.IGNORECASE)
NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def safe_generated_text(text: str | None, source: str, max_chars: int = 220) -> bool:
    if not text or len(text) > max_chars or BANNED.search(text):
        return False
    allowed = set(NUMBER.findall(source))
    return all(n in allowed for n in NUMBER.findall(text))


class AssistantClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._status: tuple[float, dict] | None = None
        self._client = httpx.AsyncClient(base_url=settings.assistant_url, timeout=settings.assistant_timeout_s)

    def _headers(self) -> dict:
        try:
            token = self.settings.assistant_token_file.read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def close(self) -> None:
        await self._client.aclose()

    async def status(self, max_age_s: float = 15.0) -> dict:
        if not self.settings.assistant_enabled:
            return {"reachable": False, "reason": "disabled by configuration"}
        if self._status and time.time() - self._status[0] < max_age_s:
            return self._status[1]
        try:
            response = await self._client.get("/v1/status", headers=self._headers(), timeout=1.0)
            response.raise_for_status()
            data = {"reachable": True, **response.json()}
        except (httpx.HTTPError, ValueError) as exc:
            data = {"reachable": False, "reason": f"{type(exc).__name__}: assistant not reachable at "
                                                  f"{self.settings.assistant_url}"}
        self._status = (time.time(), data)
        return data

    async def _post(self, path: str, body: dict, timeout: float | None = None) -> dict | None:
        if not self.settings.assistant_enabled:
            return None
        try:
            response = await self._client.post(path, json=body, headers=self._headers(),
                                               timeout=timeout or self.settings.assistant_timeout_s)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError):
            return None

    async def rephrase(self, observation: str, action: str, language: str) -> str | None:
        source = f"{observation} {action}"
        budget = self.settings.assistant_timeout_s
        result = await self._post("/v1/fm/rephrase", {"observation": observation, "suggested_action": action,
                                                      "language": language, "max_words": 25,
                                                      "timeout_s": max(0.5, budget - 0.3)}, timeout=budget)
        text = (result or {}).get("text")
        return text if safe_generated_text(text, source) else None

    async def summarize(self, facts: list[str], language: str) -> str | None:
        source = " ".join(facts)
        result = await self._post("/v1/fm/summarize", {"facts": facts, "language": language, "max_words": 80,
                                                       "timeout_s": 12.0}, timeout=14.0)
        text = (result or {}).get("text")
        return text if safe_generated_text(text, source, max_chars=700) else None

    async def speak(self, text: str, language: str, playback_id: str) -> dict | None:
        return await self._post("/v1/tts/speak", {"text": text, "language": language, "playback_id": playback_id},
                                timeout=30.0)


class FeedbackDelivery:
    """Publishes coaching feedback; optionally rephrases it and speaks it through the assistant.

    Playback queue per session: at most one item speaking and one pending. A newer suggestion
    replaces the pending one; pending items past their expiry are discarded as obsolete.
    Speech metrics are suppressed from 'started' until 'finished' + playback_tail_s.
    """

    def __init__(self, assistant: AssistantClient | None):
        self.assistant = assistant
        self._busy: dict[str, bool] = {}
        self._pending: dict[str, dict] = {}
        self.tasks: set[asyncio.Task] = set()

    def __call__(self, session: "Session", feedback: dict) -> None:
        cfg = session.config.coaching
        wants_assistant = self.assistant is not None and session.timeline == "live" and (
            cfg.rephrase_with_assistant or cfg.speak)
        if not wants_assistant:
            session.publish_feedback(feedback)
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            session.publish_feedback(feedback)
            return
        task = loop.create_task(self._deliver(session, feedback))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _deliver(self, session: "Session", feedback: dict) -> None:
        cfg = session.config.coaching
        if cfg.rephrase_with_assistant:
            text = await self.assistant.rephrase(feedback["observation"], feedback["suggested_action"],
                                                 feedback["language"])
            if text:
                feedback = {**feedback, "display_text": text, "text_source": "foundation_models"}
        session.publish_feedback(feedback)
        if cfg.speak:
            await self._speak(session, feedback)

    async def _speak(self, session: "Session", feedback: dict) -> None:
        if self._busy.get(session.id):
            self._pending[session.id] = feedback   # replaces an older pending item
            return
        self._busy[session.id] = True
        try:
            while feedback is not None:
                expires = feedback.get("expires_at")
                if expires and session.clock.now() > _parse(expires):
                    session_playback(session, "skipped", feedback, "text_only", reason="obsolete before playback")
                else:
                    await self._play_one(session, feedback)
                feedback = self._pending.pop(session.id, None)
        finally:
            self._busy[session.id] = False

    async def _play_one(self, session: "Session", feedback: dict) -> None:
        status = await self.assistant.status()
        if not status.get("reachable") or not status.get("tts", {}).get("available"):
            session_playback(session, "skipped", feedback, "text_only",
                             reason=status.get("reason") or "speech synthesis unavailable")
            return
        playback_id = f"pb-{uuid.uuid4().hex[:12]}"
        session_playback(session, "started", feedback, "avspeechsynthesizer", playback_id=playback_id)
        result = await self.assistant.speak(feedback["display_text"], feedback["language"], playback_id)
        state = (result or {}).get("state", "interrupted")
        if state not in ("finished", "interrupted", "skipped"):
            state = "interrupted"
        session_playback(session, state, feedback, "avspeechsynthesizer", playback_id=playback_id,
                         voice=(result or {}).get("voice"),
                         reason=None if result else "assistant did not confirm playback (timeout or error)")


def _parse(iso: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def session_playback(session: "Session", state: str, feedback: dict, engine: str, *, playback_id: str | None = None,
                     voice: str | None = None, reason: str | None = None) -> None:
    payload = {"state": state, "playback_id": playback_id or f"pb-{uuid.uuid4().hex[:12]}",
               "feedback_id": feedback.get("feedback_id"), "engine": engine, "voice": voice,
               "language": feedback.get("language"), "text": feedback.get("display_text"), "reason": reason}
    session.speech.on_playback(session.clock.now(), payload)
    session._dirty.add("speech")
    session._publish(EventType.audio_playback, payload)
