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

### 2026-11-08T13:30+01:00 · brain · Run recordings and replayed moments (`moments.show`, `show_moments`)
- **Where:** `apps/brain/src/media.ts` (new: `MediaStore`, `mediaHttp`, `momentsOf`), `server.ts`, `jj/{tools,ports}.ts` (`show_moments`, `ReportsPort.moments`, `JJDownlink` + `moments.show`), `prompts/jj.md` (debrief and final use it; hard rule: `start_run` only after the user's explicit go); protocol `messages.ts` (`DOWNLINK["moments.show"]`), `tools.ts` (`show_moments {kind | "none", run?: "last" | "first"}`), samples + `fixtures/messages/down.moments.show.json`; frontend `src/brain/{recorder.ts, MomentsPlayer.tsx}` (new), `BrainSource.ts` (`moments`, `recordConsent`, `recording`), `BrainBridge.tsx` (consent card, ● REC, player, "Talk to JJ first →", "Upload slides (PDF)" on JJ's screen); `e2e/recording.mjs` (`pnpm e2e:recording`)
- **What:** with consent (asked on screen once per session, sessionStorage), the stage records camera + mic from the countdown to the run's end (MediaRecorder WebM, 4 s chunks) to `POST /api/media/:runId/chunk?seq=N&startedAt=ms` → `SESSION_DIR/<sessionId>/media/<runId>.media`; `GET /api/media/:runId/video` serves it with byte ranges (Chrome seeks in MediaRecorder WebM over ranges; no ffmpeg). `show_moments` turns a run's episodes of one behaviour (rule observations for speech, 8 s before each) into ≤ 5 clips (longest, in time order, ±1.5 s, long ones capped at 12 s) and sends `moments.show {title, kind, runId, clips[{url, fromS, toS, tRunMs, slideIndex, label}]}`; the stage plays them one after the other (muted by default) and closes. JJ's result: `{total, shown, moments[{at, slide, seconds}]}`. The full reset erases the recordings with the session folder.
- **Why:** "you did this five times, here they are" is checkable feedback; the setup screen had no way to talk to JJ before uploading, and JJ's screen had no way to upload.
- **Impact:** stage: `moments.show` (empty `clips` = hide). Operator panel: may call `show_moments`. Recorder lane: one recording per run, browser clock = brain clock (same machine).

