"""Command line: python -m coach <command>   (scripts/coach.sh wraps this with the service venv)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from coach.config import SERVICE_DIR, Settings

REPO_DIR = SERVICE_DIR.parent.parent


def _settings(args) -> Settings:
    settings = Settings.from_env()
    for attr in ("host", "port", "tls_cert", "tls_key"):
        value = getattr(args, attr, None)
        if value is not None:
            setattr(settings, attr, value)
    if getattr(args, "lan", False):
        settings.lan = True
        if settings.host == "127.0.0.1":
            settings.host = "0.0.0.0"
    if getattr(args, "allow_insecure_lan", False):
        settings.allow_insecure_lan = True
    return settings


def _base_url(args) -> str:
    return args.url


def cmd_serve(args) -> int:
    import uvicorn

    from coach.api import create_app

    settings = _settings(args)
    try:
        for warning in settings.validate_network():
            print(f"WARNING: {warning}", file=sys.stderr)
    except ValueError as exc:
        print(f"Refusing to start: {exc}", file=sys.stderr)
        return 2
    app = create_app(settings)
    auth = app.state.auth
    scheme = "https" if settings.tls_cert else "http"
    print(f"coach backend on {scheme}://{settings.host}:{settings.port}  (schema 1.0)")
    if auth.token_file:
        print(f"operator token written to {auth.token_file} (0600); CLI tools read it from there")
    else:
        print("operator token: from COACH_API_TOKEN")
    if settings.lan:
        print("LAN mode: the iPhone must use this Mac's LAN address or .local name, never 'localhost'.")
    uvicorn.run(app, host=settings.host, port=settings.port, ssl_certfile=settings.tls_cert,
                ssl_keyfile=settings.tls_key, ws_max_size=settings.max_message_bytes, log_level=args.log_level,
                ws_ping_interval=20, ws_ping_timeout=20)
    return 0


def cmd_pair(args) -> int:
    from coach.client import CoachClient, operator_token

    client = CoachClient(args.url, operator_token(), ca_file=args.ca)
    result = client.pairing_code()
    code = result["code"]
    print(f"Pairing code: {code[:4]}-{code[4:]}   (single use, expires {result['expires_at']})")
    print("Enter it in the iPhone app together with the backend URL (LAN address, not localhost).")
    return 0


def cmd_simulate(args) -> int:
    from coach.simulator import main_sync

    export = Path(args.export) if args.export else None
    summary = main_sync(args.url, args.speed, export, args.quiet, args.ca)
    if args.json:
        print(json.dumps(summary, indent=2))
    return 0


def cmd_stream(args) -> int:
    from coach.client import operator_token, stream

    async def run():
        types = args.types.split(",") if args.types else None
        async for msg in stream(args.url, operator_token(), session_id=args.session, event_types=types,
                                after_cursor=args.after, ca_file=args.ca):
            kind = msg.get("type")
            if kind == "event":
                e = msg["event"]
                payload = json.dumps(e["payload"], ensure_ascii=False)
                if args.full:
                    print(json.dumps(msg, ensure_ascii=False), flush=True)
                else:
                    sim = " SIM" if e["source"]["simulated"] else ""
                    print(f"#{e['cursor']:<6} {e['timing']['corrected_captured_at']} {e['event_type']:<26} "
                          f"{e['source']['device_id']}{sim}  {payload[:160]}", flush=True)
            elif kind == "snapshot":
                s = msg["snapshot"]["session"]
                print(f"snapshot cursor={msg['cursor']} session={s['session_id']} state={s['state']} "
                      f"simulated={s['simulated']}", flush=True)
            else:
                print(json.dumps(msg, ensure_ascii=False)[:300], flush=True)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    return 0


def cmd_brain_bridge(args) -> int:
    from coach.brain_bridge import run_bridge
    from coach.client import operator_token

    try:
        run_bridge(args.url, args.brain, operator_token, vignette=not args.no_vignette, force=args.force)
    except KeyboardInterrupt:
        pass
    return 0


def cmd_request(args) -> int:
    from coach.client import ApiError, CoachClient, operator_token

    client = CoachClient(args.url, operator_token(), ca_file=args.ca)
    body = json.loads(args.json) if args.json else None
    try:
        print(json.dumps(client.request(args.method.upper(), args.path, body), indent=2, ensure_ascii=False))
    except ApiError as exc:
        print(json.dumps(exc.body, indent=2), file=sys.stderr)
        return 1
    return 0


def cmd_export(args) -> int:
    from coach.client import CoachClient, operator_token

    path = CoachClient(args.url, operator_token(), ca_file=args.ca).export(args.session, Path(args.out))
    print(f"wrote {path}")
    return 0


def cmd_replay(args) -> int:
    from coach.export import read_export, replay
    from coach.session import SessionManager

    header, events = read_export(Path(args.file))
    settings = Settings.from_env()
    session = replay(SessionManager(settings), header, events)
    if session.state != "ended":
        session.transition("stop", "replay finished")
    summary = session.summary()
    original = [e["payload"]["rule_id"] for e in events if e["event_type"] == "coaching.feedback"]
    replayed = [item["rule_id"] for item in session.coach.history]
    evicted = header.get("buffers", {}).get("evicted_pose_frames", 0)
    if evicted:
        print(f"WARNING: export is incomplete ({evicted} pose frames were evicted from the bounded buffer before "
              "export); replayed metrics can differ. Raise COACH_POSE_BUFFER for complete exports.", file=sys.stderr)
    print(json.dumps({"replayed_events": sum(1 for e in events if e["source"]["kind"] != "server"),
                      "simulated": header["simulated"], "coaching_original": original,
                      "coaching_replayed": replayed, "match": original == replayed,
                      "summary": {k: summary[k] for k in ("speech", "body", "coaching")}}, indent=2, ensure_ascii=False))
    return 0 if original == replayed or not args.strict else 1


def cmd_fixture(args) -> int:
    """Write a deterministic, clearly simulated session export (no server needed)."""
    from coach.export import export_lines
    from coach.session import SessionManager
    from coach.simulator import run_in_process

    settings = Settings.from_env()
    settings.pose_buffer = 100_000
    session = run_in_process(SessionManager(settings), seed=args.seed, pose_hz=args.pose_hz)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = "".join(export_lines(session)).encode("utf-8")
    if out.suffix == ".gz":
        import gzip
        data = gzip.compress(data, mtime=0)
    out.write_bytes(data)
    rules = [h["rule_id"] for h in session.coach.history]
    print(f"wrote {out} ({out.stat().st_size // 1024} KiB, simulated=True, coaching={rules})")
    return 0


def cmd_contracts(args) -> int:
    from coach.contracts import write_contracts

    for path in write_contracts(Path(args.out)):
        print(f"wrote {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="coach", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def client_args(p):
        p.add_argument("--url", default="http://127.0.0.1:8765", help="backend base URL")
        p.add_argument("--ca", default=None, help="CA certificate for https/wss (development CA)")

    p = sub.add_parser("serve", help="run the backend (localhost by default)")
    p.add_argument("--host"), p.add_argument("--port", type=int)
    p.add_argument("--lan", action="store_true", help="bind 0.0.0.0 for a physical iPhone (TLS required)")
    p.add_argument("--allow-insecure-lan", action="store_true", help="DEVELOPMENT ONLY: LAN without TLS")
    p.add_argument("--tls-cert"), p.add_argument("--tls-key")
    p.add_argument("--log-level", default="info")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("pair", help="create a single-use pairing code for a device")
    client_args(p)
    p.set_defaults(func=cmd_pair)

    p = sub.add_parser("simulate", help="run a complete simulated session against a running backend")
    client_args(p)
    p.add_argument("--speed", type=float, default=8.0, help="1 = real time (live timeline); >1 = event_time")
    p.add_argument("--export", help="write the session as JSONL")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--json", action="store_true", help="print the summary as JSON")
    p.set_defaults(func=cmd_simulate)

    p = sub.add_parser("stream", help="print the event stream of a session")
    client_args(p)
    p.add_argument("--session", default="latest")
    p.add_argument("--types", help="comma-separated event types, wildcard suffix allowed: speech.*")
    p.add_argument("--after", type=int, default=None, help="resume after this cursor")
    p.add_argument("--full", action="store_true", help="print full JSON messages")
    p.set_defaults(func=cmd_stream)

    p = sub.add_parser("brain-bridge", help="forward coaching to the brain (garaza-frontier-2026-backend) over WebSockets")
    client_args(p)
    p.add_argument("--brain", default="http://127.0.0.1:8787", help="brain base URL")
    p.add_argument("--no-vignette", action="store_true", help="don't take the brain's operator role (operator panel open)")
    p.add_argument("--force", action="store_true", help="vignette on every coaching feedback during a run (demo)")
    p.set_defaults(func=cmd_brain_bridge)

    p = sub.add_parser("request", help="authenticated REST request, e.g. request GET /v1/sessions")
    client_args(p)
    p.add_argument("method"), p.add_argument("path"), p.add_argument("--json")
    p.set_defaults(func=cmd_request)

    p = sub.add_parser("export", help="export a session as JSONL")
    client_args(p)
    p.add_argument("session"), p.add_argument("out")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("replay", help="deterministically replay an exported JSONL file (in-process)")
    p.add_argument("file"), p.add_argument("--strict", action="store_true", help="fail if coaching differs")
    p.set_defaults(func=cmd_replay)

    p = sub.add_parser("fixture", help="write the simulated scenario as a JSONL fixture (in-process)")
    p.add_argument("--out", default=str(REPO_DIR / "fixtures" / "simulated_session.jsonl.gz"))
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--pose-hz", type=float, default=6.0)
    p.set_defaults(func=cmd_fixture)

    p = sub.add_parser("contracts", help="generate JSON Schemas, OpenAPI and TypeScript types")
    p.add_argument("--out", default=str(REPO_DIR / "contracts"))
    p.set_defaults(func=cmd_contracts)

    args = parser.parse_args(argv)
    return args.func(args)
