/**
 * PROVISIONAL SUBSET of `packages/protocol` (spec: "Shared domain types").
 *
 * Only the lead owns this package. It was created by the JJ-engine lane because the
 * package did not exist yet; it contains just what the JJ adapter and the tool registry
 * need, transcribed 1:1 from the spec. The lead should replace or extend it.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

// ---- ids ----
export const SessionId = z.string().min(1);
export const RunId = z.templateLiteral(["run_", z.number().int().positive()]);
export const JudgeId = z.enum(["judge_1", "judge_2", "judge_3", "judge_4", "judge_5"]);
export const AnchorId = z.string().min(1);
export type SessionId = z.infer<typeof SessionId>;
export type RunId = z.infer<typeof RunId>;
export type JudgeId = z.infer<typeof JudgeId>;
export type AnchorId = z.infer<typeof AnchorId>;

// ---- behaviours ----
export const BehaviorKind = z.enum([
  "arms_crossed", "sway", "face_touch", "looking_down", "not_facing_judge",
  "filler_burst", "pace_fast", "long_pause",
]);
export type BehaviorKind = z.infer<typeof BehaviorKind>;
export const FeedbackCategory = z.enum(["posture", "movement", "gaze", "disfluencies", "pace"]);
export type FeedbackCategory = z.infer<typeof FeedbackCategory>;
export const FEEDBACK_ELIGIBLE = ["arms_crossed", "sway", "face_touch", "looking_down", "filler_burst", "pace_fast"] as const;
export const FeedbackEligibleKind = z.enum(FEEDBACK_ELIGIBLE);

// ---- loop ----
export const RunMode = z.enum(["baseline", "training", "test"]);
export const FeedbackLevel = z.enum(["strong", "gentle", "off"]);
export const SessionPhase = z.enum(["setup", "intro", "calibrating", "running", "debrief", "final"]);
export const RunPhase = z.enum(["countdown", "presentation", "qa", "ended", "aborted"]);
export const StageView = z.enum(["setup", "jj", "slides", "room", "report", "final"]);
export const JudgeStyle = z.enum(["warm", "neutral", "skeptical"]);
export const LightingPreset = z.enum(["default", "stage", "dim"]);
export type RunMode = z.infer<typeof RunMode>;
export type FeedbackLevel = z.infer<typeof FeedbackLevel>;
export type SessionPhase = z.infer<typeof SessionPhase>;
export type RunPhase = z.infer<typeof RunPhase>;
export type StageView = z.infer<typeof StageView>;
export type JudgeStyle = z.infer<typeof JudgeStyle>;
export type LightingPreset = z.infer<typeof LightingPreset>;

// ---- context ----
export const Slide = z.object({ index: z.number().int().min(0), url: z.string(), text: z.string() });
export const Deck = z.object({ deckId: z.string(), name: z.string(), slides: z.array(Slide) });
export const ContextDocMeta = z.object({ docId: z.string(), name: z.string(), chars: z.number().int() });
export const PresentationBrief = z.object({
  title: z.string(), audience: z.string(), goal: z.string(),
  keyPoints: z.array(z.string()).max(6),
  setting: z.string(),
  durationMin: z.number().positive().optional(),
});
export const SessionContext = z.object({
  deck: Deck.nullable(),
  docs: z.array(ContextDocMeta),
  brief: PresentationBrief.nullable(),
  digest: z.string().nullable(),
});
export type Deck = z.infer<typeof Deck>;
export type PresentationBrief = z.infer<typeof PresentationBrief>;
export type SessionContext = z.infer<typeof SessionContext>;

// ---- scene ----
export const JudgeDef = z.object({
  id: JudgeId,
  title: z.string(),
  background: z.string(),
  seat: AnchorId,
  voiceId: z.string(),
  toughness: z.number().min(0).max(1),
  style: JudgeStyle,
  priorities: z.array(z.string()).max(3),
});
export const SceneDef = z.object({
  version: z.number().int(),
  venueId: z.string(),
  qa: z.object({ questions: z.number().int().min(0).max(5), answerCapMs: z.number().int().positive() }),
  judges: z.array(JudgeDef).min(1).max(5),
  audience: z.object({ count: z.number().int().min(0).max(40) }),
  lighting: LightingPreset,
});
export type JudgeDef = z.infer<typeof JudgeDef>;
export type SceneDef = z.infer<typeof SceneDef>;

export const SceneOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("judges.set"), judges: z.array(JudgeDef) }),
  z.object({
    op: z.literal("judge.update"), id: JudgeId,
    patch: JudgeDef.pick({ toughness: true, style: true, title: true, priorities: true }).partial(),
  }),
  z.object({ op: z.literal("audience.set"), count: z.number().int().min(0).max(40) }),
  z.object({ op: z.literal("lighting.set"), preset: LightingPreset, transitionMs: z.number().int().min(0) }),
  z.object({ op: z.literal("qa.set"), qa: SceneDef.shape.qa }),
  z.object({ op: z.literal("venue.set"), venueId: z.string() }),
]);
export type SceneOp = z.infer<typeof SceneOp>;

// ---- run ----
export const RunState = z.object({
  runId: RunId, index: z.number().int().positive(),
  mode: RunMode, feedbackLevel: FeedbackLevel,
  targets: z.array(BehaviorKind).max(2),
  enabledCategories: z.array(FeedbackCategory),
  sceneVersion: z.number().int(),
  phase: RunPhase,
  slideIndex: z.number().int().min(0),
  paused: z.boolean(),
  pausedMs: z.number().min(0),
  startedAt: z.number().optional(),
  presentationStartedAt: z.number().optional(),
  presentationEndedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type RunState = z.infer<typeof RunState>;

// ---- coaching ----
export const TargetProgress = z.object({
  kind: BehaviorKind, status: z.enum(["learning", "fixed"]), cleanStreak: z.number().int(), lastSeverity: z.number(),
});
export const Recommendation = z.object({ mode: RunMode, level: FeedbackLevel, reason: z.string(), done: z.boolean() });
export const CoachState = z.object({
  stage: z.enum(["baseline", "training", "fading", "test", "done"]),
  level: FeedbackLevel,
  targets: z.array(TargetProgress),
  score: z.number().min(0).max(1),
  recommendation: Recommendation.nullable(),
  trainingRuns: z.number().int(),
});
export type CoachState = z.infer<typeof CoachState>;

// ---- session ----
export const GazeCalibration = z.object({
  yawByJudge: z.partialRecord(JudgeId, z.number()), neutralPitchDeg: z.number(), marginDeg: z.number(),
});
export const WakeState = z.object({
  active: z.boolean(), via: z.enum(["phrase", "ptt", "operator"]).nullable(), since: z.number().nullable(),
});
export const SessionState = z.object({
  sessionId: SessionId,
  phase: SessionPhase,
  view: StageView,
  context: SessionContext,
  scene: SceneDef,
  run: RunState.nullable(),
  completedRuns: z.array(RunId),
  coach: CoachState,
  enabledCategories: z.array(FeedbackCategory),
  calibration: GazeCalibration.nullable(),
  introDone: z.boolean(),
  wake: WakeState,
});
export type GazeCalibration = z.infer<typeof GazeCalibration>;
export type WakeState = z.infer<typeof WakeState>;
export type SessionState = z.infer<typeof SessionState>;

// ---- supporting ----
export const ClientRole = z.enum(["stage", "sensor", "operator"]);
export type ClientRole = z.infer<typeof ClientRole>;
export const ErrorCode = z.enum([
  "invalid_message", "protocol_mismatch", "invalid_args", "wrong_phase",
  "stage_offline", "stage_timeout", "not_available", "no_deck", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const JJState = z.object({ connected: z.boolean(), listening: z.boolean(), speaking: z.boolean() });
export type JJState = z.infer<typeof JJState>;

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; reason: ErrorCode; hint?: string };
export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; reason: ErrorCode; hint?: string };

/** Audio sources on /ws/audio (spec: Transport). */
export const AUDIO_SOURCE = { jj: 0, system: 9 } as const;
export const AUDIO_FLAG = { utteranceStart: 1, utteranceEnd: 2 } as const;
