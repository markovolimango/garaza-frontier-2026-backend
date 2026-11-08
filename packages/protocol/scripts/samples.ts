/**
 * Source of fixtures/messages/*.json. Valid payloads are typed against the protocol, so a
 * schema change that breaks them fails `pnpm typecheck`; regenerate with `pnpm gen:fixtures`.
 */
import type {
  DownlinkPayload, DownlinkType, RunState, SceneDef, SessionState, UplinkPayload, UplinkType,
} from "../src/index.ts";
import { GREYBOX_VENUE } from "../src/venue.ts";

const scene: SceneDef = {
  version: 3, venueId: "greybox", qa: { questions: 2, answerCapMs: 45_000 },
  judges: [
    { id: "judge_1", title: "Seed investor", background: "Invests in B2B SaaS.", seat: "judge_seat_1", voiceId: "voiceA", toughness: 0.3, style: "warm", priorities: ["traction"] },
    { id: "judge_2", title: "Technical founder", background: "Built two dev tools.", seat: "judge_seat_2", voiceId: "voiceB", toughness: 0.5, style: "neutral", priorities: ["architecture"] },
    { id: "judge_3", title: "Domain expert", background: "Ran sales ops for 10 years.", seat: "judge_seat_3", voiceId: "voiceC", toughness: 0.8, style: "skeptical", priorities: ["churn", "pricing"] },
  ],
  audience: { count: 12 }, lighting: "default",
};
const deck = { deckId: "deck_1", name: "Acme seed", slides: [{ index: 0, url: "/api/decks/deck_1/0.png", text: "Acme" }, { index: 1, url: "/api/decks/deck_1/1.png", text: "Pricing" }] };
const run: RunState = {
  runId: "run_2", index: 2, mode: "training", feedbackLevel: "strong", targets: ["arms_crossed"], enabledCategories: ["posture", "disfluencies"],
  sceneVersion: 3, phase: "presentation", slideIndex: 1, paused: false, pausedMs: 0, startedAt: 1_762_540_000_000, presentationStartedAt: 1_762_540_003_000,
};
const session: SessionState = {
  sessionId: "V1StGXR8_Z5jdHi6B-myT", phase: "running", view: "slides",
  context: { deck, docs: [{ docId: "doc_1", name: "notes.md", chars: 1200 }], brief: { title: "Acme seed", audience: "seed investors", goal: "follow-up meeting", keyPoints: ["40 teams"], setting: "investor pitch", durationMin: 5 }, digest: "Seed pitch." },
  scene, run, completedRuns: ["run_1"],
  coach: { stage: "training", level: "strong", targets: [{ kind: "arms_crossed", status: "learning", cleanStreak: 0, lastSeverity: 0.6 }], score: 0.72, recommendation: { mode: "training", level: "strong", reason: "Strong feedback on crossed arms.", done: false }, trainingRuns: 1 },
  enabledCategories: ["posture", "disfluencies", "pace"], calibration: null, introDone: true,
  wake: { active: false, via: null, since: null },
};

type Down = { [K in DownlinkType]: { valid: DownlinkPayload<K>[]; invalid: { why: string; payload: unknown }[] } };
type Up = { [K in UplinkType]: { valid: UplinkPayload<K>[]; invalid: { why: string; payload: unknown }[] } };

