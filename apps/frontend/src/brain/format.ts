/**
 * Labels and formats shared by the report screen (BrainReport.tsx) and the progress view
 * (BrainProgress.tsx), Brain integration layer.
 */
import type { RunMode, FeedbackLevel } from "@coach/protocol";

/** 59_600 → "1:00" */
export const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const MODE_LABEL: Record<RunMode, string> = { baseline: "Baseline", training: "Training", test: "Test" };
export const LEVEL_LABEL: Record<FeedbackLevel, string> = { strong: "strong feedback", gentle: "gentle feedback", off: "no feedback" };
