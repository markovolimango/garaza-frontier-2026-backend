/**
 * Stand-ins for components owned by other lanes, so the brain runs end to end before they
 * land. Each one implements the real interface with the simplest honest behaviour and is
 * replaced in server.ts when the real component merges. Nothing here measures anything.
 */
import type {
  BehaviorKind, CoachState, FeedbackLevel, JudgeDef, PresentationBrief, Recommendation, RunId, RunState,
} from "@coach/protocol";
import type { CoachPolicy } from "./session.ts";
import type { ContextPort, ReportsPort } from "./jj/ports.ts";

/**
 * Placeholder for packages/rules coach.ts. Follows the stage table (baseline → training
 * strong → fading gentle → test → done) but cannot judge "clean" without RunSummary
 * metrics, so it never advances a level on its own: progress only via user overrides.
 */
export const placeholderCoach: CoachPolicy = {
  initial(): CoachState {
    return { stage: "baseline", level: "off", targets: [], score: 0.8, recommendation: null, trainingRuns: 0 };
  },
  recommend(c: CoachState): Recommendation {
    switch (c.stage) {
      case "baseline": return { mode: "baseline", level: "off", reason: "First, a baseline run without feedback, so we see where you start.", done: false };
      case "training": return { mode: "training", level: "strong", reason: "Next run with strong feedback on your targets.", done: false };
      case "fading": return { mode: "training", level: "gentle", reason: "Next time the signal will be softer and less frequent.", done: false };
      case "test": return { mode: "test", level: "off", reason: "A final run with no feedback, to check the change holds without help.", done: false };
      case "done": return { mode: "test", level: "off", reason: "That's the full loop; let's look at the final report.", done: true };
    }
  },
  afterRun(prev: CoachState, run: RunState): CoachState {
    const next = { ...prev, trainingRuns: prev.trainingRuns + (run.mode === "training" ? 1 : 0) };
    if (run.mode === "test" && prev.stage === "test") next.stage = "done";
    return next;
  },
  setTargets(prev: CoachState, targets: BehaviorKind[], completedRuns: number): CoachState {
    const next: CoachState = { ...prev, targets: targets.map((kind) => ({ kind, status: "learning", cleanStreak: 0, lastSeverity: 0 })) };
    if (prev.stage === "baseline" && completedRuns > 0 && targets.length) { next.stage = "training"; next.level = "strong"; }
    return next;
  },
  setLevel(prev: CoachState, level: FeedbackLevel): CoachState {
    const stage = level === "strong" ? "training" : level === "gentle" ? "fading" : "test";
    return { ...prev, level, stage: prev.stage === "baseline" ? prev.stage : stage, targets: prev.targets.map((t) => ({ ...t, cleanStreak: 0 })) };
  },
};

/** Placeholder for the context LLM (step 15): generic personas, no digest. */
export const placeholderContext = (): ContextPort => {
  let brief: PresentationBrief | null = null;
  const base: Pick<JudgeDef, "title" | "background" | "style" | "toughness" | "priorities">[] = [
    { title: "Audience member", background: "Listens closely to the main claims.", style: "warm", toughness: 0.3, priorities: [] },
    { title: "Practical listener", background: "Wants to know how it works in practice.", style: "neutral", toughness: 0.5, priorities: [] },
    { title: "Critical listener", background: "Looks for gaps in the argument.", style: "skeptical", toughness: 0.8, priorities: [] },
    { title: "Newcomer", background: "Hears about the topic for the first time.", style: "warm", toughness: 0.4, priorities: [] },
    { title: "Expert", background: "Knows the field well.", style: "neutral", toughness: 0.7, priorities: [] },
  ];
  return {
    async setBrief(b) { brief = b; },
    async generatePersonas(n) {
      const who = brief?.audience ? ` (${brief.audience})`.slice(0, 30) : "";
      return { judges: base.slice(0, n).map((p) => ({ ...p, title: `${p.title}${who}`.slice(0, 60) })), audienceCount: 12 };
    },
  };
};

/** Placeholder for reports (buildRunReport): nothing measured yet. */
export const placeholderReports: ReportsPort = {
  compactRunReport: (runId: RunId) => ({ run_id: runId, patterns: [], note: "behaviour measurement is not connected yet; no patterns were measured" }),
};
