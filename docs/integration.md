# Integration guide

How the components of the AI Presentation Coach fit together, and where each lane plugs
in. The spec (`AI Presentation Coach — Component & Interface Spec.md`) is the source of
truth for behaviour; this guide is the source of truth for **wiring**: which interface a
component implements, who calls it, and where it is connected.

> **Every extension — a new or changed interface, message, field, option, config key or
> behaviour that the spec does not define — must be recorded in
> [`docs/extensions.md`](extensions.md) with a timestamp, so that different agents can
> sync up when merging.**

## 1. Repo layout

```text
packages/protocol/        lead      the contract: zod schemas, types, message catalogue, fixtures generator
  src/domain.ts                     ids, behaviours, loop, scene, run, coach, session, observations, UI
  src/messages.ts                   envelope, DOWNLINK / UPLINK payload tables, UPLINK_SENDERS, parsers
  src/tools.ts                      ToolName, ToolArgs (flat), ToolCatalogue
  src/venue.ts                      VenueDef, anchors, GREYBOX_VENUE
  src/reports.ts                    StoredEvent, Metrics, RunSummary, RunReport, FinalReport
  src/audio.ts                      /ws/audio framing, sample rates, sources
  scripts/samples.ts                typed valid/invalid samples → fixtures/messages (pnpm gen:fixtures)
apps/brain/src/
  server.ts                         entry point (env, config, listen)
  brain.ts                          createBrain(): composition root — THE place lanes plug in
  config.ts                         BrainConfig (zod) + JJ config
  clock.ts log.ts                   Clock (Real/Virtual), Logger
  hub.ts                            WsHub: /ws/control, /ws/mic, /ws/audio
  session.ts commands.ts views.ts   SessionStore, SceneCommander, viewFor
  sync.ts                           StateSync: session → downlinks, initial state per role
  mic.ts speech.ts                  MicRouter; SttStream / WakeDetector interfaces (sensing lane)
  placeholders.ts                   stand-ins for not-yet-merged lanes
  jj/                               the JJ voice coach (agents lane)
    engine.ts gemini-live.ts …      see jj/VERIFY.md for live verification
    tools.ts                        ToolRegistry + the 20 coach tools
    playground/                     browser playground + headless smoke test
apps/brain/prompts/jj.md            JJ system prompt (lint:vocab)
apps/web/src/net/client.ts          ControlClient: shared /ws/control client for every page
apps/frontend/                      Lovable app (git subtree of the frontend repo) — see §14
  src/brain/                        brain integration layer (ours): BrainSource, BrainBridge, audio, deck upload
apps/brain/src/context/uploads.ts   deck/docs upload endpoints, slide images
e2e/frontend-brain.mjs              headless-Chrome e2e: frontend ⇄ real brain
fixtures/decks/                     sample decks for tests
fixtures/messages/                  one valid + one invalid sample per message type
docs/                               this guide, extensions.md
```

Not built yet: `packages/rules`, the sensor and operator pages, `apps/brain/src/{events,reports,recorder,replay}.ts`, `apps/brain/src/{context,director,llm,tts,stt}/`.

## 2. Runtime picture

```text
 ┌──────────── browser (one origin via Vite :5173) ────────────┐
 │  /  main app (stage)   /sensor (sensor)   /operator          │
 │   │ControlClient        │ControlClient      │ControlClient   │
 │   │+ mic (/ws/mic)      │                   │                │
 │   │+ audio (/ws/audio)  │                   │                │
 └───┼─────────────────────┼───────────────────┼────────────────┘
     ▼                     ▼                   ▼
 ┌──────────────────────── brain :8787 ─────────────────────────┐
 │ WsHub ──uplinks──▶ brain.ts handlers ──▶ SessionStore.dispatch│
 │   ▲                     │                     │ subscribe()   │
 │   │ downlinks           ▼                     ▼               │
 │ StateSync ◀──────── ToolRegistry ◀── JJEngine ◀── MicRouter ◀─┤ /ws/mic
 │   ▲                 (jj, stage, operator)   │                 │
 │   └─ SceneCommander (scene.apply ⇄ ack)     └─▶ Gemini Live   │
 └───────────────────────────────────────────────────────────────┘
```

