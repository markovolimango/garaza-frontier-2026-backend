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
 *   actor.lookAt judge_N             → { type: "look" } (presenter / notes / audience / another seated judge)
 *
 * judge_N is addressed by its seat in the brain's panel (setPanel, from scene.sync / scene.apply);
 * before a panel is known, judge_N sits in seat N. JJ (source 0), judges without a seat in the room
 * (judge_5) and the audience are not on this screen.
 */
import type { DownlinkPayload, Gesture, JudgeId } from "@coach/protocol";
import type { JudgeIndex, JudgeReaction } from "../judges/types";
import type { JudgeCommand, JudgeSeat } from "../signals/judges";
import { gazeFor } from "./scene";

/** Same table as src/judges/live/useJudgesLive.ts GESTURE_TO_REACTION (not imported: that module is browser-only). */
export const GESTURE_REACTION: Record<Gesture, JudgeReaction> = {
  idle: "idle", nod: "nod", cross_arms: "disapprove", note: "texting", check_watch: "texting",
  lean_in: "think", talk: "talking", shift: "idle-alt", lean_back: "idle-alt",
};
const LOOPING: ReadonlySet<JudgeReaction> = new Set(["talking", "texting", "idle-alt"]);
/** ElevenLabs flash starts in well under a second; without a key no audio comes at all. */
export const NO_AUDIO_MS = 1500;

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
  private panel: JudgeSeat[] | null = null;

  constructor(private readonly o: { publish: (c: JudgeCommand) => void; level: (source: number) => number; noAudioMs?: number }) {}

  /** The brain's panel by seat; judge ids map to these seats from now on. */
  setPanel(panel: JudgeSeat[]): void { this.panel = panel; }

  /** Seat of a judge in the room, or null when it has none (not in the panel, judge_5, JJ). */
  seatOf(actorId: string): JudgeIndex | null {
    if (!this.panel) return judgeIndex(actorId);
    return this.panel.find((s) => s.actorId === actorId)?.seat ?? null;
  }

  say(p: DownlinkPayload<"actor.say">): void {
    const judge = this.seatOf(p.actorId);
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

  lookAt(p: DownlinkPayload<"actor.lookAt">): void {
    const judge = this.seatOf(p.actorId);
    const target = gazeFor(p.target, (id: JudgeId) => this.seatOf(id));
    if (judge === null || target === null) return;
    this.o.publish({ type: "look", judge, target });
  }

  gesture(g: DownlinkPayload<"actor.gesture">): void {
    const judge = this.seatOf(g.actorId);
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
