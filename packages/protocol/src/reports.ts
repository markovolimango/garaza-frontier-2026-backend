/** Event store records, run summaries and reports (spec: "Event store …", "Reports"). */
import { z } from "zod";
import {
  BehaviorEvent, BehaviorKind, CoachState, FeedbackCommand, FeedbackLevel, JudgeId, Recommendation,
  RunId, RunMode, RunState, WordToken,
} from "./domain.ts";

export const StoredEvent = z.intersection(
  z.object({ seq: z.number().int(), t: z.number(), runId: RunId.nullable() }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("behavior"), e: BehaviorEvent }),
    z.object({ kind: z.literal("word"), w: WordToken }),
    z.object({ kind: z.literal("gaze"), yawDeg: z.number(), pitchDeg: z.number(), judgeId: JudgeId.nullable() }),
    z.object({ kind: z.literal("slide"), index: z.number().int().min(0) }),
    z.object({ kind: z.literal("wake"), active: z.boolean() }),
    z.object({ kind: z.literal("feedback"), f: FeedbackCommand, shadow: z.boolean() }),
    z.object({ kind: z.literal("phase"), run: RunState }),
    z.object({ kind: z.literal("qa"), judgeId: JudgeId, question: z.string(), answer: z.string() }),
  ]),
);
export type StoredEvent = z.infer<typeof StoredEvent>;

const judgeNumbers = z.partialRecord(JudgeId, z.number());
export const Metrics = z.object({
  durationMs: z.number(),
  armsCrossed: z.object({ totalMs: z.number(), pct: z.number(), episodes: z.number().int(), longestMs: z.number() }),
  sway: z.object({ totalMs: z.number(), pct: z.number(), episodes: z.number().int() }).optional(),
  faceTouch: z.object({ episodes: z.number().int(), totalMs: z.number() }).optional(),
  lookingDown: z.object({ totalMs: z.number(), pct: z.number() }).optional(),
  fillers: z.object({ count: z.number().int(), perMin: z.number(), byWord: z.record(z.string(), z.number().int()) }),
  pace: z.object({ avgWpm: z.number(), pctInBand: z.number(), fastStretches: z.number().int() }).nullable(),
  pauses: z.object({ over3s: z.number().int(), longestMs: z.number() }),
  repetitions: z.object({ count: z.number().int() }),
  gaze: z.object({ shareByJudge: judgeNumbers, longestAwayMs: judgeNumbers }).optional(),
});
export type Metrics = z.infer<typeof Metrics>;

export const Segment = z.enum(["presentation", "qa"]);
export const Highlight = z.object({
  kind: BehaviorKind, segment: Segment, tRunMs: z.number(), durationMs: z.number().optional(),
  slideIndex: z.number().int(), snippet: z.string(), note: z.string(),
});
export type Highlight = z.infer<typeof Highlight>;

export const QaTurn = z.object({ judgeId: JudgeId, question: z.string(), answer: z.string() });
export const SlideStat = z.object({ index: z.number().int(), dwellMs: z.number(), words: z.number().int(), fillers: z.number().int(), wpm: z.number().nullable() });

export const RunSummary = z.object({
  runId: RunId, index: z.number().int(), mode: RunMode, feedbackLevel: FeedbackLevel, targets: z.array(BehaviorKind),
  durations: z.object({ presentationMs: z.number(), qaMs: z.number(), pausedMs: z.number() }),
  metrics: z.object({ all: Metrics, presentation: Metrics, qa: Metrics }),
  triggers: z.partialRecord(BehaviorKind, z.object({ onsets: z.number().int(), totalMs: z.number() })),
  rewards: z.number().int(),
  severity: z.partialRecord(BehaviorKind, z.number().min(0).max(1)),
  slides: z.array(SlideStat),
  highlights: z.array(Highlight),
  transcript: z.object({ bySlide: z.record(z.string(), z.string()), qa: z.string() }),
  qa: z.array(QaTurn),
  unavailable: z.array(z.enum(["speech", "pose", "face"])),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunComparison = z.object({
  rows: z.array(z.object({
    key: z.string(), label: z.string(), unit: z.string(), a: z.number(), b: z.number(), delta: z.number(),
    better: z.enum(["lower", "higher", "band"]),
  })),
});
export type RunComparison = z.infer<typeof RunComparison>;

export const PatternCard = z.object({
  kind: BehaviorKind,
  label: z.string(),
  severity: z.number().min(0).max(1),
  stat: z.string(),
  examples: z.array(z.object({ tRunMs: z.number(), segment: Segment, slideIndex: z.number().int(), snippet: z.string() })).max(2),
  trend: z.enum(["new", "better", "same", "worse"]).nullable(),
  isTarget: z.boolean(),
  status: z.enum(["learning", "fixed"]).nullable(),
  feedbackShown: z.number().int(),
});
export type PatternCard = z.infer<typeof PatternCard>;

export const RunReport = z.object({
  runId: RunId, index: z.number().int(), mode: RunMode, level: FeedbackLevel,
  durations: RunSummary.shape.durations,
  patterns: z.array(PatternCard).max(5),
  strengths: z.array(z.string()),
  slides: z.array(SlideStat),
  qa: z.array(QaTurn),
  coach: z.object({ stage: CoachState.shape.stage, level: FeedbackLevel, score: z.number(), recommendation: Recommendation }),
});
export type RunReport = z.infer<typeof RunReport>;

const Span = z.object({ startMs: z.number(), endMs: z.number() });
export const RunTimeline = z.object({
  durationMs: z.number(), qaStartMs: z.number(),
  slides: z.array(z.object({ index: z.number().int(), startMs: z.number(), endMs: z.number() })),
  lanes: z.array(z.object({ key: z.union([BehaviorKind, z.literal("feedback")]), label: z.string(), spans: z.array(Span), ticks: z.array(z.object({ tMs: z.number() })) })),
  words: z.array(z.object({ tMs: z.number(), text: z.string(), isFiller: z.boolean() })),
  wpmSeries: z.array(z.object({ tMs: z.number(), wpm: z.number() })),
});
export type RunTimeline = z.infer<typeof RunTimeline>;

export const FinalReport = z.object({
  baseline: RunReport, final: RunReport,
  runs: z.array(z.object({ runId: RunId, mode: RunMode, level: FeedbackLevel, score: z.number() })),
  comparison: RunComparison,
  targets: z.array(z.object({ kind: BehaviorKind, label: z.string(), baseline: z.string(), final: z.string(), held: z.boolean() })),
  timelines: z.object({ baseline: RunTimeline, final: RunTimeline }),
});
export type FinalReport = z.infer<typeof FinalReport>;
