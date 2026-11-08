# coach: headless presentation-practice backend

FastAPI + asyncio service. It owns the session state, ingests device events (pose, speech, heart
rate), computes movement and speaking observations, applies deterministic coaching rules and serves
REST + WebSocket APIs. There is no UI. Contract: [../../docs/api.md](../../docs/api.md).

```bash
bash scripts/coach-setup.sh          # venv (Python 3.11-3.13), locked dependencies, pytest
bash scripts/coach-serve.sh          # http://127.0.0.1:8765 (operator token -> services/coach/.runtime/api_token)
bash scripts/coach-demo.sh           # complete simulated session (starts a server if none is running)
bash scripts/coach-stream.sh         # print the live event stream (--types "coaching.*" --after <cursor>)
bash scripts/coach-requests.sh       # sample REST requests with curl
bash scripts/coach-pair.sh           # pairing code for the iPhone app
bash scripts/coach-contracts.sh      # regenerate contracts/ (schemas, OpenAPI, TypeScript)
```

CLI: `services/coach/.venv/bin/python -m coach {serve,pair,simulate,stream,request,export,replay,fixture,contracts}`.

- Configuration: environment or `services/coach/.env` (see `.env.example`). Per-session thresholds
  go in `POST /v1/sessions {"config": ...}`; the defaults are listed in `GET /v1/capabilities`.
  All thresholds are demo heuristics.
- Storage: in-memory and bounded, with TTL cleanup. No raw audio or video. Explicit JSONL export
  and deterministic replay (`python -m coach replay file.jsonl --strict`).
- Tests: `cd services/coach && .venv/bin/python -m pytest -q`.
