import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import T0, pose2d
from coach.api import create_app
from coach.timeutil import to_iso

OP = {"Authorization": "Bearer test-operator-token-0123456789abcdef"}


@pytest.fixture
def client(settings):
    settings.allowed_origins = ["http://localhost:5173"]
    app = create_app(settings, start_background=False)
    with TestClient(app) as c:
        yield c


def pair(client, device_id="phone-1", kind="iphone"):
    code = client.post("/v1/pairing-codes", headers=OP).json()["code"]
    return client.post("/v1/devices/pair", json={"code": code, "device_id": device_id, "kind": kind}).json()["device_token"]


def event(session_id, seq, etype="pose.frame", payload=None, device="phone-1", t=None):
    return {"schema_version": "1.0", "event_id": f"ev-{device}-{seq}", "session_id": session_id,
            "source": {"device_id": device, "kind": "iphone", "simulated": False}, "sequence": seq,
            "event_type": etype, "captured_at": to_iso(t or time.time()), "payload": payload or pose2d()}


def wait_processed(client, sid, n, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        counters = client.get(f"/v1/sessions/{sid}/snapshot", headers=OP).json()["counters"]
        if counters["processed"] >= n:
            return counters
        time.sleep(0.02)
    raise AssertionError("events were not processed")


def test_auth_errors_use_the_error_envelope(client):
    assert client.get("/health").json()["status"] == "ok"
    response = client.get("/v1/sessions")
    assert response.status_code == 401 and response.headers["www-authenticate"] == "Bearer"
    assert response.json()["error"]["code"] == "unauthorized"
    assert client.get("/v1/sessions", headers={"Authorization": "Bearer wrong"}).status_code == 401
    bad = client.post("/v1/sessions", headers=OP, json={"mic_source": "toaster"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_request"


def test_pairing_is_single_use_and_device_tokens_are_scoped(client):
    code = client.post("/v1/pairing-codes", headers=OP).json()["code"]
    first = client.post("/v1/devices/pair", json={"code": code, "device_id": "phone-1", "kind": "iphone"})
    assert first.status_code == 201
    again = client.post("/v1/devices/pair", json={"code": code, "device_id": "phone-2", "kind": "iphone"})
    assert again.status_code == 401 and again.json()["error"]["code"] == "invalid_pairing_code"
    device = {"Authorization": f"Bearer {first.json()['device_token']}"}
    assert client.get("/v1/sessions", headers=device).status_code == 401       # not an operator
    assert client.get("/v1/capabilities", headers=device).status_code == 200


def test_session_rest_flow_and_invalid_transition(client):
    sid = client.post("/v1/sessions", headers=OP, json={"label": "t"}).json()["session_id"]
    bad = client.post(f"/v1/sessions/{sid}/pause", headers=OP)
    assert bad.status_code == 409 and bad.json()["error"]["details"]["state"] == "created"
    for action, state in (("start", "running"), ("pause", "paused"), ("resume", "running"), ("stop", "ended")):
        assert client.post(f"/v1/sessions/{sid}/{action}", headers=OP).json()["state"] == state
    summary = client.get(f"/v1/sessions/{sid}/summary?narrative=true", headers=OP).json()
    assert summary["final"] is True and summary["narrative"]["source"] == "template"
    assert client.get("/v1/sessions/ses_missing", headers=OP).json()["error"]["code"] == "session_not_found"


def test_ingest_protocol(client):
    token = pair(client)
    sid = client.post("/v1/sessions", headers=OP, json={}).json()["session_id"]
    client.post(f"/v1/sessions/{sid}/start", headers=OP)
    with client.websocket_connect("/v1/ingest", headers={"Authorization": f"Bearer {token}"}) as ws:
        assert ws.receive_json()["type"] == "auth.ok"
        t0 = time.time() * 1000
        ws.send_json({"type": "clock.ping", "t0": t0})
        pong = ws.receive_json()
        ws.send_json({"type": "clock.sample", "t0": t0, "t1": pong["t1"], "t2": pong["t2"], "t3": time.time() * 1000})
        assert ws.receive_json()["type"] == "clock.estimate"
        ws.send_json({"type": "join", "session_id": sid})
        assert ws.receive_json()["session"]["state"] == "running"
        ws.send_text("{not json")
        assert ws.receive_json()["error"]["code"] == "malformed_json"
        ws.send_json({"type": "events", "events": [event(sid, 0), event(sid, 0), {"garbage": True}]})
        ack = ws.receive_json()
        assert [r["status"] for r in ack["results"]] == ["accepted", "duplicate", "rejected"]
        ws.send_json({"type": "events", "events": [event(sid, 1, "coaching.feedback", {})]})
        assert ws.receive_json()["results"][0]["code"] == "type_not_allowed"
    counters = wait_processed(client, sid, 1)
    assert counters["duplicates"] == 1
    devices = client.get(f"/v1/sessions/{sid}/snapshot", headers=OP).json()["devices"]
    assert devices and devices[0]["device_id"] == "phone-1"
    statuses = [e["payload"]["status"] for e in client.get(f"/v1/sessions/{sid}/events?types=device.status",
                                                           headers=OP).json()["events"]]
    assert statuses == ["online", "offline"]                                # disconnect is reported


def test_ingest_first_message_auth_timeout_and_size_limit(client, settings):
    token = pair(client)
    with client.websocket_connect("/v1/ingest") as ws:                      # no credentials at all
        msg = ws.receive_json()
        assert msg["error"]["code"] == "unauthorized"
    with client.websocket_connect("/v1/ingest") as ws:
        ws.send_json({"type": "auth", "token": token})
        assert ws.receive_json()["type"] == "auth.ok"
        ws.send_text("x" * (settings.max_message_bytes + 1))
        assert ws.receive_json()["error"]["code"] == "message_too_large"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1009


def test_stream_snapshot_cursor_resume_and_tickets(client):
    sid = client.post("/v1/sessions", headers=OP, json={}).json()["session_id"]
    with client.websocket_connect("/v1/stream", headers=OP) as ws:
        assert ws.receive_json()["type"] == "auth.ok"
        ws.send_json({"type": "subscribe", "session_id": sid, "event_types": ["session.*"]})
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["snapshot"]["session"]["state"] == "created"
        synced = ws.receive_json()
        assert synced["type"] == "synced" and synced["cursor"] == snap["cursor"]
        client.post(f"/v1/sessions/{sid}/start", headers=OP)
        live = ws.receive_json()
        assert live["event"]["payload"]["state"] == "running" and live["event"]["cursor"] > synced["cursor"]
        last = live["event"]["cursor"]
    client.post(f"/v1/sessions/{sid}/pause", headers=OP)                     # missed while disconnected
    ticket = client.post("/v1/stream-tickets", headers=OP).json()["ticket"]
    with client.websocket_connect("/v1/stream") as ws:                      # browser-style: ticket message
        ws.send_json({"type": "auth", "ticket": ticket})
        assert ws.receive_json()["role"] == "ticket"
        ws.send_json({"type": "subscribe", "session_id": sid, "event_types": ["session.*"], "after_cursor": last})
        assert ws.receive_json()["type"] == "snapshot"
        replayed = ws.receive_json()
        assert replayed["replay"] is True and replayed["event"]["payload"]["state"] == "paused"
        assert ws.receive_json()["type"] == "synced"
    with client.websocket_connect("/v1/stream") as ws:                      # tickets are single use
        ws.send_json({"type": "auth", "ticket": ticket})
        assert ws.receive_json()["error"]["code"] == "unauthorized"


def test_history_expired(settings):
    settings.event_buffer = 5
    with TestClient(create_app(settings, start_background=False)) as c:
        sid = c.post("/v1/sessions", headers=OP, json={}).json()["session_id"]
        for action in ("start", "pause", "resume", "pause", "resume", "pause", "resume"):
            c.post(f"/v1/sessions/{sid}/{action}", headers=OP)
        response = c.get(f"/v1/sessions/{sid}/events?after_cursor=0", headers=OP)
        assert response.status_code == 410 and response.json()["error"]["code"] == "history_expired"
        page = c.get(f"/v1/sessions/{sid}/events?after_cursor={response.json()['error']['details']['oldest_complete_after_cursor']}",
                     headers=OP)
        assert page.status_code == 200 and len(page.json()["events"]) == 5
        with c.websocket_connect("/v1/stream", headers=OP) as ws:
            ws.receive_json()
            ws.send_json({"type": "subscribe", "session_id": sid, "after_cursor": 1})
            assert ws.receive_json()["type"] == "history_expired"
            assert ws.receive_json()["type"] == "snapshot"


def test_origin_and_cors(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/v1/stream", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect("/v1/stream", headers={"Origin": "http://localhost:5173", **OP}) as ws:
        assert ws.receive_json()["type"] == "auth.ok"
    ok = client.options("/v1/sessions", headers={"Origin": "http://localhost:5173",
                                                 "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    denied = client.options("/v1/sessions", headers={"Origin": "https://evil.example",
                                                     "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in denied.headers


def test_capabilities_without_assistant(client):
    caps = client.get("/v1/capabilities", headers=OP).json()
    assert caps["assistant"]["reachable"] is False
    assert "speech.rate_high" in caps["coaching_rules"] and caps["storage"]["raw_audio"] is False


def test_lan_requires_tls_or_explicit_flag(settings):
    settings.host, settings.lan = "0.0.0.0", True
    with pytest.raises(ValueError):
        settings.validate_network()
    settings.allow_insecure_lan = True
    assert "INSECURE" in settings.validate_network()[0]
    settings.lan, settings.allow_insecure_lan = False, False
    with pytest.raises(ValueError):
        settings.validate_network()                                         # non-loopback without --lan