export const DOWNLINK_SAMPLES: Down = {
  welcome: { valid: [{ sessionId: "V1StGXR8_Z5jdHi6B-myT", serverTime: 1_762_540_000_000, protocol: 1 }], invalid: [{ why: "protocol 2", payload: { sessionId: "s", serverTime: 1, protocol: 2 } }] },
  error: { valid: [{ code: "invalid_message", message: "unknown type", refId: "abc" }], invalid: [{ why: "unknown code", payload: { code: "oops", message: "x" } }] },
  ping: { valid: [{}], invalid: [{ why: "not an object", payload: "ping" }] },
  "state.snapshot": {
    valid: [{ session, connections: { stage: true, sensor: false, operator: true }, jj: { connected: true, listening: false, speaking: false }, feedback: { kind: "warn", intensity: 0.65, rampMs: 2000, reason: "arms_crossed" } }],
    invalid: [{ why: "connections missing a role", payload: { session, connections: { stage: true }, jj: { connected: true, listening: false, speaking: false }, feedback: { kind: "none", intensity: 0, rampMs: 1000 } } }],
  },
  "ui.state": { valid: [{ view: "jj", orb: { visible: true, placement: "center", score: 0.8 }, introDone: false }], invalid: [{ why: "unknown view", payload: { view: "vr", orb: { visible: true, placement: "center", score: 0.8 }, introDone: false } }] },
  "scene.sync": { valid: [{ scene, venue: GREYBOX_VENUE, deck }, { scene, venue: GREYBOX_VENUE, deck: null }], invalid: [{ why: "venue lacks judge seats", payload: { scene, venue: { ...GREYBOX_VENUE, anchors: { podium: GREYBOX_VENUE.anchors.podium } }, deck: null } }] },
  "scene.apply": {
    valid: [{ batchId: "b_1", version: 4, ops: [{ op: "judge.update", id: "judge_3", patch: { toughness: 0.9 } }, { op: "lighting.set", preset: "dim", transitionMs: 1500 }] }],
    invalid: [{ why: "empty ops", payload: { batchId: "b_1", version: 4, ops: [] } }, { why: "unknown op", payload: { batchId: "b", version: 4, ops: [{ op: "judges.dance" }] } }],
  },
  "run.state": { valid: [{ run, sessionPhase: "running" }, { run: null, sessionPhase: "setup" }], invalid: [{ why: "bad run id", payload: { run: { ...run, runId: "r2" }, sessionPhase: "running" } }] },
  "feedback.set": { valid: [{ kind: "none", intensity: 0, rampMs: 1000 }, { kind: "reward", intensity: 0.25, rampMs: 1500 }], invalid: [{ why: "intensity > 1", payload: { kind: "warn", intensity: 2, rampMs: 2000 } }] },
  "slide.show": { valid: [{ index: 0 }], invalid: [{ why: "negative index", payload: { index: -1 } }] },
  countdown: { valid: [{ secondsLeft: 3 }, { secondsLeft: 0 }], invalid: [{ why: "4 is not a countdown step", payload: { secondsLeft: 4 } }] },
  "actor.say": { valid: [{ actorId: "judge_2", utteranceId: "u_7", source: 2, text: "On the pricing slide you said 40 euros per seat…" }, { actorId: "jj", utteranceId: "jj_u1", source: 0, text: "" }], invalid: [{ why: "unknown actor", payload: { actorId: "judge_9", utteranceId: "u", source: 1, text: "x" } }] },
  "actor.gesture": { valid: [{ actorId: "audience", gesture: "shift" }, { actorId: "judge_1", gesture: "nod", durationMs: 800 }], invalid: [{ why: "unknown gesture", payload: { actorId: "judge_1", gesture: "dab" } }] },
  "actor.lookAt": { valid: [{ actorId: "judge_1", target: "presenter" }, { actorId: "judge_2", target: "judge_3" }], invalid: [{ why: "audience cannot look", payload: { actorId: "audience", target: "presenter" } }] },
  "audio.stop": { valid: [{ source: 0 }, { source: 2, utteranceId: "u_7" }], invalid: [{ why: "source out of range", payload: { source: 12 } }] },
  "jj.state": { valid: [{ connected: true, listening: true, speaking: false }], invalid: [{ why: "missing speaking", payload: { connected: true, listening: true } }] },
  "report.ready": { valid: [{ kind: "run", runId: "run_1" }, { kind: "final", sessionId: "V1StGXR8_Z5jdHi6B-myT" }], invalid: [{ why: "run kind without runId", payload: { kind: "run" } }] },
  "report.focus": { valid: [{ kind: "filler_burst" }, { kind: null }], invalid: [{ why: "unknown behaviour", payload: { kind: "nervousness" } }] },   // vocab-allow
  "calibrate.prompt": { valid: [{ judgeId: "judge_1" }, { judgeId: null }], invalid: [{ why: "missing judgeId", payload: {} }] },
  "sensor.config": { valid: [{ enabledCategories: ["posture", "gaze"], neutralPitchDeg: null, debug: false }], invalid: [{ why: "unknown category", payload: { enabledCategories: ["mood"], neutralPitchDeg: null, debug: false } }] },   // vocab-allow
  "hud.toast": { valid: [{ text: "Judges set to tough", level: "info" }], invalid: [{ why: "empty text", payload: { text: "", level: "info" } }] },
  "tool.result": { valid: [{ ok: true, version: 5 }, { ok: false, reason: "stage_timeout", hint: "the main screen did not confirm" }], invalid: [{ why: "failure without reason", payload: { ok: false } }] },
};

