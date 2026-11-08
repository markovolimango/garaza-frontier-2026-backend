"""Bridge: coach backend (/v1/stream) -> brain (/ws/control), over WebSockets.

The two projects stay separate repos and separate processes; this process only connects them.
It follows the coach's latest active session and forwards, to the brain
(github.com/markovolimango/garaza-frontier-2026-backend, default http://127.0.0.1:8787):

  body.metrics       -> sensor.status   (role "sensor": camera ok / no_person / error, fps), on change or 1 Hz
  brain run          -> coach session: created and started when the presentation starts, paused
                        while JJ is listening, stopped when the run ends, so `vision/run.sh --coach`
                        (or the iPhone app) has a running session to send pose frames to. The session
                        config comes from services/coach/tuning.json (--tuning), re-read for every run.
                        When the brain's session is reset (no run, phase setup again: "Delete and start
                        over"), the coach sessions the bridge created for it are deleted from the coach.
  coaching.feedback  -> coach.observation (role "sensor"): every rule, with its behaviour kind when it has one, for
                        the brain's run report and coach policy
                     -> operator.override vignette (role "operator") while a run is live, so the stage
                        shows the red edge vignette. Follows the brain's run settings: nothing in the
                        baseline/test runs (feedbackLevel off), nothing while JJ is listening (paused),
                        only for the run's targets when it has some (else for run.enabledCategories);
                        gentle = softer.
  behavior.episode   -> behavior start/end (role "sensor"): every arms_crossed / face_touch / looking_down /
                        sway / fast_hands episode, with the episode's own start and end times (clientTs, epoch
                        ms). Starts only while a run is live; an end is sent only for a start the brain got.
                     -> operator.override reward (green vignette) when an episode of one of the run's targets
                        clears during a live run with feedback on: the presenter corrected it.

Why the operator override: the brain accepts `behavior` but has no feedback controller yet, so
nothing would show. The override is a message the brain already handles. The brain allows one
connection per role, so use --no-vignette when a real operator panel is open.

  python -m coach brain-bridge [--url http://127.0.0.1:8765] [--brain http://127.0.0.1:8787] [--force] [--no-sessions]
                               [--tuning services/coach/tuning.json]
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from coach.client import ApiError, CoachClient, ws_url
from coach.tuning import load_tuning

log = logging.getLogger("coach.brain_bridge")

PROTOCOL = 1
CLOSE_REPLACED = 4001
LIVE_RUN_PHASES = {"presentation", "qa"}
STREAM_TYPES = ["coaching.feedback", "body.metrics", "session.state", "behavior.episode"]

# coach rule -> brain FeedbackCategory (rules about the presenter's behaviour only; tracking and heart rate are not)
RULE_CATEGORY: dict[str, str] = {
    "body.torso_movement_high": "movement",
    "body.hand_movement_high": "movement",
    "body.arms_crossed": "posture",
    "body.face_touch": "posture",
    "body.looking_down": "gaze",
    "speech.rate_high": "pace",
    "speech.long_pauses": "pace",
    "speech.fillers": "disfluencies",
}
# coach rule -> brain BehaviorKind (what the brain's coach can pick as a training target)
RULE_KIND: dict[str, str] = {
    "body.torso_movement_high": "sway",
    "body.hand_movement_high": "fast_hands",
    "body.arms_crossed": "arms_crossed",
    "body.face_touch": "face_touch",
    "body.looking_down": "looking_down",
    "speech.rate_high": "pace_fast",
    "speech.fillers": "filler_burst",
    "speech.long_pauses": "long_pause",
}
# coach episode behaviours the brain's `behavior` uplink accepts (protocol SENSOR_BEHAVIORS; speech kinds come
# from the brain itself)
SENSOR_BEHAVIORS = {"arms_crossed", "face_touch", "looking_down", "sway", "fast_hands", "head_tilt", "hands_in_pockets"}
EPISODE_CONF = 1.0   # the detector's thresholds were crossed; not a calibrated probability
REWARD_HOLD_MS = 1500

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


def observation(feedback: dict) -> dict:
    """coaching.feedback payload -> brain coach.observation payload."""
    rule = str(feedback.get("rule_id", ""))[:64] or "unknown"
    return {"rule": rule, "kind": RULE_KIND.get(rule), "category": RULE_CATEGORY.get(rule),
            "text": str(feedback.get("display_text") or feedback.get("observation") or "")[:400],
            "clientTs": int(time.time() * 1000)}


def epoch_ms(iso: str) -> int:
    return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)


def behavior_message(episode: dict) -> dict | None:
    """behavior.episode payload -> brain `behavior` payload, or None for a behaviour the brain doesn't take."""
    kind, phase = episode.get("behavior"), episode.get("phase")
    at = episode.get("started_at") if phase == "start" else episode.get("ended_at")
    if kind not in SENSOR_BEHAVIORS or phase not in ("start", "end") or not at:
        return None
    return {"kind": kind, "phase": phase, "clientTs": epoch_ms(at), "conf": EPISODE_CONF}


