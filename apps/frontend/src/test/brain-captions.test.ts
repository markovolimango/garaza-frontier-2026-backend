import { describe, expect, it } from "vitest";
import { CAPTIONS, CaptionStore, applyTranscript, visibleCaptions, type CaptionLine } from "../brain/captions";

const msg = (lineId: string, who: "user" | "jj", text: string, final = false) => ({ lineId, who, text, final });

describe("JJ captions (jj.transcript → what JJ's screen shows)", () => {
  it("replaces a line whole by lineId and ignores late partials after its final", () => {
    let lines: CaptionLine[] = [];
    lines = applyTranscript(lines, msg("user_t1", "user", "Hi JJ"), 0);
    lines = applyTranscript(lines, msg("user_t1", "user", "Hi JJ, I'm ready."), 300);
    lines = applyTranscript(lines, msg("user_t1", "user", "Hi JJ, I'm ready.", true), 1500);
    lines = applyTranscript(lines, msg("user_t1", "user", "Hi JJ, I'm"), 1600);
    expect(lines).toEqual([{ lineId: "user_t1", who: "user", text: "Hi JJ, I'm ready.", final: true, firstAt: 0, finalAt: 1500 }]);
  });

  it("reveals JJ's words at speaking pace, the user's at once", () => {
    const text = "Great start. Let's run it again with a slower opening.";
    let lines: CaptionLine[] = [];
    lines = applyTranscript(lines, msg("user_t1", "user", "Am I too fast?", true), 0);
    lines = applyTranscript(lines, msg("jj_t2", "jj", text, true), 0);
    const at = (ms: number) => visibleCaptions(lines, ms).map((c) => c.text);
    expect(at(0)).toEqual(["Am I too fast?"]);                        // JJ's line has no word yet
    expect(at(1000)).toEqual(["Am I too fast?", "Great start."]);     // 16 chars in: whole words only
    const all = (text.length / CAPTIONS.charsPerSec) * 1000;
    expect(at(all)).toEqual(["Am I too fast?", text]);
    expect(visibleCaptions(lines, all)[1]).toMatchObject({ live: false, opacity: 1 });
    expect(visibleCaptions(lines, 1000)[1]!.live).toBe(true);
  });

  it("dims older lines, shows at most three, and fades complete lines out", () => {
    let lines: CaptionLine[] = [];
    for (let i = 1; i <= 4; i++) lines = applyTranscript(lines, msg(`user_t${i}`, "user", `line ${i}`, true), i * 100);
    const v = visibleCaptions(lines, 500);
    expect(v.map((c) => [c.text, c.opacity])).toEqual([["line 2", 0.25], ["line 3", 0.5], ["line 4", 1]]);
    const gone = 400 + CAPTIONS.holdMs + CAPTIONS.fadeMs;
    expect(visibleCaptions(lines, gone)).toEqual([]);
    expect(visibleCaptions(lines, 400 + CAPTIONS.holdMs + CAPTIONS.fadeMs / 2).at(-1)!.opacity).toBeCloseTo(0.5);
  });

  it("CaptionStore notifies, prunes faded lines and clears", () => {
    let now = 0;
    const store = new CaptionStore(() => now);
    let calls = 0;
    store.subscribe(() => calls++);
    store.push(msg("jj_t1", "jj", "Hello!", true));
    expect(store.getLines()).toHaveLength(1);
    now = 60_000;
    store.prune();
    expect(store.getLines()).toHaveLength(0);
    store.push(msg("jj_t2", "jj", "Again"));
    store.clear();
    expect(store.getLines()).toEqual([]);
    expect(calls).toBe(4);
  });
});
