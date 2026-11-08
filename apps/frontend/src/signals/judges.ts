import type { JudgeGaze, JudgeIndex, JudgeReaction } from "@/judges/types";

export type JudgeCommand =
  | { type: "say"; judge: JudgeIndex; text: string }
  | { type: "react"; judge: JudgeIndex; reaction: JudgeReaction }
  /** brain integration: the brain's judge audio is playing; level() drives the scene until done. */
  | { type: "speak"; judge: JudgeIndex; text: string; level: () => number; done: Promise<void> }
  /** brain integration: where a judge looks (actor.lookAt). */
  | { type: "look"; judge: JudgeIndex; target: JudgeGaze };

/** brain integration: one seated judge of the brain's panel (seat 0..3 left to right, brain id judge_N, title). */
export interface JudgeSeat { seat: JudgeIndex; actorId: string; title: string }

export const JUDGE_TEST_LINES = [
  "Who is paying for this today, and how much?",
  "How is this different from just rehearsing in front of a mirror?",
  "What does your retention look like after the first week?",
  "Walk me through your go-to-market for the first thousand users.",
] as const;

/** The app has no brain by default; an explicit source=backend opts in. */
export function judgesMode(search: string): "mock" | "backend" {
  return new URLSearchParams(search).get("source") === "backend" ? "backend" : "mock";
}