def reward_for(episode: dict, run: dict | None, session_phase: str | None) -> dict | None:
    """A target's episode cleared during a live run with feedback on -> green vignette, else None."""
    if (episode.get("phase") != "end" or episode.get("end_reason") != "cleared"
            or not run_is_live(run, session_phase) or episode.get("behavior") not in (run.get("targets") or [])):
        return None
    level = run.get("feedbackLevel")
    if level not in INTENSITY:
        return None
    return {"action": "vignette", "kind": "reward", "intensity": INTENSITY[level], "holdMs": REWARD_HOLD_MS}


def run_is_live(run: dict | None, session_phase: str | None) -> bool:
    return bool(run) and session_phase == "running" and run.get("phase") in LIVE_RUN_PHASES and not run.get("paused")


def vignette_for(feedback: dict, run: dict | None, session_phase: str | None, *, force: bool = False,
                 now: datetime | None = None) -> dict | None:
    """coaching.feedback payload + brain run state -> operator.override payload, or None."""
    category = RULE_CATEGORY.get(feedback.get("rule_id", ""))
    if category is None or not run_is_live(run, session_phase):
        return None
    level = run.get("feedbackLevel")
    targets = run.get("targets") or []
    if not force:
        if level not in INTENSITY:
            return None
        if targets and RULE_KIND.get(feedback.get("rule_id", "")) not in targets:
            return None
        if not targets and category not in run.get("enabledCategories", []):
            return None
    return {"action": "vignette", "kind": "warn", "intensity": INTENSITY.get(level, INTENSITY["strong"]),
            "holdMs": hold_ms(feedback, now)}


