"""REST + WebSocket API (/v1). See docs/api.md for the full contract."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from coach import SCHEMA_VERSION, __version__
from coach.assistant import AssistantClient, FeedbackDelivery
from coach.auth import AuthStore, Principal, bearer_token, origin_allowed
from coach.coaching import RULE_IDS
from coach.config import SessionConfig, Settings
from coach.eventlog import type_matches
from coach.session import Session, SessionError, SessionManager
from coach.timeutil import to_iso
from coach.wire import (CalibrationRequest, EventIn, EventType, PairRequest, SessionCreate, DEVICE_EVENT_TYPES)

log = logging.getLogger("coach.api")
DROPPABLE_FOR_SUBSCRIBERS = {"pose.frame", "body.metrics"}
MAX_BATCH = 100


def error(code: str, message: str, status: int, details: dict | None = None, headers: dict | None = None):
    return JSONResponse({"error": {"code": code, "message": message, "details": details}}, status_code=status,
                        headers=headers)


class Subscriber:
    """One /v1/stream subscription with a bounded queue."""

    def __init__(self, session: Session, types: list[str] | None, maxsize: int):
        self.session, self.types = session, types
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0
        self.closed_reason: str | None = None

    def offer(self, event: dict) -> None:
        if self.closed_reason or not type_matches(event["event_type"], self.types):
            return
        try:
            self.queue.put_nowait({"type": "event", "event": event})
        except asyncio.QueueFull:
            if event["event_type"] in DROPPABLE_FOR_SUBSCRIBERS:
                self.dropped += 1
                self.session.counters["subscriber_drops"] += 1
            else:
                self.close("slow_consumer")

    def close(self, reason: str) -> None:
        if self.closed_reason is None:
            self.closed_reason = reason
            with contextlib.suppress(asyncio.QueueFull):
                self.queue.put_nowait({"type": "_close"})


def create_app(settings: Settings | None = None, *, manager: SessionManager | None = None,
               auth: AuthStore | None = None, assistant: AssistantClient | None = None,
               start_background: bool = True) -> FastAPI:
    settings = settings or Settings.from_env()
    auth = auth or AuthStore(settings.runtime_dir, settings.api_token, settings.pairing_code_ttl_s,
                             settings.device_token_ttl_s, settings.stream_ticket_ttl_s)
    manager = manager or SessionManager(settings)
    if assistant is None and settings.assistant_enabled:
        assistant = AssistantClient(settings)
    delivery = FeedbackDelivery(assistant)
    manager.on_feedback = delivery
    connections: dict[str, int] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        tasks = []
        if start_background:
            tasks.append(asyncio.create_task(_ticker(manager)))
        yield
        for task in tasks:
            task.cancel()
        for session in manager.sessions.values():
            session.stop_worker()
        if assistant is not None:
            await assistant.close()

    app = FastAPI(title="Presentation practice coach", version=__version__, lifespan=lifespan,
                  description="Headless coaching backend. Contract: docs/api.md, contracts/.")
    app.state.settings, app.state.auth, app.state.manager, app.state.assistant = settings, auth, manager, assistant
    if settings.allowed_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=False,
                           allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])

    # ------------------------------------------------------------------ errors
    @app.exception_handler(SessionError)
    async def _session_error(_: Request, exc: SessionError):
        return error(exc.code, exc.message, exc.status, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        return error("invalid_request", "request validation failed", 422,
                     {"errors": [{k: v for k, v in e.items() if k in ("loc", "msg", "type")} for e in exc.errors()][:10]})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        codes = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}
        headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None
        return error(codes.get(exc.status_code, "http_error"), str(exc.detail), exc.status_code, headers=headers)

    # ------------------------------------------------------------------ auth
    def principal(request: Request) -> Principal | None:
        return auth.authenticate(bearer_token(request.headers.get("authorization")))

    def operator(request: Request) -> Principal:
        p = principal(request)
        if p is None or not p.is_operator:
            raise StarletteHTTPException(401, "operator token required (Authorization: Bearer ...)")
        return p

    def any_principal(request: Request) -> Principal:
        p = principal(request)
        if p is None:
            raise StarletteHTTPException(401, "token required (Authorization: Bearer ...)")
        return p

    # ------------------------------------------------------------------ health
    @app.get("/health")
    async def health():
        return {"status": "ok", "version": __version__, "schema_version": SCHEMA_VERSION}

    @app.get("/ready")
    async def ready():
        return {"ready": True, "sessions": len(manager.sessions), "schema_version": SCHEMA_VERSION}

    @app.get("/v1/capabilities")
    async def capabilities(_: Principal = Depends(any_principal)):
        status = await assistant.status() if assistant else {"reachable": False, "reason": "disabled"}
        return {
            "schema_version": SCHEMA_VERSION, "version": __version__,
            "event_types": [e.value for e in EventType],
            "device_event_types": sorted(e.value for e in DEVICE_EVENT_TYPES),
            "coaching_rules": list(RULE_IDS),
            "session_config_defaults": SessionConfig().model_dump(),
            "timelines": ["live", "event_time"], "mic_sources": ["iphone", "mac", "none"],
            "limits": {"max_message_bytes": settings.max_message_bytes, "max_batch_events": MAX_BATCH,
                       "event_buffer": settings.event_buffer, "pose_buffer": settings.pose_buffer,
                       "ingest_pose_queue": settings.ingest_pose_queue, "max_sessions": settings.max_sessions,
                       "session_ttl_s": settings.session_ttl_s, "unauthenticated_timeout_s": settings.unauth_timeout_s},
            "auth": {"rest": "Authorization: Bearer <operator token>",
                     "ingest": "Authorization header or first message {type: auth, token} (device token from pairing)",
                     "stream": "Authorization header, or first message {type: auth, token|ticket}"},
            "assistant": status,
            "storage": {"raw_audio": False, "raw_video": False, "persistence": "in-memory, bounded; explicit JSONL export"},
        }

    # ------------------------------------------------------------------ pairing / tickets
    @app.post("/v1/pairing-codes", status_code=201)
    async def pairing_code(_: Principal = Depends(operator)):
        code, expires = auth.create_pairing_code()
        return {"code": code, "expires_at": to_iso(expires), "pair_path": "/v1/devices/pair"}

    @app.post("/v1/devices/pair", status_code=201)
    async def pair(body: PairRequest):
        if auth.pairing_locked():
            raise SessionError("pairing_locked", "too many failed pairing attempts; wait a few minutes", 429)
        result = auth.pair(body.code, body.device_id, body.kind, body.name)
        if result is None:
            raise SessionError("invalid_pairing_code", "pairing code is invalid, used or expired", 401)
        token, expires = result
        manager.registry.get(body.device_id, body.kind, body.kind == "simulator").name = body.name
        return {"device_id": body.device_id, "device_token": token, "expires_at": to_iso(expires),
                "ingest_path": "/v1/ingest"}

    @app.get("/v1/devices")
    async def devices(_: Principal = Depends(operator)):
        paired = auth.paired_devices()
        for item in paired:
            info = manager.registry.devices.get(item["device_id"])
            item["expires_at"] = to_iso(item["expires_at"])
            item["connected"] = bool(info and info.connected)
            estimate = info.clock.estimate(time.time()) if info else None
            item["clock"] = None if estimate is None else {"offset_ms": round(estimate.offset_ms, 3),
                                                           "uncertainty_ms": round(estimate.uncertainty_ms, 3)}
        return {"devices": paired}

    @app.delete("/v1/devices/{device_id}")
    async def revoke(device_id: str, _: Principal = Depends(operator)):
        return {"revoked": auth.revoke_device(device_id)}

    @app.post("/v1/stream-tickets", status_code=201)
    async def stream_ticket(_: Principal = Depends(operator)):
        ticket, expires = auth.create_ticket()
        return {"ticket": ticket, "expires_at": to_iso(expires), "usage": "send {type:'auth', ticket} as the first message"}

    # ------------------------------------------------------------------ sessions
    @app.get("/v1/sessions")
    async def list_sessions(_: Principal = Depends(operator)):
        return {"sessions": [s.public() | {"config": None} for s in manager.sessions.values()]}

    @app.post("/v1/sessions", status_code=201)
    async def create_session(body: SessionCreate, _: Principal = Depends(operator)):
        session = manager.create(label=body.label, mic_source=body.mic_source, timeline=body.timeline,
                                 simulated=body.simulated, config=body.config)
        session.start_worker()
        return session.public()

    @app.get("/v1/sessions/{session_id}")
    async def get_session(session_id: str, _: Principal = Depends(operator)):
        return manager.get(session_id).public()

    @app.delete("/v1/sessions/{session_id}")
    async def delete_session(session_id: str, _: Principal = Depends(operator)):
        manager.delete(session_id)
        return {"ok": True, "session_id": session_id, "deleted": True}

    for action in ("start", "pause", "resume", "stop"):
        def make(action: str):
            async def handler(session_id: str, _: Principal = Depends(operator)):
                session = manager.get(session_id)
                result = session.transition(action)
                if action == "stop":
                    try:
                        await session.drain()
                    except asyncio.TimeoutError:
                        log.warning("session %s stopped; queued events still processing after 5 s", session.id)
                        result = result | {"drained": False}
                return result
            handler.__name__ = f"session_{action}"
            return handler
        app.post(f"/v1/sessions/{{session_id}}/{action}")(make(action))

    @app.post("/v1/sessions/{session_id}/calibration/start")
    async def calibration(session_id: str, body: CalibrationRequest | None = None, _: Principal = Depends(operator)):
        return {"calibration": manager.get(session_id).start_calibration(body.duration_s if body else None)}

    @app.get("/v1/sessions/{session_id}/snapshot")
    async def snapshot(session_id: str, _: Principal = Depends(operator)):
        return manager.get(session_id).snapshot()

    @app.get("/v1/sessions/{session_id}/events")
    async def events(session_id: str, after_cursor: int = 0, limit: int = 500, types: str | None = None,
                     _: Principal = Depends(operator)):
        session = manager.get(session_id)
        limit = max(1, min(limit, 5000))
        if session.log.expired(after_cursor):
            raise SessionError("history_expired", "requested cursor left the ring buffer", 410,
                               {"requested_after_cursor": after_cursor,
                                "oldest_complete_after_cursor": session.log.oldest_cursor,
                                "head_cursor": session.log.head,
                                "recovery": "GET /snapshot, then continue from its cursor"})
        type_list = [t for t in (types or "").split(",") if t] or None
        page = session.log.since(after_cursor, limit=limit, types=type_list)
        next_cursor = page[-1]["cursor"] if page else max(after_cursor, 0)
        return {"events": page, "next_cursor": next_cursor, "head_cursor": session.log.head,
                "has_more": bool(page) and len(page) == limit and next_cursor < session.log.head}

    @app.get("/v1/sessions/{session_id}/summary")
    async def summary(session_id: str, narrative: bool = False, _: Principal = Depends(operator)):
        session = manager.get(session_id)
        data = session.summary()
        if narrative:
            data["narrative"] = await _narrative(session, data, assistant)
        return data

    @app.get("/v1/sessions/{session_id}/export")
    async def export(session_id: str, _: Principal = Depends(operator)):
        session = manager.get(session_id)
        from coach.export import export_lines
        return StreamingResponse(export_lines(session), media_type="application/x-ndjson",
                                 headers={"Content-Disposition": f'attachment; filename="{session.id}.jsonl"'})

    # ------------------------------------------------------------------ websockets
    async def ws_authenticate(ws: WebSocket, allow_ticket: bool) -> Principal | None:
        p = auth.authenticate(bearer_token(ws.headers.get("authorization")))
        if p is not None:
            return p
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=settings.unauth_timeout_s)
        except (asyncio.TimeoutError, WebSocketDisconnect, RuntimeError):
            return None
        if len(raw) > 4096:
            return None
        try:
            msg = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(msg, dict) or msg.get("type") != "auth":
            return None
        if allow_ticket and msg.get("ticket"):
            return Principal(role="ticket") if auth.redeem_ticket(str(msg["ticket"])) else None
        return auth.authenticate(str(msg.get("token") or ""))

    async def ws_reject(ws: WebSocket, code: str, message: str, close_code: int) -> None:
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "error": {"code": code, "message": message}})
            await ws.close(code=close_code)

    @app.websocket("/v1/ingest")
    async def ingest(ws: WebSocket):
        if not origin_allowed(ws.headers.get("origin"), settings.allowed_origins):
            await ws.close(code=1008)
            return
        await ws.accept()
        p = await ws_authenticate(ws, allow_ticket=False)
        if p is None or p.role != "device":
            await ws_reject(ws, "unauthorized", "device token required (pair first)", 4401)
            return
        device = manager.registry.get(p.device_id, p.device_kind, p.device_kind == "simulator")
        device.connected, device.last_seen = True, time.time()
        connections[p.device_id] = connections.get(p.device_id, 0) + 1
        outbox: asyncio.Queue = asyncio.Queue(maxsize=256)
        joined: dict[str, Any] = {}
        backpressure = {"on": False}

        def push(message: dict) -> None:
            with contextlib.suppress(asyncio.QueueFull):
                outbox.put_nowait(message)

        async def sender():
            try:
                while True:
                    message = await outbox.get()
                    await ws.send_json(message)
            except (WebSocketDisconnect, RuntimeError, OSError):
                with contextlib.suppress(Exception):
                    await ws.close(code=1011)

        send_task = asyncio.create_task(sender())
        push({"type": "auth.ok", "device_id": p.device_id, "kind": p.device_kind, "schema_version": SCHEMA_VERSION,
              "server_time_ms": time.time() * 1000,
              "limits": {"max_message_bytes": settings.max_message_bytes, "max_batch_events": MAX_BATCH}})
        try:
            while True:
                raw = await ws.receive_text()
                t1 = time.time() * 1000
                if len(raw.encode("utf-8")) > settings.max_message_bytes:
                    await ws_reject(ws, "message_too_large", f"limit is {settings.max_message_bytes} bytes", 1009)
                    return
                try:
                    msg = json.loads(raw)
                    kind = msg.get("type") if isinstance(msg, dict) else None
                except ValueError:
                    push({"type": "error", "error": {"code": "malformed_json", "message": "message is not JSON"}})
                    continue
                device.last_seen = time.time()
                if kind == "clock.ping":
                    push({"type": "clock.pong", "t0": msg.get("t0"), "t1": t1, "t2": time.time() * 1000})
                elif kind == "clock.sample":
                    try:
                        sample = device.clock.add(float(msg["t0"]), float(msg["t1"]), float(msg["t2"]),
                                                  float(msg["t3"]), time.time())
                        est = device.clock.estimate(time.time())
                        push({"type": "clock.estimate", "offset_ms": round(est.offset_ms, 3),
                              "uncertainty_ms": round(est.uncertainty_ms, 3), "rtt_ms": round(sample.rtt_ms, 3),
                              "samples": est.samples})
                    except (KeyError, TypeError, ValueError) as exc:
                        push({"type": "error", "error": {"code": "invalid_clock_sample", "message": str(exc)}})
                elif kind == "join":
                    try:
                        session = (manager.get(str(msg["session_id"])) if msg.get("session_id")
                                   else manager.latest_active())
                    except SessionError as exc:
                        push({"type": "error", "error": {"code": exc.code, "message": exc.message}})
                        continue
                    if session is None:
                        push({"type": "error", "error": {"code": "no_active_session",
                                                         "message": "create a session first (POST /v1/sessions)"}})
                        continue
                    if session.id not in joined:
                        session.control_listeners.add(push)
                        joined[session.id] = session
                        session.device_connection(p.device_id, p.device_kind, True, "joined")
                    push(session.control_message())
                elif kind in ("event", "events"):
                    raw_events = [msg.get("event")] if kind == "event" else msg.get("events")
                    if not isinstance(raw_events, list) or not raw_events or len(raw_events) > MAX_BATCH:
                        push({"type": "error", "error": {"code": "invalid_batch",
                                                         "message": f"send 1..{MAX_BATCH} events"}})
                        continue
                    results = [_ingest_one(manager, item, p) for item in raw_events]
                    push({"type": "ack", "results": results})
                    _update_backpressure(joined, backpressure, push, settings)
                elif kind == "ping":
                    push({"type": "pong", "server_time_ms": time.time() * 1000})
                else:
                    push({"type": "error", "error": {"code": "unknown_message_type", "message": str(kind)[:64]}})
        except WebSocketDisconnect:
            pass
        except SessionError as exc:
            await ws_reject(ws, exc.code, exc.message, 1008)
        finally:
            send_task.cancel()
            connections[p.device_id] -= 1
            device.connected = connections[p.device_id] > 0
            for session in joined.values():
                session.control_listeners.discard(push)
                if session.state != "ended":
                    session.device_connection(p.device_id, p.device_kind, False, "connection closed")

    @app.websocket("/v1/stream")
    async def stream(ws: WebSocket):
        if not origin_allowed(ws.headers.get("origin"), settings.allowed_origins):
            await ws.close(code=1008)
            return
        await ws.accept()
        p = await ws_authenticate(ws, allow_ticket=True)
        if p is None or p.role not in ("operator", "ticket"):
            await ws_reject(ws, "unauthorized", "operator token or stream ticket required", 4401)
            return
        await ws.send_json({"type": "auth.ok", "role": p.role, "schema_version": SCHEMA_VERSION})
        subscriber: Subscriber | None = None
        reader_queue: asyncio.Queue = asyncio.Queue()

        async def reader():
            while True:
                raw = await ws.receive_text()
                if len(raw) > 16_384:
                    await ws_reject(ws, "message_too_large", "stream messages are limited to 16 KiB", 1009)
                    return
                try:
                    await reader_queue.put(json.loads(raw))
                except ValueError:
                    await reader_queue.put({"type": "_malformed"})

        read_task = asyncio.create_task(reader())
        try:
            while True:
                waiters = [asyncio.ensure_future(reader_queue.get())]
                if subscriber is not None:
                    waiters.append(asyncio.ensure_future(subscriber.queue.get()))
                done, pending = await asyncio.wait(waiters + [read_task], timeout=15.0,
                                                   return_when=asyncio.FIRST_COMPLETED)
                for future in pending:
                    if future is not read_task:
                        future.cancel()
                if read_task in done:
                    return
                if not done:
                    head = subscriber.session.log.head if subscriber else None
                    await ws.send_json({"type": "heartbeat", "cursor": head})
                    continue
                # Deliver queued subscription events before acting on a new client message.
                for future in sorted(done, key=lambda f: f is waiters[0]):
                    item = future.result()
                    if future is waiters[0]:
                        subscriber = await _handle_stream_message(ws, item, manager, settings, subscriber)
                    elif item.get("type") == "_close":
                        await ws_reject(ws, subscriber.closed_reason or "closed",
                                        "subscription closed; reconnect with after_cursor", 1013)
                        return
                    else:
                        await ws.send_json(item)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            read_task.cancel()
            if subscriber is not None:
                subscriber.session.subscribers.discard(subscriber)

    return app


async def _handle_stream_message(ws: WebSocket, msg: dict, manager: SessionManager, settings: Settings,
                                 current: Subscriber | None) -> Subscriber | None:
    kind = msg.get("type") if isinstance(msg, dict) else None
    if kind == "_malformed":
        await ws.send_json({"type": "error", "error": {"code": "malformed_message", "message": "invalid message"}})
        return current
    if kind == "ping":
        await ws.send_json({"type": "pong"})
        return current
    if kind == "unsubscribe" and current is not None:
        current.session.subscribers.discard(current)
        await ws.send_json({"type": "unsubscribed"})
        return None
    if kind != "subscribe":
        await ws.send_json({"type": "error", "error": {"code": "unknown_message_type", "message": str(kind)[:64]}})
        return current
    try:
        session_id = msg.get("session_id") or "latest"
        session = manager.latest_active() if session_id == "latest" else manager.get(session_id)
        if session is None:
            raise SessionError("no_active_session", "no active session", 404)
    except SessionError as exc:
        await ws.send_json({"type": "error", "error": {"code": exc.code, "message": exc.message}})
        return current
    types = msg.get("event_types")
    if types is not None and (not isinstance(types, list) or not all(isinstance(t, str) for t in types)):
        await ws.send_json({"type": "error", "error": {"code": "invalid_filter", "message": "event_types: list"}})
        return current
    after = msg.get("after_cursor")
    if current is not None:
        current.session.subscribers.discard(current)
    # Atomic (no await): snapshot boundary, replay slice and registration share one cursor.
    subscriber = Subscriber(session, types, settings.subscriber_queue)
    snapshot = session.snapshot()
    head = session.log.head
    expired = after is not None and session.log.expired(int(after))
    replay = [] if after is None or expired else session.log.since(int(after), types=types, up_to=head)
    session.subscribers.add(subscriber)
    if expired:
        await ws.send_json({"type": "history_expired", "requested_after_cursor": after,
                            "oldest_complete_after_cursor": session.log.oldest_cursor, "head_cursor": head})
    await ws.send_json({"type": "snapshot", "cursor": head, "snapshot": snapshot})
    for event in replay:
        await ws.send_json({"type": "event", "event": event, "replay": True})
    await ws.send_json({"type": "synced", "cursor": head, "replayed": len(replay),
                        "note": "events after this cursor are live"})
    return subscriber


def _ingest_one(manager: SessionManager, raw: Any, p: Principal) -> dict:
    event_id = raw.get("event_id") if isinstance(raw, dict) else None
    try:
        event = EventIn.model_validate(raw)
    except ValidationError as exc:
        return {"event_id": event_id, "status": "rejected", "code": "invalid_envelope",
                "details": {"errors": exc.errors(include_url=False, include_context=False)[:5]}}
    try:
        session = manager.get(event.session_id)
    except SessionError as exc:
        return {"event_id": event.event_id, "status": "rejected", "code": exc.code}
    session.start_worker()
    result = session.accept(event, p.device_id, p.device_kind)
    return {k: v for k, v in result.items() if v is not None}


def _update_backpressure(joined: dict, state: dict, push, settings: Settings) -> None:
    level = max((s.backpressure_level() for s in joined.values()), default=0.0)
    if not state["on"] and level >= 0.75:
        state["on"] = True
        push({"type": "backpressure", "state": "on", "lane": "pose", "queue_level": round(level, 2),
              "advice": "reduce pose rate; control, speech and heart-rate events are unaffected"})
    elif state["on"] and level <= 0.25:
        state["on"] = False
        push({"type": "backpressure", "state": "off", "lane": "pose", "queue_level": round(level, 2)})


async def _ticker(manager: SessionManager) -> None:
    """Live sessions: evaluate time-based conditions (tracking loss, staleness, calibration) twice a second.
    A failing evaluation is logged (at most every 30 s per session) and never stops the ticker."""
    last_cleanup = time.time()
    last_logged: dict[str, float] = {}
    while True:
        await asyncio.sleep(0.5)
        for session in list(manager.sessions.values()):
            if session.timeline == "live" and session.state != "ended":
                try:
                    session.evaluate()
                except Exception:
                    session.counters["evaluation_errors"] += 1
                    if time.time() - last_logged.get(session.id, 0.0) >= 30.0:
                        last_logged[session.id] = time.time()
                        log.exception("periodic evaluation failed for session %s", session.id)
        if time.time() - last_cleanup > 60:
            for sid in manager.cleanup():
                last_logged.pop(sid, None)
            last_cleanup = time.time()


async def _narrative(session: Session, data: dict, assistant: AssistantClient | None) -> dict:
    sp, hr = data["speech"], data["heart_rate"]
    facts = [f"Running time {data['running_time_s']:.0f} seconds.",
             f"{sp['words']} final words" + (f" at {sp['rate_wpm_session']:.0f} words per minute while speaking."
                                             if sp["rate_wpm_session"] else "."),
             f"{sp['long_pauses']} long pauses.", f"{sum(sp['fillers'].values())} filler words.",
             f"{data['coaching']['suggestions']} coaching suggestions."]
    if hr["reference"].get("bpm"):
        facts.append(f"Session heart-rate reference {hr['reference']['bpm']:.0f} bpm.")
    template = " ".join(facts)
    language = session.config.coaching.language
    if assistant is not None:
        text = await assistant.summarize(facts, language)
        if text:
            return {"text": text, "source": "foundation_models", "facts": facts}
    return {"text": template, "source": "template", "facts": facts}
