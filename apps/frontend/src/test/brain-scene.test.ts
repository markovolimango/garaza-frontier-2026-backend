import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JudgeDef, SceneDef } from "@coach/protocol";
import { applySceneOps, gazeFor, panelFromScene, seatIndex } from "../brain/scene";
import { JudgeRelay } from "../brain/judges";
import { DEFAULT_JUDGES, seatedJudges } from "../judges/JudgesScene";
import type { JudgeCommand } from "../signals/judges";

const judge = (n: number, over: Partial<JudgeDef> = {}): JudgeDef => ({
  id: `judge_${n}` as JudgeDef["id"], title: `Judge ${n}`, background: "", seat: `judge_seat_${n}`, voiceId: "v", toughness: 0.5, style: "neutral", priorities: [], ...over,
});
const scene: SceneDef = {
  version: 1, venueId: "greybox", qa: { questions: 3, answerCapMs: 45_000 }, audience: { count: 10 }, lighting: "default",
  judges: [judge(1, { title: "Customer advocate" }), judge(2, { title: "Startup mentor" }), judge(3, { title: "VC investor" }), judge(4, { title: "Technical expert" })],
};

describe("stage scene copy (scene.sync + scene.apply)", () => {
  it("applies every op kind without touching the input", () => {
    const next = applySceneOps(scene, [
      { op: "judge.update", id: "judge_3", patch: { title: "Angel investor", toughness: 0.9 } },
      { op: "audience.set", count: 20 },
      { op: "lighting.set", preset: "dim", transitionMs: 500 },
      { op: "qa.set", qa: { questions: 1, answerCapMs: 30_000 } },
    ], 2);
    expect(next.version).toBe(2);
    expect(next.judges[2]).toMatchObject({ id: "judge_3", title: "Angel investor", toughness: 0.9, style: "neutral" });
    expect([next.audience.count, next.lighting, next.qa.questions]).toEqual([20, "dim", 1]);
    expect(scene.judges[2]!.title).toBe("VC investor");
    expect(applySceneOps(scene, [{ op: "judges.set", judges: [judge(1), judge(2), judge(3)] }], 3).judges).toHaveLength(3);
  });

  it("seats judge_seat_K in seat K-1; seats the room doesn't have are skipped", () => {
    expect([seatIndex("judge_seat_1"), seatIndex("judge_seat_4"), seatIndex("judge_seat_5"), seatIndex("podium")]).toEqual([0, 3, null, null]);
    const three = applySceneOps(scene, [{ op: "judges.set", judges: [judge(2, { seat: "judge_seat_3", title: "CTO" }), judge(1, { title: "CFO" }), judge(5, { seat: "judge_seat_5" })] }], 2);
    expect(panelFromScene(three)).toEqual([{ seat: 0, actorId: "judge_1", title: "CFO" }, { seat: 2, actorId: "judge_2", title: "CTO" }]);
    expect(panelFromScene(scene).map((s) => s.title)).toEqual(["Customer advocate", "Startup mentor", "VC investor", "Technical expert"]);
  });

  it("seatedJudges: the default look per seat, a nameplate title, empty seats null", () => {
    const seats = seatedJudges([{ seat: 0, title: "CFO" }, { seat: 2, title: "CTO" }]);
    expect(seats.map((s) => s?.title ?? null)).toEqual(["CFO", null, "CTO", null]);
    expect(seats[2]).toMatchObject({ position: DEFAULT_JUDGES[2]!.position, tint: DEFAULT_JUDGES[2]!.tint });
  });

  it("maps look targets: presenter/notes/audience as is, a judge to its seat, unseated judges to null", () => {
    const seatOf = (id: string) => (id === "judge_2" ? 2 : null);
    expect([gazeFor("presenter", seatOf), gazeFor("notes", seatOf), gazeFor("audience", seatOf), gazeFor("judge_2", seatOf), gazeFor("judge_5", seatOf)]).toEqual(["presenter", "notes", "audience", 2, null]);
  });
});

describe("JudgeRelay addresses judges by their seat in the brain's panel", () => {
  let out: JudgeCommand[];
  let relay: JudgeRelay;
  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    relay = new JudgeRelay({ publish: (c) => out.push(c), level: () => 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("before any panel judge_N sits in seat N; afterwards the panel decides", () => {
    expect(relay.seatOf("judge_2")).toBe(1);
    relay.setPanel([{ seat: 0, actorId: "judge_1", title: "CFO" }, { seat: 2, actorId: "judge_2", title: "CTO" }]);
    expect([relay.seatOf("judge_1"), relay.seatOf("judge_2"), relay.seatOf("judge_3")]).toEqual([0, 2, null]);
    relay.gesture({ actorId: "judge_2", gesture: "nod" });
    relay.gesture({ actorId: "judge_3", gesture: "nod" });   // not seated: nothing
    relay.say({ actorId: "judge_2", utteranceId: "u", source: 2, text: "Who pays?" });
    vi.runAllTimers();
    expect(out).toEqual([{ type: "react", judge: 2, reaction: "nod" }, { type: "say", judge: 2, text: "Who pays?" }]);
  });

  it("actor.lookAt → judgeCommand look (to the presenter, the notes or another seated judge)", () => {
    relay.setPanel([{ seat: 0, actorId: "judge_1", title: "CFO" }, { seat: 1, actorId: "judge_2", title: "CTO" }, { seat: 3, actorId: "judge_4", title: "CEO" }]);
    relay.lookAt({ actorId: "judge_1", target: "judge_4" });
    relay.lookAt({ actorId: "judge_4", target: "presenter" });
    relay.lookAt({ actorId: "judge_2", target: "notes" });
    relay.lookAt({ actorId: "judge_2", target: "judge_3" });   // judge_3 has no seat: ignored
    relay.lookAt({ actorId: "judge_5", target: "presenter" }); // judge_5 has no seat: ignored
    expect(out).toEqual([
      { type: "look", judge: 0, target: 3 },
      { type: "look", judge: 3, target: "presenter" },
      { type: "look", judge: 1, target: "notes" },
    ]);
  });
});