Rules that hold everywhere:

- **Only the brain talks to cloud APIs.** Pages talk only to the brain.
- **All state changes go through `SessionStore.dispatch`** (synchronous, validated). Components
  never mutate `SessionState`; they *subscribe* and react.
- **Scene changes go through `SessionStore.applyScene`**, which commits only after the
  main app's `ack`.
- **Every inbound message is validated** by the hub (schema + allowed sender role); handlers
  only ever see valid, re-stamped messages.
- **Time comes from the injected `Clock`.** Never call `Date.now()` or `setTimeout` directly
  in brain modules; tests and replay use `VirtualClock`.

## 3. The contract: `packages/protocol`

Everything that crosses a process boundary is a zod schema here; types are `z.infer<>`.

| Need | Use |
| --- | --- |
| Validate an inbound control frame | `parseUplink(raw)` → `{ok, msg}` or `{ok:false, code, message, refId}` |
| Validate a downlink (web, dev mode) | `parseDownlink(raw)` (ControlClient does this) |
| Send from brain code | `hub.send(role, { type, payload, replyTo? })` typed as `DownlinkMessage` |
| Handle an uplink | `hub.on("tool.invoke", (msg: Uplink<"tool.invoke">, role) => …)` |
| Who may send what | `UPLINK_SENDERS` |
| Audio frames | `encodeAudioFrame` / `decodeAudioFrame`, `AUDIO_SOURCE`, `AUDIO_FLAG` |

**Changing the protocol** (lead only, spec rule): edit the schema, add or adjust samples
in `packages/protocol/scripts/samples.ts` (typed, so stale samples fail `pnpm typecheck`),
run `pnpm gen:fixtures`, make `pnpm test` green, and add an entry to `docs/extensions.md`.
Adding a message type means adding it to `DOWNLINK` or `UPLINK`, and for uplinks to
`UPLINK_SENDERS`; the protocol tests fail until it has fixtures.

## 4. Composition root: `createBrain()` (`apps/brain/src/brain.ts`)

`createBrain(options)` builds the hub, session, sync, tools, JJ and mic router, wires every
uplink, and serves HTTP. **A lane integrates by passing its implementation as an option**;
each option has a placeholder default so the brain always runs end to end.

| Option | Interface (file) | Owner lane | Default today | What it does |
| --- | --- | --- | --- | --- |
| `coach` | `CoachPolicy` (`session.ts`) | sensing / rules | `placeholderCoach` (follows the stage table, never judges "clean") | initial state, recommendation, `afterRun`, target and level overrides |
| `context` | `ContextPort` (`jj/ports.ts`) | agents | `placeholderContext()` (generic personas) | `setBrief`, `generatePersonas` |
| `reports` | `ReportsPort` (`jj/ports.ts`) | report | `placeholderReports` (no patterns) | compact `RunReport` for JJ's debrief |
| `stt` | `() => SttStream \| null` (`speech.ts`) | sensing | none (mic goes nowhere during runs) | current run's STT stream; MicRouter writes to it |
| `agent` | `VoiceAgent` (`jj/voice-agent.ts`) | agents | `GeminiLiveAgent` (`FakeVoiceAgent` with `JJ_FAKE=1`) | JJ's voice session |
| `http` | `(req, res, brain) => boolean` | context, report | 501 for `/api/*` | uploads, decks, reports, final report |
| `venue`, `initialScene`, `clock`, `log` | — | brain | greybox, default panel, RealClock | — |

The returned `Brain` exposes `hub`, `session`, `sync`, `tools`, `jj`, `mic`, so a lane's own
wiring (subscriptions, extra handlers) can be added next to `createBrain()` in `server.ts`
without editing other lanes' files.

## 5. Session store (`session.ts`)

```ts
session.dispatch(action): Result                 // sync; any action not valid for the phase → wrong_phase
session.applyScene(ops): Promise<Result<{version}>>
session.subscribe((state, cause) => …)            // cause: SessionAction | SessionEvent | SceneOp[]
session.setContext(patch)                         // ContextService only: deck, docs, brief, digest
session.get()                                     // read-only snapshot; never mutate it
```