def coach_session_plan(current: dict | None, run: dict | None, session_phase: str | None) -> list[str]:
    """Brain run -> actions on the coach session the bridge owns ({"id", "run_id", "state"} or None).
    The session spans the presentation and the Q&A, and pauses while JJ is listening."""
    alive = bool(current) and current["state"] != "ended"
    if not (run and session_phase == "running" and run.get("phase") in LIVE_RUN_PHASES):
        return ["stop"] if alive else []
    want = "paused" if run.get("paused") else "running"
    if not alive or current["run_id"] != run.get("runId"):
        return (["stop"] if alive else []) + ["create", "start"] + (["pause"] if want == "paused" else [])
    if current["state"] == "running" and want == "paused":
        return ["pause"]
    if current["state"] == "paused" and want == "running":
        return ["resume"]
    return []


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
                 force: bool = False, sessions: bool = True, tuning: Path | None = None):
        self.coach_url, self.token = coach_url, token   # re-read per connect: the coach writes a new token per run
        self.force = force
        self.tuning = tuning                            # session config overrides, re-read for every new session
        self.run_state: dict | None = None
        self.session_phase: str | None = None
        self.sensor = BrainLink(brain_url, "sensor", self._on_brain)
        self.operator = BrainLink(brain_url, "operator") if vignette else None
        self.session_id: str | None = None
        self._last_status: tuple[dict, float] | None = None
        self._open_episodes: dict[str, str] = {}   # behaviour -> episode id whose start the brain got
        self.stats = {"feedback": 0, "vignettes": 0, "behaviors": 0, "status": 0}
        self.sessions = sessions
        self.coach_session: dict | None = None   # the session this bridge created for the current run
        self._created: list[str] = []             # every coach session created for the brain's current session
        self._purge_pending = False
        self._session_task: asyncio.Task | None = None
        self._session_dirty = False

    # brain -> bridge
    def _on_brain(self, msg: dict) -> None:
        if msg.get("type") == "run.state":
            p = msg.get("payload") or {}
            self.run_state, self.session_phase = p.get("run"), p.get("sessionPhase")
            if self.run_state is None and self.session_phase == "setup" and self._created:
                self._purge_pending = True       # the brain's session was reset: its coach data goes too
            if self.sessions:
                self._kick_sessions()

    # brain run -> coach session (serialised: one sync task at a time, re-run if the run changed meanwhile)
    def _kick_sessions(self) -> None:
        if self._session_task and not self._session_task.done():
            self._session_dirty = True
            return
        self._session_task = asyncio.get_running_loop().create_task(self._sync_sessions())

    async def _sync_sessions(self) -> None:
        while True:
            self._session_dirty = False
            for action in coach_session_plan(self.coach_session, self.run_state, self.session_phase):
                if not await self._session_action(action):
                    break
            if self._purge_pending:
                await self._purge()
            if not self._session_dirty:
                return

    async def _purge(self) -> None:
        """Delete the coach sessions created for the brain session that was just reset (pose, speech, heart rate)."""
        self._purge_pending = False
        ids, self._created, self.coach_session = self._created, [], None

        def call() -> list[str]:
            client = CoachClient(self.coach_url, self.token())
            deleted = []
            try:
                for sid in ids:
                    try:
                        client.delete_session(sid)
                        deleted.append(sid)
                    except ApiError as exc:
                        if exc.status != 404:     # already gone (expired) is fine
                            raise
                return deleted
            finally:
                client.http.close()
        try:
            deleted = await asyncio.to_thread(call)
            log.info("coach: deleted %d session(s) of the reset brain session", len(deleted))
        except (Exception, SystemExit) as exc:
            log.warning("coach: could not delete the reset brain session's coach sessions (%s); they expire on their own", exc)

    async def _session_action(self, action: str) -> bool:
        def call() -> dict:
            client = CoachClient(self.coach_url, self.token())
            try:
                if action == "create":
                    label = f"brain {(self.run_state or {}).get('runId', '')}"
                    config = load_tuning(self.tuning, log) if self.tuning else None   # invalid -> logged, defaults
                    try:
                        return client.create_session(label=label, timeline="live", config=config)
                    except ApiError as exc:   # e.g. a coach server older than the tuning file
                        if config is None or exc.code != "invalid_config":
                            raise
                        log.error("coach refused %s (%s); session uses the default thresholds", self.tuning, exc)
                        return client.create_session(label=label, timeline="live")
                return client.action(self.coach_session["id"], action)
            finally:
                client.http.close()
        try:
            session = await asyncio.to_thread(call)
        except (Exception, SystemExit) as exc:   # coach down, token missing, 409 …: retried on the next run change
            log.warning("coach: could not %s the session for the brain run (%s)", action, exc)
            if action == "stop" and self.coach_session:
                self.coach_session["state"] = "ended"   # gone or already ended: don't keep retrying
            return False
        if action == "create":
            self.coach_session = {"id": session["session_id"], "run_id": (self.run_state or {}).get("runId"),
                                  "state": session.get("state", "created")}
            self._created.append(session["session_id"])
        else:
            self.coach_session["state"] = session.get("state", self.coach_session["state"])
        log.info("coach: session %s %s for brain %s", self.coach_session["id"][:12],
                 {"create": "created", "start": "started", "pause": "paused", "resume": "resumed",
                  "stop": "stopped"}[action], self.coach_session["run_id"])
        return True

    # coach -> brain
    async def handle_event(self, event: dict) -> None:
        kind, payload = event.get("event_type"), event.get("payload") or {}
        if kind == "body.metrics":
            await self._status(sensor_status(payload))
        elif kind == "coaching.feedback":
            await self._feedback(payload)
        elif kind == "behavior.episode":
            await self._episode(payload)
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
        if run_is_live(self.run_state, self.session_phase) and await self.sensor.send("coach.observation", observation(fb)):
            self.stats["observations"] = self.stats.get("observations", 0) + 1
        vignette = vignette_for(fb, self.run_state, self.session_phase, force=self.force)
        sent = bool(vignette and self.operator and await self.operator.send("operator.override", vignette))
        self.stats["vignettes"] += sent
        why = ("vignette" if sent else "not a presenter behaviour" if rule not in RULE_CATEGORY
               else "run not live / feedback off / not a target" if not vignette else "operator role unavailable")
        log.info("coach feedback %-26s -> %s  (%s)", rule, why, fb.get("display_text", "")[:60])

    async def _episode(self, episode: dict) -> None:
        msg = behavior_message(episode)
        if msg is None:
            return
        kind, episode_id = msg["kind"], episode.get("episode_id", "")
        if msg["phase"] == "start":
            if run_is_live(self.run_state, self.session_phase) and await self.sensor.send("behavior", msg):
                self._open_episodes[kind] = episode_id
                self.stats["behaviors"] += 1
            return
        if self._open_episodes.get(kind) != episode_id:
            return
        del self._open_episodes[kind]
        await self.sensor.send("behavior", msg)
        reward = reward_for(episode, self.run_state, self.session_phase)
        if reward and self.operator and await self.operator.send("operator.override", reward):
            self.stats["rewards"] = self.stats.get("rewards", 0) + 1
        log.info("coach episode %-12s %.1f s (%s)%s", kind, episode.get("duration_s") or 0, episode.get("end_reason"),
                 " -> reward" if reward else "")

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
               force: bool = False, sessions: bool = True, tuning: Path | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # one line per REST call is noise here
    log.info("bridge: coach %s -> brain %s (vignette: %s)", coach_url, brain_url,
             "off" if not vignette else "always during runs" if force else "follows the brain's run settings")
    if sessions and tuning:
        load_tuning(tuning, log)   # report a broken file at start, not only at the first run
        log.info("bridge: run sessions use the thresholds in %s (re-read for every run)", tuning)
    asyncio.run(Bridge(coach_url, brain_url, token, vignette=vignette, force=force, sessions=sessions,
                       tuning=tuning).run())
