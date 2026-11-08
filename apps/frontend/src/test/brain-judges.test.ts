import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JudgeRelay, NO_AUDIO_MS, judgeIndex } from "../brain/judges";
import type { JudgeCommand } from "../signals/judges";

describe("JudgeRelay (brain judges → bus judgeCommand)", () => {
  let out: JudgeCommand[];
  let relay: JudgeRelay;
  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    relay = new JudgeRelay({ publish: (c) => out.push(c), level: (s) => s / 10 });
  });
  afterEach(() => vi.useRealTimers());

  it("maps judge_1..4 to scene indices 0..3 and skips others", () => {
    expect(judgeIndex("judge_1")).toBe(0);
    expect(judgeIndex("judge_4")).toBe(3);
    expect(judgeIndex("judge_5")).toBeNull();
    expect(judgeIndex("jj")).toBeNull();
  });

  it("speaks with the source's live level while the brain's audio plays", async () => {
    relay.say({ actorId: "judge_2", utteranceId: "judge_2_u1", source: 2, text: "What's your CAC?" });
    expect(out).toEqual([]);
    relay.playback({ source: 2, utteranceId: "judge_2_u1", state: "started" });
    const c = out[0];
    expect(c?.type).toBe("speak");
    if (c?.type !== "speak") return;
    expect([c.judge, c.text, c.level()]).toEqual([1, "What's your CAC?", 0.2]);
    let done = false;
    void c.done.then(() => { done = true; });
    relay.playback({ source: 2, utteranceId: "judge_2_u1", state: "ended" });
    await Promise.resolve();
    expect(done).toBe(true);
    vi.advanceTimersByTime(NO_AUDIO_MS * 2);
    expect(out).toHaveLength(1);   // no fallback after the audio started
  });

  it("falls back to a plain say when no audio comes (no ElevenLabs key, audio locked)", () => {
    relay.say({ actorId: "judge_3", utteranceId: "u", source: 3, text: "Who pays?" });
    vi.advanceTimersByTime(NO_AUDIO_MS);
    expect(out).toEqual([{ type: "say", judge: 2, text: "Who pays?" }]);
    relay.playback({ source: 3, utteranceId: "u", state: "started" });   // late audio: not doubled
    expect(out).toHaveLength(1);
  });

  it("ignores JJ and audio of utterances it did not see", () => {
    relay.say({ actorId: "jj", utteranceId: "jj_1", source: 0, text: "hi" });
    relay.playback({ source: 0, utteranceId: "jj_1", state: "started" });
    vi.advanceTimersByTime(NO_AUDIO_MS);
    expect(out).toEqual([]);
  });

  it("turns gestures into reactions; looping ones end after durationMs", () => {
    relay.gesture({ actorId: "judge_1", gesture: "nod" });
    relay.gesture({ actorId: "judge_4", gesture: "check_watch", durationMs: 1000 });
    relay.gesture({ actorId: "audience", gesture: "shift" });
    expect(out).toEqual([{ type: "react", judge: 0, reaction: "nod" }, { type: "react", judge: 3, reaction: "texting" }]);
    vi.advanceTimersByTime(1000);
    expect(out[2]).toEqual({ type: "react", judge: 3, reaction: "idle" });
  });

  it("clear() drops pending lines and ends live ones", async () => {
    relay.say({ actorId: "judge_1", utteranceId: "a", source: 1, text: "x" });
    relay.say({ actorId: "judge_2", utteranceId: "b", source: 2, text: "y" });
    relay.playback({ source: 2, utteranceId: "b", state: "started" });
    const c = out[0];
    let done = false;
    if (c?.type === "speak") void c.done.then(() => { done = true; });
    relay.clear();
    await Promise.resolve();
    vi.advanceTimersByTime(NO_AUDIO_MS);
    expect(done).toBe(true);
    expect(out).toHaveLength(1);
  });
});
