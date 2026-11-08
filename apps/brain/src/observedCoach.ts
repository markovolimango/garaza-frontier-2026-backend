/**
 * ObservedCoach: a CoachPolicy that works without JJ. It keeps the placeholder's stage table
 * (baseline → training strong → fading gentle → test → done) and decides from what the coach
 * backend observed in each run (RunLog `coach.observation`s that map to a behaviour):
 *
 * - after the baseline: the two most frequent behaviours become the targets, next run is training
 *   (with no mappable behaviour: training without targets, i.e. feedback on everything);
 * - after a training run: a target not seen in that run gets a clean run; `cleanRuns` clean runs
 *   in a row fix it; all targets fixed → the next stage (training → fading → test), streaks reset;
 * - `maxTrainingRuns` training runs → test, whatever the targets.
 *
 * JJ's tools (set_targets, set_level) still override through setTargets / setLevel.
 */
import type { BehaviorKind, CoachState, Recommendation, RunState, TargetProgress } from "@coach/protocol";
import { placeholderCoach } from "./placeholders.ts";
import type { RunRecord } from "./runlog.ts";
import type { CoachPolicy } from "./session.ts";

export const BEHAVIOR_WORDS: Record<BehaviorKind, string> = {
  arms_crossed: "crossed arms", sway: "swaying", fast_hands: "fast hand movements", face_touch: "touching your face",
  looking_down: "looking down",
  not_facing_judge: "not facing the judges", filler_burst: "filler words", pace_fast: "speaking too fast", long_pause: "long pauses",
};

const severity = (n: number) => Math.min(1, n / 5);

/** Where the policy reads a finished run's observations (the RunLog, created after the policy). */
export interface RunSource { get(runId: string): Pick<RunRecord, "observations"> | null }

export function kindCounts(log: RunSource, runId: string): Map<BehaviorKind, number> {
  const counts = new Map<BehaviorKind, number>();
  for (const o of log.get(runId)?.observations ?? []) if (o.kind) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  return counts;
}

export function observedCoach(log: RunSource, opts: { cleanRuns: number; maxTrainingRuns: number }): CoachPolicy {
  const advance = (c: CoachState): CoachState => {
    const stage = c.stage === "training" ? "fading" : c.stage === "fading" ? "test" : c.stage;
    return { ...c, stage, level: stage === "fading" ? "gentle" : stage === "test" ? "off" : c.level,
      targets: c.targets.map((t) => ({ ...t, cleanStreak: 0, status: "learning" })) };
  };
  return {
    ...placeholderCoach,
    recommend(c: CoachState): Recommendation {
      const rec = placeholderCoach.recommend(c);
      const words = c.targets.map((t) => BEHAVIOR_WORDS[t.kind]);
      if (c.stage === "training" && !words.length) return { ...rec, reason: "Next run with live feedback on everything the coach notices." };
      if ((c.stage === "training" || c.stage === "fading") && words.length) {
        return { ...rec, reason: `Next run with ${c.stage === "training" ? "strong" : "gentle"} live feedback on ${words.join(" and ")}.` };
      }
      return rec;
    },
    afterRun(prev: CoachState, run: RunState): CoachState {
      let next = placeholderCoach.afterRun(prev, run);
      const counts = kindCounts(log, run.runId);
      const total = log.get(run.runId)?.observations.filter((o) => o.category).length ?? 0;
      next = { ...next, score: Math.max(0.2, Math.min(0.95, 0.9 - 0.06 * total)) };
      if (prev.stage === "baseline" && run.mode === "baseline") {
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
        const targets: TargetProgress[] = top.map(([kind, n]) => ({ kind, status: "learning", cleanStreak: 0, lastSeverity: severity(n) }));
        return { ...next, targets, stage: "training", level: "strong" };
      }
      if (run.mode !== "training") return next;
      const targets = next.targets.map((t): TargetProgress => {
        const n = counts.get(t.kind) ?? 0;
        const cleanStreak = n === 0 ? t.cleanStreak + 1 : 0;
        return { ...t, cleanStreak, lastSeverity: severity(n), status: cleanStreak >= opts.cleanRuns ? "fixed" : "learning" };
      });
      next = { ...next, targets };
      if (next.trainingRuns >= opts.maxTrainingRuns) return { ...advance({ ...next, stage: "fading" }), stage: "test", level: "off" };
      if (targets.length && targets.every((t) => t.status === "fixed")) return advance(next);
      return next;
    },
  };
}