export const UPLINK_SAMPLES: Up = {
  hello: { valid: [{ role: "stage", clientId: "c_1", protocol: 1 }], invalid: [{ why: "unknown role", payload: { role: "vr", clientId: "c", protocol: 1 } }] },
  pong: { valid: [{}], invalid: [{ why: "not an object", payload: 1 }] },
  ack: { valid: [{ batchId: "b_1", version: 4, ok: true }, { batchId: "b_1", ok: false, error: "seat missing" }], invalid: [{ why: "ok without version", payload: { batchId: "b_1", ok: true } }] },
  "session.start": { valid: [{}], invalid: [{ why: "null payload", payload: null }] },
  "slide.changed": { valid: [{ index: 3, clientTs: 1_762_540_010_000 }], invalid: [{ why: "fractional index", payload: { index: 1.5, clientTs: 1 } }] },
  "presentation.done": { valid: [{}], invalid: [{ why: "array payload", payload: [] }] },
  ptt: { valid: [{ down: true }, { down: false }], invalid: [{ why: "down as string", payload: { down: "yes" } }] },
  "audio.playback": { valid: [{ source: 1, utteranceId: "u_1", state: "ended" }], invalid: [{ why: "unknown state", payload: { source: 1, utteranceId: "u_1", state: "paused" } }] },
  "tool.invoke": { valid: [{ tool: "set_judges", args: { toughness: 0.8 } }, { tool: "end_run", args: {} }], invalid: [{ why: "unknown tool", payload: { tool: "launch_rocket", args: {} } }] },
  "operator.override": {
    valid: [{ action: "vignette", kind: "warn", intensity: 0.65, holdMs: 3000 }, { action: "wake" }, { action: "jj_reconnect" }, { action: "replay", file: "fixtures/sessions/demo_short.jsonl", speed: 1 }],
    invalid: [{ why: "unknown action", payload: { action: "self_destruct" } }, { why: "vignette without intensity", payload: { action: "vignette", kind: "warn", holdMs: 1 } }],
  },
  behavior: { valid: [{ kind: "arms_crossed", phase: "start", clientTs: 1_762_540_011_000, conf: 0.92 }, { kind: "fast_hands", phase: "end", clientTs: 1_762_540_014_000, conf: 1 }], invalid: [{ why: "speech kinds come from the brain, not the sensor", payload: { kind: "filler_burst", phase: "start", clientTs: 1, conf: 1 } }] },
  "gaze.sample": { valid: [{ yawDeg: -12.5, pitchDeg: 4, clientTs: 1_762_540_011_100, facePresent: true }], invalid: [{ why: "missing facePresent", payload: { yawDeg: 0, pitchDeg: 0, clientTs: 1 } }] },
  "coach.observation": {
    valid: [
      { rule: "body.torso_movement_high", kind: "sway", category: "movement", text: "You have been moving around continuously.", clientTs: 1_762_540_011_000 },
      { rule: "body.hand_movement_high", kind: "fast_hands", category: "movement", text: "Your hands have been moving fast for a while.", clientTs: 1_762_540_012_000 },
      { rule: "body.looking_down", kind: "looking_down", category: "gaze", text: "Your head has been tilted down for 3 s.", clientTs: 1_762_540_012_500 },
      { rule: "heart.above_reference", kind: null, category: null, text: "Heart rate is above your session reference.", clientTs: 1_762_540_013_000 },
    ],
    invalid: [{ why: "kind must be a known behaviour", payload: { rule: "x", kind: "juggling", category: null, text: "", clientTs: 1 } }],
  },
  "sensor.status": { valid: [{ camera: "ok", fps: 29.5, posePresent: true }, { camera: "error", fps: 0, posePresent: false, message: "NotAllowedError" }], invalid: [{ why: "negative fps", payload: { camera: "ok", fps: -1, posePresent: true } }] },
  "sensor.debug": { valid: [{ clientTs: 1, landmarks: [[0.5, 0.4, -0.1, 0.99]], aspect: 1.777 }], invalid: [{ why: "landmark with 3 values", payload: { clientTs: 1, landmarks: [[0.5, 0.4, 0.1]], aspect: 1.7 } }] },
};
