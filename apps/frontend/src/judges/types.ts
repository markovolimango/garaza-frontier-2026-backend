export type JudgeIndex = 0 | 1 | 2 | 3;

export type JudgeReaction = "nod" | "shake" | "disapprove" | "clap" | "think" | "texting" | "talking" | "idle" | "idle-alt";

export const JUDGE_REACTIONS: JudgeReaction[] = ["nod", "shake", "disapprove", "clap", "think", "texting", "talking", "idle", "idle-alt"];

export interface JudgeConfig {
  /** World position of the judge's root (floor under the chair). */
  position: [number, number, number];
  /** Height multiplier, ~0.94–1.06. */
  height: number;
  /** Suit tint (dark colors read best). */
  tint: string;
  idle: "sitting-idle" | "sitting-idle-2";
}

export interface JudgesHandle {
  /** Subtitle under the judge + talking animation + rim glow, for durationMs or a word-count estimate. */
  say(judge: JudgeIndex, text: string, durationMs?: number): void;
  /** Subtitle + talking while level() (0..1, e.g. live audio RMS) drives glow + head bob. Returns stop(). */
  speak(judge: JudgeIndex, text: string, level: () => number): () => void;
  /** Play a reaction; one-shots return to idle, "texting"/"talking"/"idle-alt" loop until another reaction. */
  react(judge: JudgeIndex, reaction: JudgeReaction): void;
}