### 2026-11-08T12:30+01:00 · brain · Episodes in the run log; the end-to-end practice flow (goals, end by voice, export, delete)
- **Where:** `apps/brain/src/runlog.ts` (`EpisodeRecord`, `hub.on("behavior")`, `behaviorCounts`, `episodeTime`, `RULE_OF_KIND`), `persist.ts` (`episodes` with default `[]`; `deleteSession`; reset `{keepData}`), `observedCoach.ts`, `digest.ts`, `progress.ts` (`compactProgress`), `export.ts` (new), `server.ts`, `session.ts`, `jj/{engine,messages,tools,ports}.ts`, `prompts/jj.md`; protocol `domain.ts` (`PresentationBrief.presenterGoals`), `tools.ts` (`save_brief.presenter_goals`), `reports.ts`; frontend `src/brain/{BrainReport,BrainProgress,BrainBridge}.tsx`; coach `api.py` (`DELETE /v1/sessions/{id}`), `brain_bridge.py` (purge on reset)
- **What:**
  - `behavior` start/end → `RunRecord.episodes` (paired per kind, sender's `clientTs` when plausible, slide at the start, closed at run end). Counts everywhere = max(episodes, rule observations) per kind. The observed coach picks targets from them and never counts a run without the camera coach as clean (was: a posture target "fixed" after one unmeasured run).
  - Digest rows get `time {totalMs, longestMs, pct}` and up to 3 exact moments (`examples[].durationMs`). Progress rows get `perMin` and `timePct`; the trend compares per minute.
  - `session_start` no longer needs a deck (JJ greets first); `start_run` does (`no_deck`). JJ gets `[DECK UPLOADED]`. Frontend: "Talk to JJ first →" in setup sends `session.start` (13:30).
  - JJ asks one optional question about the presenter's own goals (`presenter_goals`, their words; never exported, erased on reset; prompt rules in "Personal goals"); after run 1 links patterns to them and says plainly what is not measured. `show_final` ends the practice when the user says they are done and returns `progress` (first → last run per behaviour) for the final narration.
  - `GET /api/session/export.html[?download=1]`: a printable report (no personal goals). `POST /api/session/reset` (full) erases the previous session folder; the bridge then deletes that session's coach sessions. Progress tab: "Export report", "Delete and start over".
- **Why:** the practice loop the product needs: goals → runs → tracked targets → "you started here, now you're here" → a report for a manager → nothing left behind.
- **Impact:** operator panel: reset now erases data (pass `keepData: true` to keep it). Stage: `report.ready final` unchanged. Recorder lane: media recordings (next) must live under the session folder so the same reset erases them.

### 2026-11-08T11:40+01:00 · sensing · Posture rules merged with behaviour episodes (`behavior.episode`)
- **Where:** coach part of `e5d7bb9` (branch `worktree-agent-a042012a57c5cf65b`: `metrics/body.py` posture measures, `coaching.py` rules `body.arms_crossed` / `body.face_touch` / `body.looking_down`, `config.py`, `tuning.py`, `tuning.json`, `cli.py` `coach tune`, `scripts/coach-tune.sh`, tests) applied to the working tree; on top: `services/coach/coach/metrics/episodes.py` (new), `config.py` (`episodes` timing), `wire.py` (`BehaviorEpisodePayload`, server event `behavior.episode`), `session.py`, `brain_bridge.py`; `contracts/` regenerated
- **What:** the coach records every occurrence of `arms_crossed`, `face_touch`, `looking_down`, `sway` and `fast_hands` with a start and an end (several at once, not throttled like `coaching.feedback`; start back-dated to the onset, end = last sighting, open episodes close on pause/stop/tracking loss). Episodes use the rules' measures and thresholds (one set, tuned by `tuning.json`); only their timing is separate. The bridge forwards each episode as the brain's `behavior` uplink (`phase` start/end, `clientTs` = the episode's own time, epoch ms) instead of the rule-driven start/end with a hold timer, and sends `operator.override` `reward` (green) when an episode of one of the run's targets clears during a live run with feedback on. `body.hand_movement_high` → `fast_hands` in `RULE_KIND`.
- **Why:** reports and JJ need "when exactly did it happen" (00:24–00:31), later replay of the matching video/audio; the throttled rules lose repeats and start late; JJ promised green edges that nothing sent.
- **Impact:** brain: handle `behavior` (pair start/end per kind, close a dangling start at run end, use `clientTs`). Thresholds are untested heuristics, to tune with `coach tune` and recordings.

### 2026-11-08T11:00+01:00 · lead · `fast_hands` behaviour kind
- **Where:** `packages/protocol/src/domain.ts` (`BehaviorKind`, `FEEDBACK_ELIGIBLE`, `CATEGORY_OF`), `messages.ts` (`SENSOR_BEHAVIORS`), `tools.ts` (`highlight_pattern.kind` = `BehaviorKind.options` + `"none"`), `scripts/samples.ts`, `fixtures/messages/up.{behavior,coach.observation}.json`; `apps/brain/src/observedCoach.ts` (`BEHAVIOR_WORDS`), `apps/brain/src/digest.ts` (`RULE_LABELS`)
- **What:** new kind `fast_hands` (category `movement`), feedback-eligible (`set_targets`) and a sensor behaviour (`behavior` uplink from the sensor role). `highlight_pattern`'s enum now derives from `BehaviorKind`. Labels/strengths in the digest for the coach rules `body.arms_crossed`, `body.face_touch`, `body.looking_down`.
- **Why:** fast hands (`body.hand_movement_high`) had no kind, so the observed coach could never make it a training target.
- **Impact:** sensing: done, the bridge maps `body.hand_movement_high` → `fast_hands` in `RULE_KIND` (entry 11:40). Feedback controller lane: `behavior fast_hands` may arrive from the sensor role. UIs that label kinds must add `fast_hands` (none in `apps/frontend`).

### 2026-11-08T11:00+01:00 · lead · `jj.transcript` downlink (JJ's captions)
- **Where:** `packages/protocol/src/messages.ts` (`DOWNLINK["jj.transcript"]`), `scripts/samples.ts`, `fixtures/messages/down.jj.transcript.json`
- **What:** `jj.transcript {lineId, who: "user"|"jj", text (≤1000), final, utteranceId?}` to stage and operator: one caption line of what JJ or the user said to JJ, re-sent whole under the same lineId as it grows (throttled), `final` once complete. `utteranceId` ties a JJ line to its `actor.say`.
- **Why:** JJ's transcripts were only logged and `actor.say {actorId:"jj"}` carries `text: ""`; the stage had no way to show what JJ says.
- **Impact:** stage: captions on JJ's screen. Operator panel can show the same lines.

### 2026-11-08T11:00+01:00 · agents · Transcript relay in the JJ engine
- **Where:** `apps/brain/src/jj/transcript.ts` (`TranscriptRelay`), `jj/engine.ts`, `jj/ports.ts` (`JJDownlink` + `jj.transcript`)
- **What:** the agent's transcript chunks are joined per speaker into caption lines: partial updates at most every 250 ms, final on the provider's flag, after 1.5 s without text, on barge-in / run start / reset, or when a line passes 140 chars (split at a sentence end). New lines only while JJ may talk (outside runs, or woken; JJ's still-playing utterance may finish).
- **Why:** Gemini Live sends many small transcript chunks and rarely marks them finished.
- **Impact:** another `VoiceAgent` must emit transcript chunks (deltas) through `onTranscript`. Not verified against real Gemini yet (no key): the 1.5 s line end and the stage's 16 chars/s caption pace are guesses to tune live.

### 2026-11-08T11:00+01:00 · brain · Director sends `actor.lookAt`
- **Where:** `apps/brain/src/director/director.ts` (`DirectorHub.send` accepts `actor.lookAt`; option `thinkMs`, default 700 ms)
- **What:** at Q&A start everyone looks at the presenter; the next asker looks at its notes for `thinkMs`, then at the presenter while the others look at the asker; during the answer everyone watches the presenter; same for the closing line; all look at their notes while JJ is woken. Sent only when a judge's target changes.
- **Why:** the protocol had `actor.lookAt` but nobody sent it; the panel stared at the camera.
- **Impact:** none (stage plays it; `thinkMs` adds 0.7 s before each question).

### 2026-11-08T11:00+01:00 · stage · Gaze, the brain's panel in the room, JJ captions
- **Where:** `apps/frontend/src/brain/{scene.ts, captions.ts, JJCaptions.tsx, judges.ts, BrainSource.ts, BrainBridge.tsx}`; `src/judges/{Judge.tsx, JudgesScene.tsx, types.ts, index.ts}`; tagged edits in `src/signals/bus.ts` (+`judgePanel`), `src/signals/judges.ts` (+`look`, `JudgeSeat`), `src/components/JudgesStage.tsx`, `src/routes/index.tsx`; `e2e/frontend-brain.mjs` (44 checks)
- **What:** BrainSource keeps a copy of the scene, applies `scene.apply` before acking (`ok: false` before any `scene.sync`) and publishes `judgePanel`; the room seats exactly those judges (`judge_seat_K` → seat K-1; other seats such as `judge_seat_5` are not shown) with a nameplate per judge, and `judge_N` is addressed by its seat. `actor.lookAt` → `judgeCommand look`. Judges get a per-judge gaze target (presenter / notes / audience / another judge) with a smooth head + chest turn, look at whoever talks, glance at notes or a neighbour and drift slowly (also in mock mode). `jj.transcript` → rolling caption on JJ's screen (JJ's words at speaking pace, older lines dim and fade), compact under "JJ is listening" while woken mid-run.
- **Why:** judges always stared into the camera, the room ignored the brain's panel (JJ can change it), JJ's screen had no transcript.
- **Impact:** judges lane: `JudgesHandle.lookAt` (new), `judges` prop is `(JudgeConfig | null)[]` per seat, `JudgeConfig.title`, `seatedJudges()`. Lovable: keep the tagged edits (`JudgesStage` passes `seatedJudges(panel)` and plays `look`; `index.tsx` wraps the greeting in `<JJCaptions>`).

### 2026-11-08T10:45+01:00 · lead · `SessionProgress` (progress across runs)
- **Where:** `packages/protocol/src/reports.ts` (`ProgressRun`, `ProgressRow`, `SessionProgress`)
- **What:** per finished run: mode, level, targets, durations, behaviour observations, vignettes, the coach score after it, whether the camera coach was connected; per coach rule (and per target never seen): its count in each run (null without the coach), target / fixed, trend first → last measured run; the coach stage and recommendation; a one-line `headline` ("Moving around / swaying 3 → 0 · …").
- **Why:** "you got better" is the demo's strongest story; the spec's `FinalReport` needs word and gaze streams that don't exist yet.
- **Impact:** reports lane: `FinalReport` can be built later next to it.

### 2026-11-08T10:45+01:00 · brain · Session saved to disk, restored on start; reset route; progress route; `report.ready final`
- **Where:** `apps/brain/src/{persist.ts, progress.ts}` (new), `session.ts` (`SessionStoreOptions.restore`, `reset {full?}`), `runlog.ts` (`restore`, `onChanged`, `coachAfter`, cleared on reset), `brain.ts` (`BrainOptions.restore`), `server.ts`, `config.ts` (`BRAIN_FRESH`), `context/uploads.ts` (slides of decks from earlier processes / sessions found on disk)
- **What:**
  - `SESSION_DIR/<sessionId>/session.json` (SessionState + RunLog records) and `SESSION_DIR/latest.json`, written atomically ≤ 500 ms after any change and on shutdown. On start the brain continues the latest session (JJ reconnects as after a restart; already-debriefed runs are not debriefed again). A run under way when the brain stopped is aborted (kept in the log, `endedBy: aborted`); the session continues in the debrief (or the intro without a finished run). `--fresh` / `BRAIN_FRESH=1` starts a new session; an unreadable file is logged and ignored.
  - `GET /api/session` `{sessionId, phase, runs, savedAt}`; `POST /api/session/reset {full?: boolean = true}`: `full` = a brand-new session (no deck, intro again, the default panel), `full: false` = the existing `reset` (keeps deck, scene, intro done).
  - `reset` now clears the RunLog (a new session's runs start again at `run_1`, which used to collide with the old records).
  - `GET /api/progress` → `SessionProgress`. JJ's `compactRunReport` adds `progress` (the headline). `show_final` sends `report.ready {kind: "final", sessionId}` to the stage.
  - `RunRecord.coachAfter {score, stage}`: the coach right after the run.
  - `pnpm start:brain`: the brain without watch mode.
- **Why:** everything lived in memory, so a brain restart (or a code change under `tsx watch`) lost every run and report.
- **Impact:** operator panel: the reset button can call `POST /api/session/reset` (closes the "reset" spec gap below without a protocol change). Since 12:30 a full reset erases the previous session from disk (`keepData: true` keeps it). Recorder lane: `session.json` is a snapshot, not the JSONL event log.

### 2026-11-08T10:45+01:00 · stage · Progress tab on the report screen
- **Where:** `apps/frontend/src/brain/{BrainProgress.tsx (new), BrainReport.tsx}`
- **What:** the report screen has tabs "Run N" and "Progress · N runs" (`GET /api/progress`): one column per run, one row per behaviour with its count per run (bars), trend, target / fixed badges, the coach score per run, the headline. After two runs the run tab shows the headline with a link to the progress tab; the brain's final view opens on it.
- **Why:** the brain had a final view that nothing showed.
- **Impact:** Lovable: `report.tsx` keeps rendering `BrainReport` in brain mode.

### 2026-11-08T10:45+01:00 · lead · One command for the demo (`scripts/demo.sh`, `pnpm demo`)
- **Where:** `scripts/demo.sh`, root `package.json` (`demo`, `start:brain`), `.env.example` (`DEMO_CAMERA`, `BRAIN_FRESH`)
- **What:** starts brain (no watch), frontend, coach, bridge and camera in one terminal with prefixed output and logs in `data/demo-logs/<time>/`; waits for each health check; warms Vite's routes; restarts crashed services (the brain continues the saved session); refuses ports already in use (`--takeover` stops the old processes); Ctrl+C stops everything after the brain saves. Options `--camera N | --no-camera`, `--fresh`, `--force`, `--no-coach`, `--no-open`, `--dev`; ports `BRAIN_PORT`, `FRONTEND_PORT`, `COACH_PORT`.
- **Why:** 4–5 terminals on stage was a risk.
- **Impact:** none.

### 2026-11-08T03:15+01:00 · lead · `coach.observation` uplink and `RunDigest`
- **Where:** `packages/protocol/src/messages.ts` (`UPLINK["coach.observation"]`, sender `sensor`), `scripts/samples.ts`, `fixtures/messages/up.coach.observation.json`; `packages/protocol/src/reports.ts` (`RunDigest`, `RunDigestObservation`)
- **What:** `coach.observation {rule, kind: BehaviorKind|null, category: FeedbackCategory|null, text, clientTs}` carries every coaching observation of the coach backend (not only the 4 sensor behaviours). `RunDigest` is the report the brain can build today (observations, slides, feedback, wakes, Q&A, strengths, next run) without STT or gaze.
- **Why:** reports and the coach policy need what the camera/speech coach saw; the full `RunReport` needs word and gaze streams that don't exist yet.
- **Impact:** reports lane: `RunReport` can be built later next to `RunDigest`.

### 2026-11-08T03:15+01:00 · brain · RunLog, run digest, `report.ready`, observed coach, Director, auto fake JJ
- **Where:** `apps/brain/src/{runlog.ts, digest.ts, observedCoach.ts}`, `apps/brain/src/director/{director.ts, questions.ts}`, `server.ts` (wiring), `config.ts`, `brain.ts` (`defaultScene`)
- **What:**
  - `RunLog` records per run: slides, `coach.observation`s, `feedback.set` warnings, wakes, Q&A turns. `GET /api/runs` and `GET /api/runs/:runId/report` (RunDigest); `report.ready {kind: "run"}` to the stage when a run ends; `ReportsPort.compactRunReport` returns the digest (JJ's debrief).
  - `observedCoach` (CoachPolicy): after the baseline the two most frequent observed behaviours become targets and the next run is training/strong; clean training runs fix targets and move training → fading → test. JJ's set_targets / set_level still override.
  - `Director`: in the Q&A the judges ask `scene.qa.questions` (now 3) questions built from the deck's slide text and each judge's style (no LLM; `planQuestions`), through `JudgeVoices`; it listens on the mic (speech, then 1.8 s silence; 12 s without speech; answer cap), holds while JJ is woken, closes, and dispatches `qa_done`. Ending the run cancels it.
  - Default panel: Customer advocate, Startup mentor, VC investor, Technical expert.
  - No `GEMINI_API_KEY` → fake JJ automatically (`jj.fake_no_key` warning) instead of refusing to start.
- **Why:** judges never asked anything, the report screen was empty, and without JJ the coach never left the baseline.
- **Impact:** agents lane: an LLM question source can replace `planQuestions` (same `PlannedQuestion[]`). Rules lane: `observedCoach` is the stand-in for `packages/rules` coach. Reports lane: build `RunReport` beside the digest.

### 2026-11-08T03:15+01:00 · stage · Report screen and "Hey JJ" by voice
- **Where:** `apps/frontend/src/brain/{BrainReport.tsx, wake.ts}`, `BrainSource.ts`; tagged edit in `src/routes/report.tsx` (brain mode renders `BrainReport`)
- **What:** the report screen fetches the run's digest on `report.ready` (or the last run after a reload): what the coach noticed (with time and slide), time per slide, the judges' questions and answer lengths, strengths, next run. `WakeListener` (browser speech recognition, no key) hears "Hey JJ" during a run and sends the same `ptt` as holding J.
- **Why:** the report was a placeholder; the wake phrase needs STT the brain doesn't have yet.
- **Impact:** Lovable: keep the `isBrainMode()` branch in `report.tsx`. Sensing lane: drop `wake.ts` once the brain's WakeDetector runs on Deepgram.

### 2026-11-08T03:15+01:00 · sensing · Bridge sends every observation; vignette only for the run's targets
- **Where:** `services/coach/coach/brain_bridge.py` (`observation`, `RULE_KIND`, `vignette_for`)
- **What:** each `coaching.feedback` during a live run → `coach.observation` (speech.rate_high → pace_fast, speech.fillers → filler_burst, speech.long_pauses → long_pause, body.torso_movement_high → sway; fast hands and heart rate have no kind). When the run has targets, the vignette fires only for them; without targets, for the enabled categories.
- **Why:** the brain's report and coach need all observations; the spec gives feedback on targets only.
- **Impact:** none.

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