`SessionEvent` causes are emitted by the store itself: `{type:"countdown", secondsLeft}`,
`{type:"presentation_started"}`, `{type:"context", patch}`. A **scene commit** is delivered
with the committed `SceneOp[]` as the cause.

**How to react to the loop.** Subscribe and switch on the cause and the new state, for example:

```ts
brain.session.subscribe((s, cause) => {
  if (Array.isArray(cause)) return;                                  // scene commit
  if (cause.type === "presentation_started") feedback.start(s.run!); // feedback controller
  if (cause.type === "presentation_done" && s.run?.phase === "qa") director.startQa(s.run, s.scene, s.context);
  if (cause.type === "wake") director.pause();
  if (cause.type === "resume") director.resume();
});
```

The full transition table and its tests are in `apps/brain/test/session.test.ts`. Run-end
work that must happen **before** the debrief starts (summary, report, coach update) goes in
`CoachPolicy.afterRun`, which the store calls synchronously while the run ends.

## 6. Scene commands (`commands.ts`)

`applyScene` validates (zod + seats in the venue, 1–5 judges, unique ids and seats), sends
`scene.apply`, waits up to 2000 ms for `ack`, then commits or rolls back with `scene.sync`.
One batch is in flight at a time. **The main app must ack every `scene.apply`**, after
applying it in one frame:

```ts
client.on("scene.apply", (p) => { room.apply(p.ops); client.send("ack", { batchId: p.batchId, version: p.version, ok: true }); });
```

The command log (`session.commands.log`) records every batch with its status.

## 7. Hub (`hub.ts`) and the web client (`apps/web/src/net/client.ts`)

Brain side:

```ts
hub.on(type, handler)          // validated uplinks
hub.send(role, msg) / hub.broadcast(roles, msg) / hub.sendAudio(source, flags, seq, pcm24k)
hub.onConnect(role, fn)        // send that role's initial state (StateSync does stage/operator/sensor)
hub.onDisconnect(fn) / hub.onMic(fn) / hub.connections() / hub.micConnected()
hub.onInbound(fn) / hub.onOutbound(fn)   // taps for the recorder
```

Page side (every page uses the same client):

```ts
import { ControlClient } from "@coach/web/net";
const client = new ControlClient({ role: "stage" }).connect();      // url derived from location
client.on("ui.state", (p) => app.setUi(p));
client.send("slide.changed", { index, clientTs: Date.now() });
const reply = await client.request("tool.invoke", { tool: "set_targets", args: { behaviors: ["sway"] } });
client.onStatus((s) => hud.connection(s));   // "replaced" = another tab took the role; no reconnect
```

Reconnects repeat the handshake, and `StateSync` re-sends full state, so pages keep no
authoritative state. Replies (`tool.result`, `error`) carry `replyTo` = the request id.

## 8. Mic and speech (`mic.ts`, `speech.ts`)

`MicRouter.write(pcm16k)` receives every 20 ms frame from `/ws/mic` and routes it per the
spec table (`sinksFor(state)`): to `stt` during the presentation and Q&A, to JJ outside
runs and while woken. It keeps a 3 s ring buffer (`replaySince`) for the wake pre-roll.

The **sensing lane** plugs in by implementing `SttStream` and `WakeDetector` and wiring:

```ts
let stt: SttStream | null = null;
const brain = createBrain({ ..., stt: () => stt });
brain.session.subscribe((s, cause) => {
  if (!Array.isArray(cause) && cause.type === "start_run") { stt = new DeepgramStt(cfg); void stt.open(clock.now()); }
  if (s.phase !== "running" && stt) { void stt.close(); stt = null; }
});
wake.onWake((phraseStart) => { brain.jj.noteWakePhrase(phraseStart); brain.session.dispatch({ type: "wake", via: "phrase" }); });
```

Word tokens and behaviour events go to the event store (not built yet; see §11).

## 9. Tools (`jj/tools.ts`)

