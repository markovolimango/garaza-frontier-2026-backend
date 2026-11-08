# Extensions log

**Every extension — a new or changed interface, message, field, option, config key or
behaviour that the spec does not define — must be recorded here with a timestamp, so that
different agents can sync up when merging.** Before merging, read every entry newer than
the commit you branched from.

Format: newest first, one entry per extension, using this template.

```md
### 2026-11-07T21:53+01:00 · <lane> · <short title>
- **Where:** file(s) / symbol(s)
- **What:** the extension, in one or two sentences
- **Why:** what the spec left open or what needed it
- **Impact:** who must react (lane / component), or "none"
```

Lanes: `lead` (protocol), `brain`, `sensing`, `agents`, `stage`, `report`.

---

### 2026-11-08T02:30+01:00 · brain · Four judges in the default panel (`judge_seat_4`)
- **Where:** `packages/protocol/src/venue.ts` (`GREYBOX_VENUE.anchors.judge_seat_4`), `apps/brain/src/brain.ts` (`defaultScene`: + "Newcomer", warm, 0.4), `fixtures/messages/down.scene.sync.json` (regenerated), `apps/brain/test/session.test.ts` (non-existent seat is now `judge_seat_5`)
- **What:** the default panel has 4 judges, matching the 4 seats of the stage's 3D room and the 4 judge voices.
- **Why:** judge_4 had no seat, so it never spoke and the 4th 3D judge stayed silent.
- **Impact:** context service: personas for 4 judges. `REQUIRED_ANCHORS` unchanged (3 seats still the minimum).

### 2026-11-08T02:30+01:00 · stage · Judges preload (`src/brain/preload.ts`)
- **Where:** `apps/frontend/src/brain/preload.ts`, `BrainSource.ts` (`ui.state` ≠ setup)
- **What:** 1 s after the deck is in, imports the judges screen and calls `useLoader.preload(FBXLoader, …)` with the URLs `Judge.tsx` uses, so the Q&A room renders without fetching or parsing 61 MB of FBX. Measured: all 10 files fetched during the JJ intro, 0 after opening the judges screen; main-thread blocks on the JJ screen ≤ 217 ms each, 650 ms in total.
- **Why:** the room stood empty for seconds after the slides.
- **Impact:** judges lane: keep `CHARACTER_URL` / `CLIP_URLS` exported and loaded with `useLoader(FBXLoader, …)` (or update `preload.ts`). A compressed GLB would cut the 54 MB character further.

### 2026-11-08T02:30+01:00 · sensing · Bridge creates the coach session for each brain run
- **Where:** `services/coach/coach/brain_bridge.py` (`coach_session_plan`, `Bridge._sync_sessions`), `--no-sessions`
- **What:** presentation starts → create a live coach session (label `brain run_N`) and start it; JJ listening → pause/resume; run ends → stop. `vision/run.sh --coach` and the iPhone app join the newest session, so camera frames flow only during runs. Verified with the real `CoachLink` and generated keypoints: session created, 341 frames accepted, `body.hand_movement_high` → `feedback.set warn` on the stage, session stopped at run end.
- **Why:** nothing created coach sessions, so the camera had nowhere to send frames.
- **Impact:** iPhone app / operator flows that create their own sessions: run the bridge with `--no-sessions`.

### 2026-11-08T02:10+01:00 · stage · UX fixes from a full walkthrough (resume, next run, timer, two tabs)
- **Where:** `apps/frontend/src/brain/{BrainBridge.tsx, BrainSource.ts, mapping.ts, audio.ts, judges.ts}`; tagged edits in `src/signals/bus.ts` (+`runClock`), `src/components/presenter/Timer.tsx`, `src/components/JudgesStage.tsx`; `e2e/frontend-brain.mjs` (33 checks)
- **What:** Esc or a click on "JJ is listening" invokes `resume_run`. After a run, JJ's screen is allowed (no snap-back) and a "Next run" bar offers `start_run` and `start_run {mode: training, level: strong}`. Snap-back hints say what to do. The presenter timer follows the run (`runClock`). `/ws/audio` and `/ws/mic` stop reconnecting after close 4001, so two tabs no longer steal the sockets from each other every second. The judges' audio turns on by itself after an earlier click on the page. Judge lines without audio fall back to text after 1.5 s (was 2.5 s).
- **Why:** with fake JJ a wake never ended (the run stayed paused into Q&A); "Back to JJ" did nothing after a run; the placeholder coach never leaves baseline without JJ setting targets, so no run ever had feedback; the timer stood at 5:00 during the talk.
- **Impact:** coach policy / JJ: "With live feedback" bypasses the recommendation the way the operator can; drop it once JJ picks targets. Lovable: keep the tagged edits in `Timer.tsx` and `JudgesStage.tsx`.

