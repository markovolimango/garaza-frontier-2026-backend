# Verifying JJ with real keys

The JJ engine is unit-tested against fakes (`pnpm test`). This is the checklist for the
first run against real Gemini Live. It needs no hub, session store or Deepgram: the
playground and the smoke test run the **real** `JJEngine` + `GeminiLiveAgent` over a
simulated session (`apps/brain/src/jj/playground/sim.ts`).

## 0. Setup (2 min)

```bash
cp .env.example .env          # set GEMINI_API_KEY, optionally JJ_VOICE (e.g. Puck)
corepack pnpm install
corepack pnpm test            # 56 tests, must be green
```

`GEMINI_LIVE_MODEL` defaults to `gemini-3.8-live` (from the spec). If connect fails with a
model error, set it to whatever Live model the key has access to.

## 1. Smoke test (headless, ~3 min)

```bash
corepack pnpm jj:smoke
```

It drives the loop with **scripted text turns** in place of speech, then prints one line per step:

| Step | What passes |
| --- | --- |
| connect | Live session up within 20 s |
| greeting audio | JJ speaks after `[SESSION START]` |
| save_brief / panel generated | JJ extracts the brief from the user's summary and calls `save_brief`; 3 judges committed |
| start_run | JJ starts the run when told "I'm ready"; first run is the baseline |
| silent during run | no JJ audio reaches the stage while not woken |
| wake: panel change / resumed | after a PTT wake, "make the judges tougher" → `set_judges`/`set_judge`, then `resume_run` or auto-resume |
| [RUN ENDED] sent / debrief audio | the report goes in, JJ debriefs |
| highlight_pattern | (WARN only) JJ lights up cards while talking |
| set_targets | "work on the arms crossing" → `set_targets(["arms_crossed"])` |

Outputs in `data/jj-smoke/<timestamp>/`: `transcript.txt`, `jj.wav` (listen to it),
`events.jsonl` (every tool call, note and downlink), `results.json`. Exit code 1 on any FAIL.

## 2. Playground: full duplex by voice (~15 min)

```bash
corepack pnpm jj:playground          # http://localhost:8790 (Chrome, headphones)
corepack pnpm jj:playground --fake   # no key needed: checks the page and wiring only
```

Press **Enable audio**, then **Start session**. The right side is the live event log: your
and JJ's transcripts, every tool call (caller → name, args, ✓/✗ result, latency), every note
sent to JJ (`[SESSION START]`, `[WOKEN …]`, `[RUN ENDED] …`, `[UI ACTION] …`) and every
downlink (`jj.state`, `actor.say`, `audio.stop`, `report.focus`, toasts). Everything is also
appended to `data/jj-playground/<timestamp>.jsonl`.

Controls: run buttons (start, slides ◀ ▶ / arrow keys, slides done → Q&A, Q&A done → report,
end, abort, run it back, final), **Hey JJ** = push-to-talk (button or hold **J**), operator
wake, resume, reconnect JJ, a tool form built from `/api/tools`, and a box for raw text notes.
Tick **"Hey JJ" detector** to use Chrome speech recognition as a stand-in for Deepgram wake
detection.

### Checklist

Full duplex
- [ ] Talk over JJ mid-sentence: its audio stops within ~200 ms, log shows `audio.stop`, JJ responds to what you said.
- [ ] JJ doesn't hear itself (headphones). With speakers, note whether it self-interrupts.
- [ ] Pills: *listening* on outside runs, off during an un-woken run; *speaking* follows JJ.

Intro (spec step 1)
- [ ] Greeting is one sentence; loop explained in ≤ 4 sentences; asks for a 30–60 s summary.
- [ ] After your summary: `save_brief` with sensible fields; JJ keeps talking while it runs (non-blocking), then names the panel.
- [ ] "Make the second judge a skeptical CFO" → `set_judge` ✓ and the panel updates in *State*.
- [ ] "Ready" → `start_run` with **no** args (baseline).

During the run
- [ ] JJ is silent; *frames→JJ* stops increasing.
- [ ] Hold **J** (or say "Hey JJ" with the detector on), ask "make them tougher": note `[WOKEN DURING RUN: presentation, slide N]`, `set_judges` ✓, then `resume_run` or auto-resume ~2.5 s after JJ finishes.
- [ ] "Hey JJ, go back to slide 2" → `go_to_slide {index: 1}`.
- [ ] "Hey JJ, stop the run" → `end_run`, not `resume_run`.

Debrief (spec step 4)
- [ ] After **Q&A done**: `[RUN ENDED] {…}` in the log, JJ names one strength, then patterns with their moments, calling `highlight_pattern` per pattern (log shows `report.focus`).
- [ ] Asks which 1–2 to work on → `set_targets`. Explains red edges / green.
- [ ] Second run: JJ follows the recommendation (`start_run` with no args), reads out `recommendation.reason`.
- [ ] Never says the score; never uses the banned words (see `apps/brain/prompts/jj.md`).

Robustness
- [ ] **Reconnect JJ** mid-conversation: `jj.state connected:false` then true; JJ carries on without re-greeting.
- [ ] Leave it running 20 min (spec soak): no restart needed; Live `goAway` (log `jj.go_away`) hands over to a resumed session without cutting JJ off.
- [ ] Invoke a tool from the form while JJ is idle: log shows `[UI ACTION]`, and JJ takes it into account if asked.
- [ ] Invalid args from the form (e.g. `{"questions": 9}` on `set_qa`) → ✗ `invalid_args`.

## What's simulated (not under test here)

Session transitions, scene acks (80 ms), personas (canned titles, ~1.2 s delay), run
reports (canned patterns), mic routing and the 3 s ring buffer. The real ones come from the
brain, context and reports lanes; JJ talks to them only through `apps/brain/src/jj/ports.ts`.

## If something fails

- **connect fails / setup timeout**: wrong model name, or the key has no Live access. Check the `jj.connect_failed` / `jj.socket_error` log lines.
- **Config rejected**: verify field names against the installed `@google/genai` (pinned 3.0.0) in `GeminiLiveAgent.buildConfig()`.
- **JJ answers but never calls tools**: check the tool declarations in the first `connect` (`tools.declarations()`), and that tool responses go out (`jj.tool_result_dropped` in the log means it was disconnected).
- **Auto-resume too early or late**: tune `JJ_SPEECH_RMS` (mic level that counts as speech) and watch the *mic → brain* meter.
