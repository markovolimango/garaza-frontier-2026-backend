/**
 * Brain judges → the judges screen (Brain integration layer).
 *
 * The brain allows one stage connection, and BrainSource holds it, so the judges screen must
 * not open its own (src/judges/live/BackendSource would replace BrainSource). Instead the
 * brain's judge messages become bus "judgeCommand"s, which Lovable's JudgesStage already
 * plays on Marko's scene:
 *
 *   actor.say judge_N + its audio starts within NO_AUDIO_MS → { type: "speak" }: subtitle + talking,
 *                                     glow/head bob from source N's level, until that audio ends
 *   actor.say judge_N, no audio (no ElevenLabs key, audio locked) → { type: "say" }: subtitle,
 *                                     or the browser voice when "Enable audio" was clicked
 *   actor.gesture judge_N            → { type: "react" } (talking / texting / idle-alt end after durationMs)
 *
 * JJ (source 0), judge_5 and the audience are not on this screen.
 */
import type { DownlinkPayload, Gesture } from "@coach/protocol";
import type { JudgeIndex, JudgeReaction } from "../judges/types";
import type { JudgeCommand } from "../signals/judges";

/** Same table as src/judges/live/useJudgesLive.ts GESTURE_TO_REACTION (not imported: that module is browser-only). */
export const GESTURE_REACTION: Record<Gesture, JudgeReaction> = {
  idle: "idle", nod: "nod", cross_arms: "disapprove", note: "texting", check_watch: "texting",
  lean_in: "think", talk: "talking", shift: "idle-alt", lean_back: "idle-alt",
};
const LOOPING: ReadonlySet<JudgeReaction> = new Set(["talking", "texting", "idle-alt"]);
export const NO_AUDIO_MS = 2500;

export type Playback = { source: number; utteranceId: string; state: "started" | "ended" | "stopped" };

export function judgeIndex(actorId: string): JudgeIndex | null {
  const m = /^judge_([1-4])$/.exec(actorId);
  return m ? ((Number(m[1]) - 1) as JudgeIndex) : null;
}

interface Pending { judge: JudgeIndex; text: string; timer: ReturnType<typeof setTimeout> }

export class JudgeRelay {
  private readonly pending = new Map<string, Pending>();          // utteranceId → waiting for its audio
  private readonly speaking = new Map<string, () => void>();       // utteranceId → resolves `done`
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly o: { publish: (c: JudgeCommand) => void; level: (source: number) => number; noAudioMs?: number }) {}

  say(p: DownlinkPayload<"actor.say">): void {
    const judge = judgeIndex(p.actorId);
    if (judge === null) return;
    const timer = setTimeout(() => {
      if (this.pending.delete(p.utteranceId)) this.o.publish({ type: "say", judge, text: p.text });
    }, this.o.noAudioMs ?? NO_AUDIO_MS);
    this.pending.set(p.utteranceId, { judge, text: p.text, timer });
  }

  /** AudioOut's playback reports (it tags each utterance with the id from actor.say). */
  playback(p: Playback): void {
    if (p.state === "started") {
      const s = this.pending.get(p.utteranceId);
      if (!s) return;
      clearTimeout(s.timer);
      this.pending.delete(p.utteranceId);
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => { resolve = r; });
      this.speaking.set(p.utteranceId, resolve);
      this.o.publish({ type: "speak", judge: s.judge, text: s.text, level: () => this.o.level(p.source), done });
      return;
    }
    this.speaking.get(p.utteranceId)?.();
    this.speaking.delete(p.utteranceId);
  }

  gesture(g: DownlinkPayload<"actor.gesture">): void {
    const judge = judgeIndex(g.actorId);
    if (judge === null) return;
    const reaction = GESTURE_REACTION[g.gesture];
    this.o.publish({ type: "react", judge, reaction });
    if (g.durationMs && LOOPING.has(reaction)) {
      const t = setTimeout(() => { this.timers.delete(t); this.o.publish({ type: "react", judge, reaction: "idle" }); }, g.durationMs);
      this.timers.add(t);
    }
  }

  clear(): void {
    for (const s of this.pending.values()) clearTimeout(s.timer);
    for (const t of this.timers) clearTimeout(t);
    for (const resolve of this.speaking.values()) resolve();
    this.pending.clear();
    this.timers.clear();
    this.speaking.clear();
  }
}