One `ToolRegistry` serves JJ (voice), the main app (card clicks) and the operator panel
(`tool.invoke`), so every voice command also has a button. Arguments are validated with
the tool's `ToolArgs` schema before the handler runs.

**Adding a tool:** add the name to `ToolName` and a flat args schema to `ToolArgs`
(protocol, lead), register a handler in `createCoachTools()` (`BLOCKING` unless JJ should
keep talking while it runs), mention it in `apps/brain/prompts/jj.md`, add a test in
`apps/brain/test/jj/tools.test.ts`, and record it in `docs/extensions.md`. The operator
panel picks it up automatically from `GET /api/tools`.

## 10. JJ (`jj/`)

JJ depends only on the narrow ports in `jj/ports.ts` (`SessionPort`, `HubPort`, `MicPort`,
`ContextPort`, `ReportsPort`), so the real brain modules satisfy them structurally.
`createBrain()` wires it. Live verification: [`apps/brain/src/jj/VERIFY.md`](../apps/brain/src/jj/VERIFY.md).

## 11. Components still to integrate

| Component | Implements / produces | Integration point |
| --- | --- | --- |
| Feedback controller (`packages/rules/src/feedback.ts`) | `FeedbackCommand` every 100 ms | subscribe for run phases; call `brain.sync.setFeedback(cmd)` (sent only on change; held at none while woken) |
| Event store (`events.ts`) | `StoredEvent` log per run | `hub.on("behavior" \| "gaze.sample")`, STT `onWords`, session subscribe (slides, wake, phases) |
| Coach policy + `summarizeRun` (`packages/rules`) | `CoachPolicy` | `createBrain({ coach })` |
| Reports (`reports.ts`, `buildRunReport`) | `RunReport`, `FinalReport` | `createBrain({ reports, http })`; after a run send `report.ready` from a session subscriber |
| Context service (`context/`) | uploads, digest, personas | `createBrain({ context, http })`; deck/digest via `session.setContext` |
| Director + judges (`director/`) | Q&A turns, judge audio | subscribe (qa phase, wake/resume); `hub.sendAudio(judgeSource(n), …)`, `actor.*` downlinks; `session.dispatch({type:"qa_done"})` when finished; `hub.on("audio.playback")` |
| Recorder / replay | JSONL session log | `hub.onInbound`, `hub.onOutbound`, plus `ext` lines from STT / JJ / director |
| Main app, sensor, operator pages | views, MediaPipe, forms | `ControlClient`; the stage acks `scene.apply` (§6) |

## 12. Extending without breaking each other

1. **Prefer an extension point over an edit.** Pass an implementation to `createBrain()`,
   subscribe to the session, or add a hub handler next to the composition root.
2. **Stay in your lane's folder** (spec: Ownership). If you need another lane's interface to
   change, propose it rather than editing it.
3. **Protocol changes go through the lead**, with fixtures and tests.
4. **Record every extension in [`docs/extensions.md`](extensions.md) with a timestamp** (ISO
   8601 with offset, e.g. `2026-11-07T21:53+01:00`), newest first, so agents working in
   parallel can see what changed since they branched and sync up when merging.
5. Merge only with `pnpm test` and `pnpm typecheck` green.

## 13. Commands

| Command | Does |
| --- | --- |
| `pnpm test` | Vitest across packages |
| `pnpm typecheck` | `tsc -b` across protocol, web, brain |
| `pnpm gen:fixtures` | regenerate `fixtures/messages/*.json` from typed samples |
| `pnpm dev:brain` | brain with tsx watch on :8787 (`JJ_FAKE=1` to run without Gemini) |
| `pnpm --filter @coach/brain jj:playground [--fake]` | JJ playground on :8790 |
| `pnpm --filter @coach/brain jj:smoke` | headless live JJ test |
| `pnpm dev:frontend` | Lovable app on :5174 wired to the brain (`VITE_SIGNAL_SOURCE=brain`) |
| `pnpm test:frontend` | frontend unit tests + BrainSource integration tests against a real brain |
| `pnpm e2e:browser` | headless-Chrome e2e (needs a fresh `pnpm dev:brain` with `JJ_FAKE=1` and `pnpm dev:frontend`); screenshots in `data/e2e/` |
| `pnpm frontend:pull` | pull new Lovable commits into `apps/frontend` (git subtree) |