### 2026-11-08T01:44+01:00 · stage · Brain judges on the real judges screen (`JudgeRelay`, `judgeCommand` `speak`)
- **Where:** `apps/frontend/src/brain/judges.ts` (new), `BrainSource.ts`; tagged edits in `apps/frontend/src/signals/judges.ts` and `src/components/JudgesStage.tsx`; `e2e/frontend-brain.mjs`
- **What:** BrainSource turns `actor.say` / `actor.gesture` for judge_1..4 into bus `judgeCommand`s: `speak` (new variant: `level()` from that source's audio, `done` when its playback ends) once the judge's audio starts, `say` when none comes within 2.5 s, `react` for gestures. The e2e finds Chrome on macOS, warms Vite up before the first click, and adds a second run that checks the 3D judges and a `POST /debug/judge-say` subtitle (30 checks).
- **Why:** Lovable put Marko's scene on `/judges` with its own `BackendSource`, which would take the stage role from BrainSource (one connection per role); under the brain the judges got no brain messages.
- **Impact:** stage: keep `JudgesStage` in mock mode under the brain. Director: judge lines reach the screen through `speakJudge` with no further wiring. Lovable: keep the `speak` branch when editing `JudgesStage`.

### 2026-11-08T01:44+01:00 · lead · pnpm lockfile includes the 3D judges dependencies
- **Where:** `pnpm-lock.yaml`
- **What:** `three`, `@types/three`, `@react-three/fiber`, `@react-three/drei` (added to `apps/frontend/package.json` by hand) are now in the lockfile.
- **Why:** `pnpm install --frozen-lockfile` failed after the frontend subtree pull.
- **Impact:** none.

### 2026-11-08T01:38+01:00 · sensing · Coach backend (`services/coach`) + bridge to the brain
- **Where:** `services/coach` (Python FastAPI, :8765), `vision/`, `apple/`; bridge `services/coach/coach/brain_bridge.py` (`python -m coach brain-bridge`, `scripts/coach-brain-bridge.sh`)
- **What:** the coach backend computes pose/speech/heart metrics and deterministic coaching feedback from the iPhone/Watch apps or `vision/ --coach`. The bridge follows its latest session (`/v1/stream`) and sends the brain `sensor.status` (role `sensor`), `behavior sway` start/end for `body.torso_movement_high`, and, while a run is live (presentation or Q&A, not paused, `feedbackLevel` not off, category in `run.enabledCategories`), `operator.override vignette warn` (role `operator`; strong 0.7, gentle 0.4, hold until the feedback expires, 1.5-6 s). `--force` ignores level and categories (demo); `--no-vignette` leaves the operator role alone.
- **Why:** the brain has no feedback controller yet, so `behavior` alone shows nothing; the operator override is already handled.
- **Impact:** operator panel: one connection per role, so run the bridge with `--no-vignette` when the panel is open (the bridge does not retake a replaced role). Feedback controller lane: `behavior sway` already arrives from the sensor role; replace the override with `sync.setFeedback` when the controller lands.

### 2026-11-08T00:30+01:00 · agents · Judge voices (ElevenLabs) + `POST /debug/judge-say`
- **Where:** `apps/brain/src/voices/judgeVoice.ts` (`JudgeVoices`, `speakJudge`, `judgeVoicesHttp`, `DEFAULT_JUDGE_VOICE_IDS`), wired in `apps/brain/src/server.ts` via the `http` option; config keys `ELEVENLABS_API_KEY`, `JUDGE_VOICE_IDS` in `apps/brain/src/config.ts`
- **What:** `speakJudge(judge_N, text)` queues one utterance at a time: `actor.gesture talk` → `actor.say {utteranceId: judge_N_uK, source: N}` → ElevenLabs streaming TTS (`eleven_flash_v2_5`, `pcm_24000`) forwarded on `/ws/audio` with JJ's framing (start flag on the first frame, empty end-flagged frame) → waits for the stage's `audio.playback` ended/stopped (fallback: audio length + 1.5 s) → `actor.gesture idle`. `JUDGE_VOICE_IDS` (comma-separated, judge_1..4) defaults to premade Rachel, Adam, Antoni, Sarah. No key → say + gestures only, audio skipped and logged; independent of `JJ_FAKE`. Debug: `POST /debug/judge-say {judge: 1-4, text}` → 202 `{ok, actorId, utteranceId, voiceId}`.
- **Why:** hear and stage-test judge voices before the director lands.
- **Impact:** director: call `JudgeVoices.speakJudge` instead of its own TTS. Stage: `judge_4` needs a judge in the scene (the default scene has 3). `JUDGE_VOICES` (JJ config, scene `voiceId`) is not read by this module.

### 2026-11-07T23:23+01:00 · stage · Lovable frontend integrated (subtree + brain layer)
- **Where:** `apps/frontend` (git subtree of the frontend repo), `apps/frontend/src/brain/*`, tagged edits in `bus.ts`, `signals/index.ts`, `__root.tsx`, `presenter.tsx`
- **What:** `BrainSource` (real `SignalSource`) and `BrainBridge`; new bus channels `slideCommand` and `deckFile`; `VITE_SIGNAL_SOURCE=brain` + `VITE_BRAIN_URL` select the brain; brain views map to Lovable's four routes; forward Next/keys 1–4 become `start_run` / `presentation.done` / `end_run`; brain-driven navigation waits ~300 ms after mount for hydration; overlay renders client-only.
- **Why:** the Lovable app had only a mock bus and a placeholder WebSocket with an invented format.
- **Impact:** Lovable side: keep the bus contract and zod 4 (docs/integration.md §14).

### 2026-11-07T23:23+01:00 · lead · One zod (4.6.6) across the repo
- **Where:** `apps/frontend/package.json`
- **What:** the frontend moved from zod 3.25 to 4.6.6.
- **Why:** the SSR (nitro) bundle collapsed `zod` to the frontend's copy, so `@coach/protocol` ran on zod 3 and crashed server renders.
- **Impact:** Lovable must not downgrade zod.

### 2026-11-07T23:23+01:00 · agents · Upload endpoints and CORS
- **Where:** `apps/brain/src/context/uploads.ts`, `brain.ts`, `config.ts` (`CORS_ORIGINS`)
- **What:** `POST /api/uploads/deck` (multipart: `manifest` + `slide_<n>.png`, PNG magic checked, indexes 0..n-1, ≤ 60 slides), `POST /api/uploads/docs` (≤ 10 docs, 50k/150k chars), `GET /api/decks/:deckId/:n.png`; files under `SESSION_DIR/<sessionId>/uploads/`; refused with 409 `wrong_phase` during a run. CORS allows localhost/127.0.0.1 on any port plus `CORS_ORIGINS`.
- **Why:** the frontend dev server is on another origin; session.start needs a deck.
- **Impact:** setup UIs post here.

### 2026-11-07T23:23+01:00 · brain · `SessionAction` is inferred from its schema
- **Where:** `apps/brain/src/session.ts`
- **What:** `export type SessionAction = z.infer<typeof ActionSchema>`; brain code also compiles under `exactOptionalPropertyTypes` (the frontend's setting).
- **Why:** spec rule "types are z.infer of the schema"; the frontend's typecheck follows the integration test into brain sources.
- **Impact:** none.

### 2026-11-07T23:23+01:00 · lead · Spec gap: no protocol path for "reset"
- **Where:** spec "Operator panel" lists a reset button; neither `ToolName` nor `operator.override` can reset.
- **What:** open, not implemented. Proposal: `operator.override {action: "reset"}`.
- **Why:** found while writing the e2e (it needs a fresh session; today: restart the brain).
- **Impact:** operator panel.

### 2026-11-07T21:53+01:00 · brain · Repo layout: JJ code lives only under `apps/brain/src/jj/`
- **Where:** `apps/brain/src/jj/tools.ts` (was `apps/brain/src/tools.ts`), `apps/brain/src/jj/VERIFY.md` (was `docs/jj-verification.md`), JJ scripts moved from the root `package.json` to `@coach/brain` (`pnpm --filter @coach/brain jj:playground | jj:smoke`)
- **What:** nothing JJ-specific at the repo root or the brain root any more.
- **Why:** clean project structure.
- **Impact:** import `ToolRegistry` / `createCoachTools` from `./jj/tools.ts`.

### 2026-11-07T21:53+01:00 · brain · `createBrain()` composition root with pluggable lanes
- **Where:** `apps/brain/src/brain.ts`, `server.ts`, `config.ts`
- **What:** options `coach`, `context`, `reports`, `stt`, `agent`, `http` plug in each lane; placeholders (`placeholders.ts`) keep the brain runnable. Unimplemented `/api/*` routes answer 501 `{ok:false, reason:"not_available"}`. `/health` also reports `mic` and `phase`.
- **Why:** lanes integrate without editing each other's files.
- **Impact:** every lane: integrate through these options (docs/integration.md §4).

### 2026-11-07T21:53+01:00 · brain · Config keys `BRAIN_HOST`, `LOG_LEVEL`, `JJ_FAKE`, `JJ_SPEECH_RMS`
- **Where:** `apps/brain/src/config.ts`, `apps/brain/src/jj/config.ts`, `.env.example`
- **What:** bind host (default 127.0.0.1), log level, `JJ_FAKE=1` runs without Gemini (FakeVoiceAgent), mic RMS threshold for JJ auto-resume.
- **Why:** run the brain before keys exist; tune auto-resume on site.
- **Impact:** none.

### 2026-11-07T21:53+01:00 · brain · `CoachPolicy` port
- **Where:** `apps/brain/src/session.ts` (`CoachPolicy`), placeholder in `placeholders.ts`
- **What:** `initial()`, `recommend(c)`, `afterRun(prev, run)` (sync, called while the run ends), `setTargets(prev, targets, completedRuns)`, `setLevel(prev, level)`.
- **Why:** the spec defines `initialCoach/updateCoach/recommend` as functions of a `RunSummary`; the store needs one object it can call without knowing about the event store.
- **Impact:** rules lane: implement `CoachPolicy` by calling `summarizeRun` + `updateCoach` inside `afterRun`.

### 2026-11-07T21:53+01:00 · brain · Session store additions
- **Where:** `apps/brain/src/session.ts`
- **What:**
  - `SessionEvent` causes delivered to subscribers: `countdown {secondsLeft}`, `presentation_started`, `context {patch}`. Subscriber cause type is `SessionAction | SessionEvent | SceneOp[]`.
  - `setContext(patch)` for ContextService (deck, docs, brief, digest); a deck change re-sends `scene.sync`.
  - `slide` action takes `from?: "stage" | "brain"`; stage-originated slide changes are not echoed back as `slide.show`.
  - A wake during the countdown also pauses the countdown timer.
  - `calibration_done` returns to the phase calibration started from (intro or debrief).
  - `show_final` with no finished run → `not_available`.
  - `set_targets` / `set_level` are accepted in every phase except setup; `set_categories` in every phase.
  - `run_it_back` restores the repeated run's scene version by re-applying a snapshot (`judges.set`, `audience.set`, `lighting.set`, `qa.set`); the repeated run still updates the coach when it ends.
  - Explicit `start_run` level is forced to `off` for baseline and test runs.
- **Why:** spec left these open.
- **Impact:** director, feedback controller, STT: react via `subscribe`; context lane: use `setContext`.

### 2026-11-07T21:53+01:00 · brain · `StateSync` downlink driver
- **Where:** `apps/brain/src/sync.ts`
- **What:** `setFeedback(cmd)` (sent only on change), `forceVignette(kind, intensity, holdMs)` (operator override), `currentFeedback()`, `jjChanged()`. Feedback is forced to `none` while paused and outside runs. Operator gets `run.state` as well as `state.snapshot`; sensor gets `run.state` and `sensor.config`.
- **Why:** one place for "what each role sees".
- **Impact:** feedback controller: call `brain.sync.setFeedback()`.

### 2026-11-07T21:53+01:00 · sensing · `MicRouter` and speech interfaces
- **Where:** `apps/brain/src/mic.ts`, `apps/brain/src/speech.ts`
- **What:** `MicRouter` implemented per the spec table plus `running: ended/aborted → jj`; `framesIn` counter. `SttStream`, `WakeDetector`, `SttFactory` are interfaces only.
- **Why:** routing is plumbing the brain needs now; the models stay with the sensing lane.
- **Impact:** sensing lane: implement `SttStream`/`WakeDetector` and wire as in docs/integration.md §8.

### 2026-11-07T21:46+01:00 · lead · Protocol helpers beyond the spec
- **Where:** `packages/protocol/src/*`
- **What:** `parseUplink` / `parseDownlink`, `envelope()`, `UPLINK_SENDERS` (allowed roles per uplink), `ALL_*_TYPES`, `ToolResult` schema, `FEEDBACK_NONE`, `CATEGORY_OF`, `GREYBOX_VENUE`, `REQUIRED_ANCHORS` (enforced by `VenueDef`), audio helpers (`encodeAudioFrame`, `decodeAudioFrame`, `micFrameToPcm`, `judgeSource`), `WS_PATHS`, `MicHello`, `PING_INTERVAL_MS`, `DEAD_AFTER_MS`, `DeckManifest` (≤ 60 slides), `ToolCatalogue`.
- **Why:** shared by every client and the brain.
- **Impact:** all lanes: import from `@coach/protocol` instead of re-declaring.

### 2026-11-07T21:46+01:00 · lead · Close codes and error replies
- **Where:** `packages/protocol/src/messages.ts` (`CLOSE_CODES`), `apps/brain/src/hub.ts`, `apps/brain/src/brain.ts`
- **What:** 4001 replaced (spec), 4002 protocol mismatch / bad `mic.hello`, 4003 no hello within 5 s, 4004 dead (15 s silence). `error` replies set envelope `replyTo` = the offending message id, as well as `payload.refId`.
- **Why:** spec defines only 4001; `replyTo` lets `ControlClient.request()` resolve on errors.
- **Impact:** pages: treat 4001/4002 as final (ControlClient does not reconnect).

### 2026-11-07T21:46+01:00 · brain · Hub API additions
- **Where:** `apps/brain/src/hub.ts`
- **What:** `attach(server)`, `onDisconnect`, `onMic`, `onInbound` / `onOutbound` (recorder taps), `connections()`, `micConnected()`. Uplinks from a role not in `UPLINK_SENDERS` are refused with `invalid_message`. Only one `/ws/mic` and one `/ws/audio` socket at a time (newest wins).
- **Why:** recorder, mic routing, health.
- **Impact:** recorder lane: use the taps.

### 2026-11-07T21:46+01:00 · stage · `ControlClient` behaviour
- **Where:** `apps/web/src/net/client.ts` (`@coach/web/net`)
- **What:** `request(type, payload)` resolves with the reply envelope; statuses `connecting | open | closed | replaced | refused`; no reconnect after 4001/4002; nothing is queued while disconnected (`send` returns null).
- **Why:** spec says only "shared WS client with reconnect".
- **Impact:** main app, sensor, operator pages.

### 2026-11-07T21:29+01:00 · agents · `VoiceAgent` extensions
- **Where:** `apps/brain/src/jj/voice-agent.ts`
- **What:** `onInterrupted(cb)` (provider barge-in, so the stage flushes source 0) and `setContextProvider(fn)` (fresh reconnects send current context). `ToolDeclaration.scheduling` / `ToolSpec.scheduling` (`INTERRUPT | WHEN_IDLE | SILENT`) for non-blocking tool results.
- **Why:** full duplex barge-in and reconnect context were not covered by the spec interface.
- **Impact:** anyone implementing another `VoiceAgent`.

### 2026-11-07T21:29+01:00 · agents · JJ engine behaviour the spec left open
- **Where:** `apps/brain/src/jj/engine.ts`, `apps/brain/src/jj/tools.ts`
- **What:**
  - `JJEngine` API: `acceptMic(pcm)` (MicRouter calls it), `noteWakePhrase(t)` (WakeDetector calls it before dispatching `wake`), `reconnect()`, `status()`.
  - `actor.say {actorId:"jj"}` is sent with `text: ""` (the transcript arrives after the audio starts).
  - After a wake, auto-resume if JJ never answers within 10 s of silence.
  - JJ audio during an un-woken run is dropped, except the rest of an utterance that started while woken.
  - System notes sent to JJ: `[SESSION START]`, `[SESSION CONTEXT]`, `[RUN ABORTED]`, `[UI ACTION]` (besides the spec's `[WOKEN …]` and `[RUN ENDED]`).
  - `set_judge` resolves left/center/right by seat order (numeric); with an even panel "center" is refused with a hint.
  - `save_brief` and `set_judges {count}` apply the default toughness spread (0.3/0.5/0.8, interpolated for other sizes) unless an instruction was given.
- **Why:** spec left these open.
- **Impact:** director (none yet); prompts lane: `prompts/jj.md` documents the notes.
