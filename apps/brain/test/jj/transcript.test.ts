import { describe, expect, it } from "vitest";
import { TranscriptRelay, type TranscriptLine } from "../../src/jj/transcript.ts";
import { VirtualClock } from "../helpers.ts";

function setup(o: { maxChars?: number } = {}) {
  const clock = new VirtualClock();
  const sent: TranscriptLine[] = [];
  const relay = new TranscriptRelay({ clock, send: (l) => sent.push(l), throttleMs: 250, idleMs: 1500, ...o });
  return { clock, sent, relay };
}

describe("TranscriptRelay (agent transcript deltas → jj.transcript lines)", () => {
  it("merges deltas into one line, sends the whole line throttled, final after silence", () => {
    const t = setup();
    t.relay.push("jj", "Nice", false, "jj_u1");
    expect(t.sent).toEqual([{ lineId: "jj_t1", who: "jj", text: "Nice", final: false, utteranceId: "jj_u1" }]);
    t.relay.push("jj", " opening.", false);
    t.relay.push("jj", " Want to", false);
    expect(t.sent).toHaveLength(1);                         // throttled
    t.clock.advance(250);
    expect(t.sent.at(-1)).toMatchObject({ lineId: "jj_t1", text: "Nice opening. Want to", final: false });
    t.relay.push("jj", " try again?", false);
    t.clock.advance(250);
    expect(t.sent.at(-1)).toMatchObject({ text: "Nice opening. Want to try again?", final: false });
    t.clock.advance(1500);
    expect(t.sent.at(-1)).toEqual({ lineId: "jj_t1", who: "jj", text: "Nice opening. Want to try again?", final: true, utteranceId: "jj_u1" });
    expect(t.sent).toHaveLength(4);
    expect(t.relay.isOpen("jj")).toBe(false);
  });

  it("keeps one line per speaker; the provider's final and end() close lines at once", () => {
    const t = setup();
    t.relay.push("user", " Hi JJ,", false);
    t.relay.push("jj", "Hey!", false);
    t.relay.push("user", " ready.", true);
    expect(t.sent.map((l) => [l.lineId, l.who, l.text, l.final])).toEqual([
      ["user_t1", "user", "Hi JJ,", false],
      ["jj_t2", "jj", "Hey!", false],
      ["user_t1", "user", "Hi JJ, ready.", true],
    ]);
    t.relay.end();
    expect(t.sent.at(-1)).toMatchObject({ lineId: "jj_t2", final: true });
    t.clock.advance(5000);
    expect(t.sent).toHaveLength(4);                         // no timers left behind
  });

  it("splits long lines at a sentence end so captions stay short", () => {
    const t = setup({ maxChars: 60 });
    t.relay.push("jj", "That was a solid first run, well done. ", false);
    t.relay.push("jj", "Next time, slow down on the pricing slide and pause after the number.", false);
    const finals = t.sent.filter((l) => l.final);
    expect(finals).toEqual([{ lineId: "jj_t1", who: "jj", text: "That was a solid first run, well done.", final: true }]);
    t.clock.advance(250);
    expect(t.sent.at(-1)).toMatchObject({ lineId: "jj_t2", text: "Next time, slow down on the pricing slide and pause after the number.", final: false });
  });

  it("ignores empty chunks and never sends an empty line", () => {
    const t = setup();
    t.relay.push("user", "  ", false);
    t.relay.push("user", "", true);
    t.clock.advance(3000);
    expect(t.sent).toEqual([]);
  });
});