## 14. The Lovable frontend (`apps/frontend`)

The main app is built in Lovable by a teammate, in its own repo
(<https://github.com/markovolimango/garaza-frontier-2026-frontend>), because Lovable syncs
poorly with a monorepo. This repo carries it as a **git subtree** at `apps/frontend`.

**Updating from Lovable:**

```bash
git remote add frontend https://github.com/markovolimango/garaza-frontier-2026-frontend.git   # once
pnpm frontend:pull        # = git subtree pull --prefix=apps/frontend frontend main --squash
pnpm test:frontend && pnpm e2e:browser
```

Never push our changes back to the frontend repo's `main` (it syncs straight into Lovable).

**How it connects.** Lovable built the app around a typed bus (`src/signals/bus.ts`) with
swappable sources (`src/signals/index.ts`). Our integration is a real source plus a bridge,
all in **`src/brain/` (new files only, never touched by Lovable)**:

| File | Does |
| --- | --- |
| `BrainSource.ts` | `SignalSource` over `/ws/control` (role `stage`), `/ws/audio`, `/ws/mic`; maps downlinks onto the bus; acks `scene.apply` |
| `BrainBridge.tsx` | brain-driven navigation, Next buttons → loop actions, hold `J` = push-to-talk, audio unlock, overlay (countdown, toasts, status) |
| `mapping.ts` | pure protocol ⇄ bus/screen mapping (unit tested) |
| `audio.ts` | JJ playback (24 kHz, flush on `audio.stop`, `audio.playback` reports) and mic capture (16 kHz worklet) |
| `deck.ts` | PDF → 1920 px PNGs + text (pdf.js) → `POST /api/uploads/deck` |
| `brain-integration.itest.ts` | BrainSource against a real brain (`vitest.brain.config.ts`) |

| Brain | Bus / screen |
| --- | --- |
| `feedback.set` warn / reward / none | `feedback` red / green / neutral (Vignette) |
| `ui.state.orb.score` | `jjMood` (0 red … 1 green) |
| JJ audio level (speaking) / mic level (listening) | `orbLevel` |
| `ui.state.view` setup, jj, slides, room, report, final | `/presenter`, `/`, `/presenter`, `/judges`, `/report`, `/report` |
| `slide.show` | `slideCommand` → presenter jumps |
| presenter `slide` (during the presentation) | `slide.changed` |
| PDF loaded in the presenter (`deckFile`) | deck upload, then `session.start` |
| Next / keys 1–4: JJ→Presenter, Presenter→Judges, Judges→Report | `start_run`, `presentation.done`, `end_run`; other moves snap back with a hint |

**Edits inside Lovable's files** are kept tiny and tagged `brain integration`, so a subtree
pull conflicts rarely and obviously: `package.json` (`@coach/protocol`, `@coach/web`,
`zod` 4.6.6), `src/signals/bus.ts` (+`slideCommand`, `deckFile`), `src/signals/index.ts`
(source switch on `VITE_SIGNAL_SOURCE`), `src/routes/__root.tsx` (mount `<BrainBridge/>`),
`src/routes/presenter.tsx` (publish `deckFile`, follow `slideCommand`, re-open the deck on
mount). The mock stays the default, so the Lovable preview keeps working.

**Rules for the Lovable side** (pass these to Lovable when prompting):

- Keep `zod` at 4.x. With zod 3 in the frontend, the SSR bundle resolves `@coach/protocol` to
  zod 3 and every server render crashes.
- Components read live data only from the bus; add new data as bus channels.
- The judges and report screens are still placeholders: when built, the room must apply
  `scene.apply` ops in one frame before acking (today BrainSource acks immediately), and the
  report screen fetches `GET /api/runs/:runId/report` on `report.ready`.
- The presenter forgets its PDF when the screen unmounts; BrainSource re-feeds it, but a
  persistent deck (kept above the routes) would remove the reload during the countdown.
