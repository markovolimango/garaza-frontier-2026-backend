"""Bridge: coach backend (/v1/stream) -> brain (/ws/control), over WebSockets.

The two projects stay separate repos and separate processes; this process only connects them.
It follows the coach's latest active session and forwards, to the brain
(github.com/markovolimango/garaza-frontier-2026-backend, default http://127.0.0.1:8787):

  body.metrics       -> sensor.status   (role "sensor": camera ok / no_person / error, fps), on change or 1 Hz
  coaching.feedback  -> behavior sway start/end   (role "sensor"; only body.torso_movement_high maps
                        to a sensor behaviour the brain protocol accepts)
                     -> operator.override vignette (role "operator") while a run is live, so the stage
                        shows the red edge vignette. Follows the brain's run settings: nothing in the
                        baseline/test runs (feedbackLevel off), nothing while JJ is listening (paused),
                        only for categories in run.enabledCategories; gentle = softer.

Why the operator override: the brain accepts `behavior` but has no feedback controller yet, so
nothing would show. The override is a message the brain already handles. The brain allows one
connection per role, so use --no-vignette when a real operator panel is open.

  python -m coach brain-bridge [--url http://127.0.0.1:8765] [--brain http://127.0.0.1:8787] [--force]
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from coach.client import ws_url

log = logging.getLogger("coach.brain_bridge")

PROTOCOL = 1
CLOSE_REPLACED = 4001
LIVE_RUN_PHASES = {"presentation", "qa"}
STREAM_TYPES = ["coaching.feedback", "body.metrics", "session.state"]

# coach rule -> brain FeedbackCategory (rules about the presenter's behaviour only; tracking and heart rate are not)
RULE_CATEGORY: dict[str, str] = {
    "body.torso_movement_high": "movement",
    "body.hand_movement_high": "movement",
    "speech.rate_high": "pace",
    "speech.long_pauses": "pace",
    "speech.fillers": "disfluencies",
}
# coach rule -> brain `behavior` uplink kind (the protocol only accepts arms_crossed, sway, face_touch, looking_down)
RULE_SENSOR_BEHAVIOR: dict[str, str] = {"body.torso_movement_high": "sway"}

INTENSITY = {"strong": 0.7, "gentle": 0.4}
HOLD_MS_MIN, HOLD_MS_MAX, HOLD_MS_DEFAULT = 1500, 6000, 3000


# ---------------------------------------------------------------- pure mapping

def envelope(kind: str, payload: dict) -> dict:
    return {"v": PROTOCOL, "type": kind, "id": f"cb_{uuid.uuid4().hex[:12]}", "ts": int(time.time() * 1000),
            "payload": payload}


def sensor_status(body: dict) -> dict:
    """body.metrics payload -> brain sensor.status payload."""
    state = body.get("tracking_state")
    window = body.get("window_s") or 0
    fps = round(body.get("frames_in_window", 0) / window, 1) if window > 0 else 0.0
    present = bool(body.get("body_present"))
    if state in ("tracking", "partial"):
        return {"camera": "ok", "fps": fps, "posePresent": present}
    if state == "stale":
        return {"camera": "error", "fps": fps, "posePresent": False, "message": "no fresh pose frames"}
    message = "person not visible" if state == "lost" else "waiting for pose frames"
    return {"camera": "no_person", "fps": fps, "posePresent": False, "message": message}


def hold_ms(feedback: dict, now: datetime | None = None) -> int:
    """How long the vignette stays: until the feedback expires, clamped to 1.5-6 s."""
    try:
        expires = datetime.fromisoformat(str(feedback["expires_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return HOLD_MS_DEFAULT
    left = (expires - (now or datetime.now(timezone.utc))).total_seconds() * 1000
    return int(min(HOLD_MS_MAX, max(HOLD_MS_MIN, left)))


def run_is_live(run: dict | None, session_phase: str | None) -> bool:
    return bool(run) and session_phase == "running" and run.get("phase") in LIVE_RUN_PHASES and not run.get("paused")


def vignette_for(feedback: dict, run: dict | None, session_phase: str | None, *, force: bool = False,
                 now: datetime | None = None) -> dict | None:
    """coaching.feedback payload + brain run state -> operator.override payload, or None."""
    category = RULE_CATEGORY.get(feedback.get("rule_id", ""))
    if category is None or not run_is_live(run, session_phase):
        return None
    level = run.get("feedbackLevel")
    if not force and (level not in INTENSITY or category not in run.get("enabledCategories", [])):
        return None
    return {"action": "vignette", "kind": "warn", "intensity": INTENSITY.get(level, INTENSITY["strong"]),
            "holdMs": hold_ms(feedback, now)}


# ---------------------------------------------------------------- brain connection

class BrainLink:
    """One /ws/control connection for one role: hello, pong, reconnect with backoff.
    A connection replaced by another client with the same role (close 4001) is not retaken."""

    def __init__(self, base_url: str, role: str, on_message: Callable[[dict], None] | None = None):
        self.url = ws_url(base_url, "/ws/control")
        self.role = role
        self.client_id = f"coach-bridge-{role}-{socket.gethostname().split('.')[0]}"[:64]
        self.on_message = on_message
        self.ws: Any = None
        self.replaced = False

    @property
    def open(self) -> bool:
        return self.ws is not None

    async def send(self, kind: str, payload: dict) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps(envelope(kind, payload)))
            return True
        except ConnectionClosed:
            return False

    async def run(self) -> None:
        delay = 0.5
        while not self.replaced:
            try:
                async with websockets.connect(self.url, open_timeout=5) as ws:
                    await ws.send(json.dumps(envelope("hello", {"role": self.role, "clientId": self.client_id,
                                                                "protocol": PROTOCOL})))
                    self.ws, delay = ws, 0.5
                    log.info("brain: connected as %s", self.role)
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") == "ping":
                            await ws.send(json.dumps(envelope("pong", {})))
                        elif msg.get("type") == "error":
                            log.warning("brain (%s): %s", self.role, msg.get("payload"))
                        elif self.on_message:
                            self.on_message(msg)
            except ConnectionClosed as exc:
                if exc.rcvd is not None and exc.rcvd.code == CLOSE_REPLACED:
                    self.replaced = True
                    log.warning("brain: another %s client connected; the bridge stops using this role", self.role)
                else:
                    log.info("brain: %s connection closed (%s)", self.role, exc.rcvd.code if exc.rcvd else "-")
            except (OSError, InvalidHandshake, asyncio.TimeoutError) as exc:
                log.info("brain: %s unreachable at %s (%s), retrying", self.role, self.url, type(exc).__name__)
            finally:
                self.ws = None
            if not self.replaced:
                await asyncio.sleep(delay)
                delay = min(5.0, delay * 2)


# ---------------------------------------------------------------- bridge

class Bridge:
    def __init__(self, coach_url: str, brain_url: str, token: Callable[[], str], *, vignette: bool = True,
                 force: bool = False):
        self.coach_url, self.token = coach_url, token   # re-read per connect: the coach writes a new token per run
        self.force = force
        self.run_state: dict | None = None
        self.session_phase: str | None = None
        self.sensor = BrainLink(brain_url, "sensor", self._on_brain)
        self.operator = BrainLink(brain_url, "operator") if vignette else None
        self.session_id: str | None = None
        self._last_status: tuple[dict, float] | None = None
        self._behavior_end: dict[str, asyncio.TimerHandle] = {}
        self.stats = {"feedback": 0, "vignettes": 0, "behaviors": 0, "status": 0}

    # brain -> bridge
    def _on_brain(self, msg: dict) -> None:
        if msg.get("type") == "run.state":
            p = msg.get("payload") or {}
            self.run_state, self.session_phase = p.get("run"), p.get("sessionPhase")

    # coach -> brain
    async def handle_event(self, event: dict) -> None:
        kind, payload = event.get("event_type"), event.get("payload") or {}
        if kind == "body.metrics":
            await self._status(sensor_status(payload))
        elif kind == "coaching.feedback":
            await self._feedback(payload)
        elif kind == "session.state":
            log.info("coach: session %s is %s", (self.session_id or "")[:12], payload.get("state"))

    async def _status(self, status: dict) -> None:
        now = time.monotonic()
        if self._last_status and self._last_status[0] == status and now - self._last_status[1] < 1.0:
            return
        if await self.sensor.send("sensor.status", status):
            self._last_status = (status, now)
            self.stats["status"] += 1

    async def _feedback(self, fb: dict) -> None:
        self.stats["feedback"] += 1
        rule = fb.get("rule_id", "")
        hold = hold_ms(fb)
        behavior = RULE_SENSOR_BEHAVIOR.get(rule)
        if behavior:
            await self._behavior(behavior, hold)
        vignette = vignette_for(fb, self.run_state, self.session_phase, force=self.force)
        sent = bool(vignette and self.operator and await self.operator.send("operator.override", vignette))
        self.stats["vignettes"] += sent
        why = ("vignette" if sent else "not a presenter behaviour" if rule not in RULE_CATEGORY
               else "run not live / feedback off" if not vignette else "operator role unavailable")
        log.info("coach feedback %-26s -> %s  (%s)", rule, why, fb.get("display_text", "")[:60])

    async def _behavior(self, kind: str, hold: int) -> None:
        loop = asyncio.get_running_loop()
        timer = self._behavior_end.pop(kind, None)
        if timer:
            timer.cancel()   # still active: extend
        elif await self.sensor.send("behavior", {"kind": kind, "phase": "start", "clientTs": int(time.time() * 1000), "conf": 1.0}):
            self.stats["behaviors"] += 1

        def end() -> None:
            self._behavior_end.pop(kind, None)
            loop.create_task(self.sensor.send("behavior", {"kind": kind, "phase": "end",
                                                           "clientTs": int(time.time() * 1000), "conf": 1.0}))
        self._behavior_end[kind] = loop.call_later(hold / 1000, end)

    async def follow_coach(self) -> None:
        url = ws_url(self.coach_url, "/v1/stream")
        delay = 0.5
        while True:
            try:
                token = self.token()
                async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {token}"},
                                              open_timeout=5, max_size=2**22) as ws:
                    hello = json.loads(await ws.recv())
                    if hello.get("type") != "auth.ok":
                        raise RuntimeError(f"coach stream auth failed: {hello}")
                    delay = 0.5
                    log.info("coach: connected to %s", url)
                    await self._subscribe(ws)
                    async for raw in ws:
                        msg = json.loads(raw)
                        t = msg.get("type")
                        if t == "error" and (msg.get("error") or {}).get("code") == "no_active_session":
                            if self.session_id != "":   # log once per waiting period
                                log.info("coach: waiting for a session (start one in the app / vision --coach)")
                            self.session_id = ""
                            await asyncio.sleep(2)
                            await self._subscribe(ws)
                        elif t == "snapshot":
                            self.session_id = msg["snapshot"]["session"]["session_id"]
                            log.info("coach: following session %s", self.session_id)
                        elif t == "event":
                            event = msg["event"]
                            await self.handle_event(event)
                            if event.get("event_type") == "session.state" and event["payload"].get("state") == "ended":
                                await asyncio.sleep(1)
                                await self._subscribe(ws)
            except SystemExit as exc:   # operator_token(): no token file yet (coach not started)
                log.info("coach: %s", exc)
            except InvalidStatus as exc:
                log.error("coach: stream refused (%s); check the operator token", exc.response.status_code)
            except (OSError, ConnectionClosed, InvalidHandshake, asyncio.TimeoutError) as exc:
                log.info("coach: unreachable at %s (%s), retrying", url, type(exc).__name__)
            await asyncio.sleep(delay)
            delay = min(5.0, delay * 2)

    @staticmethod
    async def _subscribe(ws) -> None:
        await ws.send(json.dumps({"type": "subscribe", "session_id": "latest", "event_types": STREAM_TYPES,
                                  "after_cursor": None}))

    async def run(self) -> None:
        tasks = [self.sensor.run(), self.follow_coach()]
        if self.operator:
            tasks.append(self.operator.run())
        await asyncio.gather(*tasks)


def run_bridge(coach_url: str, brain_url: str, token: Callable[[], str], *, vignette: bool = True,
               force: bool = False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    log.info("bridge: coach %s -> brain %s (vignette: %s)", coach_url, brain_url,
             "off" if not vignette else "always during runs" if force else "follows the brain's run settings")
    asyncio.run(Bridge(coach_url, brain_url, token, vignette=vignette, force=force).run())
