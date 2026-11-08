"""Small Python client: REST (operator), device ingest and stream subscription.

    from coach.client import CoachClient
    client = CoachClient("http://127.0.0.1:8765", token)
    session = client.create_session(simulated=True)
"""

from __future__ import annotations

import asyncio
import json
import ssl
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import httpx
import websockets

from coach.config import Settings


def operator_token(settings: Settings | None = None) -> str:
    settings = settings or Settings.from_env()
    if settings.api_token:
        return settings.api_token
    path = settings.runtime_dir / "api_token"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise SystemExit(f"No operator token: start the server first (it writes {path}) or set COACH_API_TOKEN.") from exc


def _ssl_context(url: str, ca_file: str | None) -> ssl.SSLContext | None:
    if not url.startswith(("https", "wss")):
        return None
    context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    return context


def ws_url(base: str, path: str) -> str:
    return base.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + path


class ApiError(Exception):
    def __init__(self, status: int, body: dict):
        error = body.get("error", {}) if isinstance(body, dict) else {}
        super().__init__(f"HTTP {status} {error.get('code')}: {error.get('message')}")
        self.status, self.body, self.code = status, body, error.get("code")


class CoachClient:
    def __init__(self, base_url: str, token: str | None, ca_file: str | None = None, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        verify: Any = ca_file if ca_file else True
        self.http = httpx.Client(base_url=self.base_url, headers=headers, timeout=timeout, verify=verify)

    def request(self, method: str, path: str, body: dict | None = None, **params) -> dict:
        response = self.http.request(method, path, json=body, params={k: v for k, v in params.items() if v is not None})
        data = response.json() if response.content and "json" in response.headers.get("content-type", "") else {}
        if response.status_code >= 400:
            raise ApiError(response.status_code, data)
        return data

    def create_session(self, **body) -> dict:
        return self.request("POST", "/v1/sessions", body)

    def action(self, session_id: str, action: str) -> dict:
        return self.request("POST", f"/v1/sessions/{session_id}/{action}")

    def delete_session(self, session_id: str) -> dict:
        return self.request("DELETE", f"/v1/sessions/{session_id}")

    def calibrate(self, session_id: str, duration_s: float | None = None) -> dict:
        return self.request("POST", f"/v1/sessions/{session_id}/calibration/start", {"duration_s": duration_s})

    def snapshot(self, session_id: str) -> dict:
        return self.request("GET", f"/v1/sessions/{session_id}/snapshot")

    def events(self, session_id: str, after_cursor: int = 0, limit: int = 500, types: str | None = None) -> dict:
        return self.request("GET", f"/v1/sessions/{session_id}/events", after_cursor=after_cursor, limit=limit,
                            types=types)

    def summary(self, session_id: str, narrative: bool = False) -> dict:
        return self.request("GET", f"/v1/sessions/{session_id}/summary", narrative=str(narrative).lower())

    def export(self, session_id: str, path: Path) -> Path:
        with self.http.stream("GET", f"/v1/sessions/{session_id}/export") as response:
            if response.status_code >= 400:
                raise ApiError(response.status_code, {})
            with path.open("w", encoding="utf-8") as handle:
                for line in response.iter_lines():
                    handle.write(line + "\n")
        return path

    def pairing_code(self) -> dict:
        return self.request("POST", "/v1/pairing-codes")

    def pair(self, code: str, device_id: str, kind: str, name: str | None = None) -> dict:
        response = self.http.post("/v1/devices/pair", json={"code": code, "device_id": device_id, "kind": kind,
                                                            "name": name}, headers={"Authorization": ""})
        if response.status_code >= 400:
            raise ApiError(response.status_code, response.json())
        return response.json()

    def stream_ticket(self) -> str:
        return self.request("POST", "/v1/stream-tickets")["ticket"]


class EventFactory:
    """Builds envelopes with per-source sequence numbers (assigned at first transmission)."""

    def __init__(self, device_id: str, kind: str, *, simulated: bool = False,
                 device_clock: Callable[[], float] = time.time):
        self.device_id, self.kind, self.simulated, self.device_clock = device_id, kind, simulated, device_clock
        self.sequences: dict[str, int] = {}

    def event(self, session_id: str, event_type: str, payload: dict, *, captured_at: float | None = None,
              source: dict | None = None, event_id: str | None = None) -> dict:
        captured = self.device_clock() if captured_at is None else captured_at
        source = source or {"device_id": self.device_id, "kind": self.kind, "simulated": self.simulated}
        sequence = self.sequences.get(source["device_id"], 0)
        self.sequences[source["device_id"]] = sequence + 1
        return {"schema_version": "1.0", "event_id": event_id or f"ev-{uuid.uuid4().hex[:20]}",
                "session_id": session_id, "source": source, "sequence": sequence, "event_type": event_type,
                "captured_at": _iso(captured), "source_monotonic_ms": round(time.monotonic() * 1000, 3),
                "payload": payload}


class DeviceConnection(EventFactory):
    """A device on /v1/ingest. `device_clock` returns the device's wall clock in epoch seconds."""

    def __init__(self, base_url: str, token: str, device_id: str, kind: str, *, simulated: bool = False,
                 device_clock: Callable[[], float] = time.time, ca_file: str | None = None):
        super().__init__(device_id, kind, simulated=simulated, device_clock=device_clock)
        self.url = ws_url(base_url, "/v1/ingest")
        self.token, self.ca_file = token, ca_file
        self.ws = None
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.acks: asyncio.Queue = asyncio.Queue()
        self.control: list[dict] = []
        self.backpressure = False
        self.clock_estimate: dict | None = None
        self._reader: asyncio.Task | None = None

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def connect(self) -> dict:
        self.ws = await websockets.connect(self.url, additional_headers={"Authorization": f"Bearer {self.token}"},
                                           ssl=_ssl_context(self.url, self.ca_file), max_size=2**20)
        hello = json.loads(await self.ws.recv())
        if hello.get("type") != "auth.ok":
            raise RuntimeError(f"ingest auth failed: {hello}")
        self._reader = asyncio.create_task(self._read())
        return hello

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self.ws:
            await self.ws.close()

    async def _read(self) -> None:
        async for raw in self.ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "ack":
                await self.acks.put(msg)
            elif kind == "session":
                self.control.append(msg)
                await self.incoming.put(msg)
            elif kind == "backpressure":
                self.backpressure = msg.get("state") == "on"
                await self.incoming.put(msg)
            else:
                await self.incoming.put(msg)

    async def _expect(self, kind: str, timeout: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            msg = await asyncio.wait_for(self.incoming.get(), max(0.01, deadline - time.monotonic()))
            if msg.get("type") == kind:
                return msg
            if msg.get("type") == "error":
                raise RuntimeError(msg["error"])

    async def sync_clock(self, rounds: int = 5) -> dict:
        for _ in range(rounds):
            t0 = self.device_clock() * 1000
            await self.ws.send(json.dumps({"type": "clock.ping", "t0": t0}))
            pong = await self._expect("clock.pong")
            t3 = self.device_clock() * 1000
            await self.ws.send(json.dumps({"type": "clock.sample", "t0": t0, "t1": pong["t1"], "t2": pong["t2"],
                                           "t3": t3}))
            self.clock_estimate = await self._expect("clock.estimate")
        return self.clock_estimate

    async def join(self, session_id: str | None = None) -> dict:
        await self.ws.send(json.dumps({"type": "join", "session_id": session_id}))
        return await self._expect("session")

    async def send(self, events: list[dict], wait_ack: bool = True) -> dict | None:
        await self.ws.send(json.dumps({"type": "events", "events": events}))
        if wait_ack:
            return await asyncio.wait_for(self.acks.get(), 10)
        return None


def _iso(t: float) -> str:
    from coach.timeutil import to_iso
    return to_iso(t)


async def stream(base_url: str, token: str | None = None, *, ticket: str | None = None, session_id: str = "latest",
                 event_types: list[str] | None = None, after_cursor: int | None = None,
                 ca_file: str | None = None) -> AsyncIterator[dict]:
    """Yield stream messages. Token goes in the Authorization header; tickets in the first message."""
    url = ws_url(base_url, "/v1/stream")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with websockets.connect(url, additional_headers=headers, ssl=_ssl_context(url, ca_file), max_size=2**22) as ws:
        if ticket:
            await ws.send(json.dumps({"type": "auth", "ticket": ticket}))
        hello = json.loads(await ws.recv())
        if hello.get("type") != "auth.ok":
            raise RuntimeError(f"stream auth failed: {hello}")
        await ws.send(json.dumps({"type": "subscribe", "session_id": session_id, "event_types": event_types,
                                  "after_cursor": after_cursor}))
        async for raw in ws:
            yield json.loads(raw)
