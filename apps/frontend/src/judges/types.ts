export type JudgeIndex = 0 | 1 | 2 | 3;

export type JudgeReaction = "nod" | "shake" | "disapprove" | "clap" | "think" | "texting" | "talking" | "idle" | "idle-alt";

export const JUDGE_REACTIONS: JudgeReaction[] = ["nod", "shake", "disapprove", "clap", "think", "texting", "talking", "idle", "idle-alt"];

/** Where a judge looks: the presenter (camera), the notes on the table, the audience behind the presenter, or another judge's seat. */
export type JudgeGaze = "presenter" | "notes" | "audience" | JudgeIndex;

export interface JudgeConfig {
  /** World position of the judge's root (floor under the chair). */
  position: [number, number, number];
  /** Height multiplier, ~0.94–1.06. */
  height: number;
  /** Suit tint (dark colors read best). */
  tint: string;
  idle: "sitting-idle" | "sitting-idle-2";
  /** Optional nameplate on the table in front of the judge (e.g. "VC investor"). */
  title?: string;
}

export interface JudgesHandle {
  /** Subtitle under the judge + talking animation + rim glow, for durationMs or a word-count estimate. */
  say(judge: JudgeIndex, text: string, durationMs?: number): void;
  /** Subtitle + talking while level() (0..1, e.g. live audio RMS) drives glow + head bob. Returns stop(). */
  speak(judge: JudgeIndex, text: string, level: () => number): () => void;
  /** Play a reaction; one-shots return to idle, "texting"/"talking"/"idle-alt" loop until another reaction. */
  react(judge: JudgeIndex, reaction: JudgeReaction): void;
  /** Turn the judge's head (smoothly) toward a target until told otherwise. Default "presenter". */
  lookAt(judge: JudgeIndex, target: JudgeGaze): void;
}
