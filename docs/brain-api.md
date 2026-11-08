# Brain API (`apps/brain`, :8787)

The brain's HTTP routes and WebSocket messages. Schemas and types: `packages/protocol/src/` (`messages.ts`
for the WebSocket catalogue, `reports.ts` and `domain.ts` for the JSON bodies). The coach backend
(`services/coach`, :8765) has its own contract in [api.md](api.md); how the parts are wired is in
[integration.md](integration.md).

Base URL: `http://127.0.0.1:8787` (`BRAIN_HOST`, `BRAIN_PORT`). CORS allows localhost / 127.0.0.1 on any
port plus `CORS_ORIGINS`. Errors are JSON `{ok: false, reason, hint?}`; an unknown `/api/*` path answers 501.

## HTTP

| Method | Path | Purpose | Code |
|---|---|---|---|
| GET | `/health` | liveness: connected roles, mic, JJ up/down, session phase | `brain.ts` |
| GET | `/api/tools` | the coach tools' catalogue (names, args schemas) for the operator panel's forms | `brain.ts`, `jj/tools.ts` |
| GET | `/api/session` | `{sessionId, phase, runs, savedAt}` of the current (saved) session | `persist.ts` |
| POST | `/api/session/reset` | new session; `{full?: true, keepData?: false}`: a full reset erases the previous one from disk (runs, reports, uploads, recordings); `full: false` keeps the deck and erases nothing | `persist.ts` |
| GET | `/api/session/export.html[?download=1]` | printable session report (measured behaviour only, no personal goals) | `swarm/reporter.ts` (document: `swarm/reportPdf.ts`) |
| GET | `/api/runs` | the session's runs `[{runId, index, mode, level, ended}]` | `digest.ts` |
| GET | `/api/runs/:runId/report` | one run's digest (RunDigest); 404 for an unknown run | `digest.ts` |
| GET | `/api/progress` | progress across the finished runs (SessionProgress) | `progress.ts` |
| GET | `/api/swarm/report/run/:runId` | the reporter's written run report: `{status: pending \| ready \| none, report}` (RunNarrative) | `swarm/reporter.ts` |
| GET | `/api/swarm/report/session` | the same for the whole session (SessionNarrative); starts building it when missing or stale | `swarm/reporter.ts` |
| GET | `/api/swarm/report/session.html` | the session report as a printable page | `swarm/reporter.ts` |
| POST | `/api/pitch/start` | pitch mode: JJ goes silent and a pitch run starts listening at once (no deck, no countdown, no Q&A); `{ok, runId}`, 409 while another run is live | `pitch.ts` |
| POST | `/api/pitch/stop` | ends the pitch (the reporter starts writing); `{ok, runId}` | `pitch.ts` |
| POST | `/api/pitch/exit` | leaves pitch mode: JJ may talk again; 409 while a pitch is being recorded | `pitch.ts` |
| GET | `/api/pitch/dashboard[/:runId]` | one pitch as the stage's dashboard (PitchDashboard): duration, words per minute, fillers with their moments, transcript, body behaviours with their episodes; the latest pitch without an id | `pitch.ts` |
| GET | `/api/swarm/report/session.pdf[?download=1]` | that page as a PDF (local Chrome, `CHROME`; 501 without one), also saved in the session folder | `swarm/reporter.ts` |
| GET | `/api/sensors/check` | the pre-run check (SensorCheck): coach bridge connected, camera state and fps, person in frame, microphone, `ready` and hints | `sensors.ts` |
| POST | `/api/uploads/deck` | multipart deck: `manifest` (DeckManifest) + `slide_<n>.png` → Deck; 409 during a run | `context/uploads.ts` |
| POST | `/api/uploads/docs` | context documents `{docs: [{name, mime, text}]}` → their metadata | `context/uploads.ts` |
| GET | `/api/decks/:deckId/:n.png` | one slide image | `context/uploads.ts` |
| POST | `/api/convert/pptx` | body: a `.pptx` (≤ 100 MB) → `application/pdf`, converted by PowerPoint on this Mac; 422 with a hint otherwise | `pptx.ts` |
| POST | `/api/media/:runId/chunk?seq=N&startedAt=ms` | the next chunk of a run's camera + mic recording (≤ 25 MB, in order) | `media.ts` |
| POST | `/api/media/:runId/done` | that recording is finished | `media.ts` |
| GET | `/api/media/:runId/video` | the recording, with byte ranges (seeking) | `media.ts` |
| GET | `/api/media` | this session's recordings | `media.ts` |
| POST | `/debug/judge-say` | debug, not gated yet: `{judge: 1-4, text}` → that judge speaks it (ElevenLabs when `ELEVENLABS_API_KEY` is set); 202 `{ok, actorId, utteranceId, voiceId}` | `voices/judgeVoice.ts` |

