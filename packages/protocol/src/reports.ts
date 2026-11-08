/** Event store records, run summaries and reports (spec: "Event store …", "Reports"). */
import { z } from "zod";
import {
  BehaviorEvent, BehaviorKind, CoachState, FeedbackCategory, FeedbackCommand, FeedbackLevel, JudgeId, Recommendation,
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

/**
 * RunDigest: the run report the brain can build today, from what it actually observes (coach
 * observations, slides, feedback, wakes, Q&A), without STT or gaze. `GET /api/runs/:runId/report`.
 * The full RunReport above needs the event store's word and gaze streams.
 */
export const RunDigestObservation = z.object({
  rule: z.string(), kind: BehaviorKind.nullable(), category: FeedbackCategory.nullable(), label: z.string(),
  /** Occurrences: behaviour episodes when the coach sent them, else rule observations (the larger). */
  count: z.number().int(),
  /** Moments; from episodes they carry durationMs ("from 1:24 to 1:31"). */
  examples: z.array(z.object({ tRunMs: z.number(), durationMs: z.number().optional(), segment: Segment, slideIndex: z.number().int(), text: z.string() })).max(3),
  /** Episode time (camera behaviours with episodes only): total, longest, and share of the run in %. */
  time: z.object({ totalMs: z.number(), longestMs: z.number(), pct: z.number() }).optional(),
  isTarget: z.boolean(),
});
export type RunDigestObservation = z.infer<typeof RunDigestObservation>;

export const RunDigest = z.object({
  runId: RunId, index: z.number().int(), mode: RunMode, level: FeedbackLevel, targets: z.array(BehaviorKind),
  endedBy: z.enum(["qa_done", "end_run", "presentation_done", "aborted"]).nullable(),
  durations: z.object({ presentationMs: z.number(), qaMs: z.number(), pausedMs: z.number() }),
  slides: z.array(z.object({ index: z.number().int(), dwellMs: z.number(), visits: z.number().int() })),
  observations: z.array(RunDigestObservation),
  feedback: z.object({ warnings: z.number().int(), rewards: z.number().int() }),
  wakes: z.number().int(),
  qa: z.array(z.object({ judgeId: JudgeId, judgeTitle: z.string(), question: z.string(), answerMs: z.number() })),
  strengths: z.array(z.string()),
  next: Recommendation.nullable(),
  sources: z.object({ coach: z.boolean() }),
});
export type RunDigest = z.infer<typeof RunDigest>;

/**
 * SessionProgress: how the presenter changed across the session's runs (run 1 → 2 → 3), from the
 * same observations as RunDigest. `GET /api/progress`; the report screen shows it after two runs
 * and as the final view. `counts[i]` belongs to `runs[i]`; null = the camera coach wasn't connected.
 */
export const ProgressRun = z.object({
  runId: RunId, index: z.number().int(), mode: RunMode, level: FeedbackLevel, targets: z.array(BehaviorKind),
  endedBy: RunDigest.shape.endedBy,
  presentationMs: z.number(), qaMs: z.number(),
  observations: z.number().int(),          // presenter-behaviour observations (rules with a category)
  warnings: z.number().int(),              // vignettes shown
  score: z.number().min(0).max(1).nullable(),
  coach: z.boolean(),
});
export type ProgressRun = z.infer<typeof ProgressRun>;

export const ProgressRow = z.object({
  rule: z.string(), kind: BehaviorKind.nullable(), label: z.string(),
  counts: z.array(z.number().int().nullable()),
  /** counts per minute of the run (presentation + Q&A), so runs of different length compare fairly. */
  perMin: z.array(z.number().nullable()).optional(),
  /** Share of the run spent in this behaviour, % (camera behaviours with episodes only). */
  timePct: z.array(z.number().nullable()).optional(),
  isTarget: z.boolean(),
  status: z.enum(["learning", "fixed"]).nullable(),
  /** First measured run vs the last one, per minute. */
  trend: z.enum(["better", "same", "worse"]),
});
export type ProgressRow = z.infer<typeof ProgressRow>;

export const SessionProgress = z.object({
  sessionId: z.string(),
  runs: z.array(ProgressRun),
  rows: z.array(ProgressRow),
  coach: z.object({ stage: CoachState.shape.stage, level: FeedbackLevel, score: z.number(), recommendation: Recommendation.nullable() }),
  /** One line for the screen and JJ, e.g. "Fast hand movement 4 → 1 · Moving around 3 → 0". Null before two measured runs. */
  headline: z.string().nullable(),
});
export type SessionProgress = z.infer<typeof SessionProgress>;

/**
 * Narratives (swarm reporter, apps/brain/src/swarm/reporter.ts): the coach's written analysis of a
 * run and of the session, by an LLM from the board (transcript with fillers, judges' lines, video
 * notes) and the RunLog, or built deterministically from the same data when the LLM fails
 * (`source: "fallback"`). `GET /api/swarm/report/run/:runId`, `/api/swarm/report/session`.
 */
export const NarrativeSource = z.enum(["llm", "fallback"]);
export const QaVerdict = z.enum(["strong", "ok", "weak", "no answer"]);
export type QaVerdict = z.infer<typeof QaVerdict>;

export const RunNarrative = z.object({
  runId: RunId,
  index: z.number().int(),
  headline: z.string(),
  summary: z.string(),
  strengths: z.array(z.object({ text: z.string(), evidence: z.string() })),
  /** Most important first; evidence = a quote, or a time / slide ("1:23, slide 2"). */
  improvements: z.array(z.object({ title: z.string(), why: z.string(), evidence: z.string(), drill: z.string() })),
  /** From the listener's phrases. measured false = no transcript for this run (count 0 means nothing heard, not clean). */
  fillers: z.object({
    count: z.number().int(), perMin: z.number(), top: z.array(z.object({ word: z.string(), count: z.number().int() })),
    examples: z.array(z.string()), measured: z.boolean().optional(),
  }),
  qa: z.array(z.object({ judge: z.string(), question: z.string(), answerSummary: z.string(), verdict: QaVerdict, tip: z.string() })),
  body: z.array(z.object({ kind: z.string(), count: z.number().int(), note: z.string() })),
  nextRun: z.string(),
  source: NarrativeSource,
  createdAt: z.number().optional(),
});
export type RunNarrative = z.infer<typeof RunNarrative>;

export const SessionNarrative = z.object({
  headline: z.string(),
  summary: z.string(),
  /** First → last run, one line per behaviour ("Filler words: 14 → 5 (3.1 → 1.2/min)"). */
  progress: z.array(z.string()),
  strengths: z.array(z.string()),
  /** Top 3 things to work on next, each with a drill. */
  focus: z.array(z.object({ title: z.string(), why: z.string(), drill: z.string() })).max(3),
  runs: z.array(z.object({ runId: RunId, index: z.number().int(), headline: z.string() })),
  source: NarrativeSource,
  createdAt: z.number().optional(),
});
export type SessionNarrative = z.infer<typeof SessionNarrative>;

/** `GET /api/swarm/report/run/:runId` and `/api/swarm/report/session`. */
export type NarrativeStatus = "pending" | "ready" | "none";