## WebSockets

| Path | Direction | Content |
|---|---|---|
| `/ws/control` | both | JSON envelopes `{v: 1, type, id, ts, replyTo?, payload}`. `hello {role, clientId, protocol}` → `welcome`, then the role's initial state. Roles: `stage`, `sensor`, `operator`; one connection per role (a new one replaces the old, close 4001). Ping every 5 s, dead after 15 s. |
| `/ws/mic` | stage → brain | text `{"type": "mic.hello", "sampleRate": 16000}`, then 20 ms Int16 PCM frames |
| `/ws/audio` | brain → stage | 4-byte header (source, flags, seq) + 24 kHz Int16 PCM; source 0 = JJ, 1–4 = judges |

### Downlinks (brain → clients, `/ws/control`)

| Type | To | Purpose |
|---|---|---|
| `welcome` | any | reply to `hello`: session id, server time, protocol |
| `error` | any | a refused message or request (`code`, `message`, `refId`) |
| `ping` | any | keep-alive (answer `pong`) |
| `tool.result` | stage, operator | result of a `tool.invoke` (`replyTo` = the request) |
| `state.snapshot` | operator | the whole session, connections, JJ and feedback state (on connect and on change, ≤ 10 Hz) |
| `ui.state` | stage | which screen to show, the orb, intro done |
| `scene.sync` | stage | the full scene (panel, venue, deck): on connect and on a rollback |
| `scene.apply` | stage | a batch of scene ops; the stage applies it and replies `ack` |
| `run.state` | stage, sensor, operator | the run (mode, phase, paused, targets, feedback level) and the session phase |
| `feedback.set` | stage | the vignette: warn (red) / reward (green) / none, with intensity |
| `slide.show` | stage | jump to a slide |
| `countdown` | stage | 3, 2, 1, 0 before a run |
| `actor.say` | stage | JJ or a judge says a line (`utteranceId`, audio `source`) |
| `actor.gesture` | stage | a judge's or the audience's gesture |
| `actor.lookAt` | stage | where a judge looks (presenter, notes, audience, another judge) |
| `audio.stop` | stage | flush a source's audio (barge-in) |
| `jj.state` | stage, operator | JJ's connection and listening / speaking state |
| `jj.transcript` | stage, operator | JJ's captions: one line of JJ or the user, re-sent as it grows, `final` once complete |
| `report.ready` | stage | a run report (`runId`) or the final report is ready |
| `report.focus` | stage | the behaviour JJ is talking about on the report screen |
| `moments.show` | stage | replay clips of a run's recording (JJ's `show_moments`); no clips = hide |
| `swarm.activity` | stage, operator | the agents panel: JJ and its agents, each with its state and what it is doing |
| `sensor.config` | sensor | enabled feedback categories, calibration, debug |
| `hud.toast` | stage | a short on-screen notice |

Uplinks (clients → brain) and who may send each: `UPLINK` and `UPLINK_SENDERS` in
`packages/protocol/src/messages.ts`. The coach bridge (`services/coach/coach/brain_bridge.py`) sends
`sensor.status`, `behavior` and `coach.observation` as `sensor`, and `operator.override` vignettes as
`operator`.
