import { describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type DownlinkMessage, type SceneDef, type SessionState } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { placeholderCoach } from "../src/placeholders.ts";
import { SessionStore, type SessionCause } from "../src/session.ts";
import { viewFor } from "../src/views.ts";
import { judge } from "./helpers.ts";

const scene0: SceneDef = {
  version: 1, venueId: "greybox", qa: { questions: 2, answerCapMs: 45_000 },
  judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default",
};
const deck = { deckId: "d", name: "deck", slides: [0, 1, 2, 3].map((i) => ({ index: i, url: `/x/${i}.png`, text: `s${i}` })) };

class FakeStage {
  connected = true;
  sent: DownlinkMessage[] = [];
  isConnected() { return this.connected; }
  send(m: DownlinkMessage) { if (!this.connected) return false; this.sent.push(m); return true; }
  last<T extends DownlinkMessage["type"]>(t: T) { return this.sent.filter((m) => m.type === t).at(-1) as Extract<DownlinkMessage, { type: T }> | undefined; }
}

function setup(opts: { withDeck?: boolean } = {}) {
  const clock = new VirtualClock();
  const stage = new FakeStage();
  let n = 0;
  const store = new SessionStore({ clock, coach: placeholderCoach, venue: GREYBOX_VENUE, stage, initialScene: scene0, newSessionId: () => `sess_${++n}` });
  const causes: SessionCause[] = [];
  store.subscribe((_s, c) => causes.push(c));
  if (opts.withDeck !== false) store.setContext({ deck });
  const d = (a: Parameters<SessionStore["dispatch"]>[0]) => store.dispatch(a);
  const s = () => store.get();
  return { clock, stage, store, causes, d, s };
}

/** Drive to a given point of the loop. */
function to(point: "intro" | "countdown" | "presentation" | "qa" | "debrief") {
  const t = setup();
  t.d({ type: "session_start" });
  if (point === "intro") return t;
  t.d({ type: "start_run" });
  if (point === "countdown") return t;
  t.clock.advance(3000);
  if (point === "presentation") return t;
  t.d({ type: "presentation_done" });
  if (point === "qa") return t;
  t.d({ type: "qa_done" });
  return t;
}

describe("session transitions", () => {
  it("setup + session_start → intro on the first session, deck or not; a run needs the deck", () => {
    const t = setup({ withDeck: false });
    expect(t.d({ type: "session_start" })).toEqual({ ok: true });
    expect(t.s().phase).toBe("intro");
    expect(t.d({ type: "start_run" })).toMatchObject({ ok: false, reason: "no_deck" });
    t.store.setContext({ deck });
    expect(t.d({ type: "session_start" })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("intro + save_brief stays in intro with the brief stored", () => {
    const t = to("intro");
    const brief = { title: "T", audience: "A", goal: "G", keyPoints: ["k"], setting: "pitch" };
    expect(t.d({ type: "save_brief", brief })).toEqual({ ok: true });
    expect(t.s()).toMatchObject({ phase: "intro", context: { brief } });
  });

  it("start_run from intro → countdown with the coach recommendation, slide 0, introDone", () => {
    const t = to("intro");
    expect(t.d({ type: "start_run" })).toEqual({ ok: true });
    expect(t.s().phase).toBe("running");
    expect(t.s().run).toMatchObject({ runId: "run_1", index: 1, mode: "baseline", feedbackLevel: "off", phase: "countdown", slideIndex: 0, sceneVersion: 1, paused: false });
    expect(t.s().introDone).toBe(true);
  });

  it("explicit mode/level win; baseline and test are always off", () => {
    const t = to("intro");
    t.d({ type: "start_run", mode: "training", level: "gentle" });
    expect(t.s().run).toMatchObject({ mode: "training", feedbackLevel: "gentle" });
    t.d({ type: "end_run" });
    t.d({ type: "start_run", mode: "test", level: "strong" });
    expect(t.s().run).toMatchObject({ runId: "run_2", mode: "test", feedbackLevel: "off" });
  });

  it("countdown: 3, 2, 1, 0 a second apart, then presentation", () => {
    const t = to("countdown");
    const ticks = () => t.causes.filter((c): c is { type: "countdown"; secondsLeft: 3 | 2 | 1 | 0 } => !Array.isArray(c) && c.type === "countdown").map((c) => c.secondsLeft);
    expect(ticks()).toEqual([3]);
    t.clock.advance(1000); expect(ticks()).toEqual([3, 2]);
    t.clock.advance(1000); expect(ticks()).toEqual([3, 2, 1]);
    expect(t.s().run!.phase).toBe("countdown");
    t.clock.advance(1000);
    expect(ticks()).toEqual([3, 2, 1, 0]);
    expect(t.s().run).toMatchObject({ phase: "presentation", presentationStartedAt: t.clock.now() });
  });

  it("presentation + presentation_done → qa; with 0 questions straight to ended → debrief", () => {
    const t = to("presentation");
    expect(t.d({ type: "presentation_done" })).toEqual({ ok: true });
    expect(t.s().run!.phase).toBe("qa");

    const u = to("intro");
    u.store["s"].scene.qa.questions = 0;
    u.d({ type: "start_run" }); u.clock.advance(3000);
    u.d({ type: "presentation_done" });
    expect(u.s()).toMatchObject({ phase: "debrief", completedRuns: ["run_1"], run: { phase: "ended" } });
  });

  it("qa + qa_done → ended → debrief (automatic), coach updated and recommendation set", () => {
    const t = to("qa");
    expect(t.d({ type: "qa_done" })).toEqual({ ok: true });
    expect(t.s()).toMatchObject({ phase: "debrief", completedRuns: ["run_1"], run: { phase: "ended", endedAt: t.clock.now() } });
    expect(t.s().coach.recommendation).toMatchObject({ mode: "baseline" });
  });

  it("end_run from any running phase keeps a partial run", () => {
    for (const p of ["countdown", "presentation", "qa"] as const) {
      const t = to(p);
      expect(t.d({ type: "end_run" })).toEqual({ ok: true });
      expect(t.s()).toMatchObject({ phase: "debrief", completedRuns: ["run_1"], run: { phase: "ended" } });
    }
    expect(to("debrief").d({ type: "end_run" })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("abort_run → intro when no run finished yet, debrief otherwise; not reported", () => {
    const t = to("presentation");
    t.d({ type: "abort_run" });
    expect(t.s()).toMatchObject({ phase: "intro", completedRuns: [], run: { phase: "aborted" } });
    t.d({ type: "start_run" });
    expect(t.s().run!.runId).toBe("run_2");
    t.d({ type: "end_run" });
    t.d({ type: "start_run" });
    t.d({ type: "abort_run" });
    expect(t.s()).toMatchObject({ phase: "debrief", completedRuns: ["run_2"] });
  });

  it("wake pauses, resume adds the pause to pausedMs; wake outside runs is a no-op", () => {
    const t = to("presentation");
    expect(t.d({ type: "wake", via: "phrase" })).toEqual({ ok: true });
    expect(t.s().run!.paused).toBe(true);
    expect(t.s().wake).toEqual({ active: true, via: "phrase", since: t.clock.now() });
    expect(t.d({ type: "wake", via: "ptt" })).toEqual({ ok: true });     // already paused
    expect(t.s().wake.via).toBe("phrase");
    t.clock.advance(4200);
    expect(t.d({ type: "resume" })).toEqual({ ok: true });
    expect(t.s().run).toMatchObject({ paused: false, pausedMs: 4200 });
    expect(t.s().wake.active).toBe(false);
    expect(t.d({ type: "resume" })).toMatchObject({ ok: false, reason: "wrong_phase" });

    const u = to("intro");
    const before = u.causes.length;
    expect(u.d({ type: "wake", via: "ptt" })).toEqual({ ok: true });
    expect(u.s().wake.active).toBe(false);
    expect(u.causes.length).toBe(before + 1);
  });

  it("a wake during the countdown pauses the countdown timer too", () => {
    const t = to("countdown");
    t.clock.advance(1500);
    t.d({ type: "wake", via: "ptt" });
    t.clock.advance(10_000);
    expect(t.s().run!.phase).toBe("countdown");
    t.d({ type: "resume" });
    t.clock.advance(1499);
    expect(t.s().run!.phase).toBe("countdown");
    t.clock.advance(1501);
    expect(t.s().run!.phase).toBe("presentation");
  });

  it("ending a paused run counts the pause and clears the wake", () => {
    const t = to("qa");
    t.d({ type: "wake", via: "operator" });
    t.clock.advance(2000);
    t.d({ type: "end_run" });
    expect(t.s().run).toMatchObject({ paused: false, pausedMs: 2000 });
    expect(t.s().wake.active).toBe(false);
  });

  it("run_it_back repeats mode, level and scene version", async () => {
    const t = to("intro");
    t.d({ type: "start_run", mode: "training", level: "gentle" });
    t.d({ type: "end_run" });
    const p = t.store.applyScene([{ op: "audience.set", count: 30 }]);
    const apply = t.stage.last("scene.apply")!;
    t.store.commands.onAck({ batchId: apply.payload.batchId, version: apply.payload.version, ok: true });
    await p;
    expect(t.s().scene.version).toBe(2);
    expect(t.d({ type: "run_it_back" })).toEqual({ ok: true });
    expect(t.s().run).toMatchObject({ runId: "run_2", mode: "training", feedbackLevel: "gentle", sceneVersion: 1, phase: "countdown" });
    const restore = t.stage.last("scene.apply")!;
    expect(restore.payload.ops).toContainEqual({ op: "audience.set", count: 10 });
    expect(to("intro").d({ type: "run_it_back" })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("start_calibration from intro/debrief → calibrating; calibration_done returns", () => {
    const t = to("intro");
    expect(t.d({ type: "start_calibration" })).toEqual({ ok: true });
    expect(t.s().phase).toBe("calibrating");
    const calibration = { yawByJudge: { judge_1: -20 }, neutralPitchDeg: 2, marginDeg: 8 };
    expect(t.d({ type: "calibration_done", calibration })).toEqual({ ok: true });
    expect(t.s()).toMatchObject({ phase: "intro", calibration });
    expect(to("presentation").d({ type: "start_calibration" })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("debrief + show_final → final; start_run and run_it_back work from final", () => {
    const t = to("debrief");
    expect(t.d({ type: "show_final" })).toEqual({ ok: true });
    expect(t.s().phase).toBe("final");
    expect(t.d({ type: "show_final" })).toMatchObject({ ok: false, reason: "wrong_phase" });
    expect(t.d({ type: "run_it_back" })).toEqual({ ok: true });
    t.d({ type: "end_run" }); t.d({ type: "show_final" });
    expect(t.d({ type: "start_run" })).toEqual({ ok: true });
  });

  it("reset → setup with a new session id; uploads and scene kept; next start goes to debrief", () => {
    const t = to("debrief");
    const id = t.s().sessionId;
    expect(t.d({ type: "reset" })).toEqual({ ok: true });
    expect(t.s()).toMatchObject({ phase: "setup", run: null, completedRuns: [], context: { deck } });
    expect(t.s().sessionId).not.toBe(id);
    expect(t.s().scene.judges).toHaveLength(3);
    t.d({ type: "session_start" });
    expect(t.s().phase).toBe("debrief");
  });

  it("slide changes only during the presentation (and countdown), within the deck", () => {
    const t = to("presentation");
    expect(t.d({ type: "slide", index: 3, from: "stage" })).toEqual({ ok: true });
    expect(t.s().run!.slideIndex).toBe(3);
    expect(t.d({ type: "slide", index: 4 })).toMatchObject({ ok: false, reason: "invalid_args" });
    t.d({ type: "presentation_done" });
    expect(t.d({ type: "slide", index: 1 })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("targets, level and categories", () => {
    const t = to("debrief");
    expect(t.d({ type: "set_targets", targets: ["arms_crossed", "filler_burst"] })).toEqual({ ok: true });
    expect(t.s().coach).toMatchObject({ stage: "training", level: "strong", targets: [{ kind: "arms_crossed", status: "learning" }, { kind: "filler_burst" }] });
    expect(t.d({ type: "set_targets", targets: ["long_pause"] as never })).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(t.d({ type: "set_level", level: "gentle" })).toEqual({ ok: true });
    expect(t.s().coach).toMatchObject({ level: "gentle", stage: "fading" });
    t.d({ type: "start_run" });
    expect(t.s().run).toMatchObject({ mode: "training", feedbackLevel: "gentle", targets: ["arms_crossed", "filler_burst"] });
    expect(t.d({ type: "set_categories", enabled: ["posture", "posture"] })).toEqual({ ok: true });
    expect(t.s().enabledCategories).toEqual(["posture"]);
    expect(setup().d({ type: "set_targets", targets: [] })).toMatchObject({ ok: false, reason: "wrong_phase" });
  });

  it("rejects malformed actions with invalid_args and leaves state untouched", () => {
    const t = to("intro");
    const before = JSON.stringify(t.s());
    expect(t.d({ type: "start_run", mode: "warmup" } as never)).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(t.d({ type: "teleport" } as never)).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(JSON.stringify(t.s())).toBe(before);
  });

  it("refused actions do not notify subscribers", () => {
    const t = to("intro");
    const n = t.causes.length;
    t.d({ type: "qa_done" });
    expect(t.causes.length).toBe(n);
  });
});

describe("viewFor", () => {
  const base = () => setup().s();
  const withPhase = (p: Partial<SessionState>, run?: Partial<NonNullable<SessionState["run"]>>): SessionState => {
    const s = structuredClone(base()) as SessionState;
    Object.assign(s, p);
    if (run) s.run = { runId: "run_1", index: 1, mode: "baseline", feedbackLevel: "off", targets: [], enabledCategories: [], sceneVersion: 1, phase: "presentation", slideIndex: 0, paused: false, pausedMs: 0, ...run };
    return s;
  };
  const rows: [string, SessionState, string, { visible: boolean; placement?: string }][] = [
    ["setup", withPhase({ phase: "setup" }), "setup", { visible: false }],
    ["intro", withPhase({ phase: "intro" }), "jj", { visible: true, placement: "center" }],
    ["calibrating", withPhase({ phase: "calibrating" }), "jj", { visible: true, placement: "center" }],
    ["running: countdown", withPhase({ phase: "running" }, { phase: "countdown" }), "slides", { visible: false }],
    ["running: presentation", withPhase({ phase: "running" }, { phase: "presentation" }), "slides", { visible: false }],
    ["running: presentation, woken", withPhase({ phase: "running" }, { phase: "presentation", paused: true }), "slides", { visible: true, placement: "corner" }],
    ["running: qa", withPhase({ phase: "running" }, { phase: "qa" }), "room", { visible: false }],
    ["running: qa, woken", withPhase({ phase: "running" }, { phase: "qa", paused: true }), "room", { visible: true, placement: "corner" }],
    ["running: ended", withPhase({ phase: "running" }, { phase: "ended" }), "report", { visible: true, placement: "side" }],
    ["debrief", withPhase({ phase: "debrief" }), "report", { visible: true, placement: "side" }],
    ["final", withPhase({ phase: "final" }), "final", { visible: true, placement: "side" }],
  ];
  for (const [name, s, view, orb] of rows) {
    it(`${name} → ${view}, orb ${orb.visible ? orb.placement : "hidden"}`, () => {
      const v = viewFor(s);
      expect(v.view).toBe(view);
      expect(v.orb.visible).toBe(orb.visible);
      if (orb.placement) expect(v.orb.placement).toBe(orb.placement);
      expect(v.orb.score).toBe(s.coach.score);
    });
  }

  it("the store keeps state.view in sync with viewFor", () => {
    const t = to("qa");
    expect(t.s().view).toBe("room");
    t.d({ type: "qa_done" });
    expect(t.s().view).toBe("report");
  });
});

describe("scene commands", () => {
  const ack = (t: ReturnType<typeof setup>, ok = true) => {
    const m = t.stage.last("scene.apply")!;
    t.store.commands.onAck(ok ? { batchId: m.payload.batchId, version: m.payload.version, ok: true } : { batchId: m.payload.batchId, ok: false, error: "nope" });
  };

  it("commits only after the main app acks, then notifies", async () => {
    const t = setup();
    const p = t.store.applyScene([{ op: "judge.update", id: "judge_2", patch: { toughness: 0.9 } }]);
    expect(t.stage.last("scene.apply")!.payload).toMatchObject({ version: 2, ops: [{ op: "judge.update" }] });
    expect(t.s().scene.version).toBe(1);
    expect(t.s().scene.judges[1]!.toughness).toBe(0.5);
    ack(t);
    expect(await p).toEqual({ ok: true, version: 2 });
    expect(t.s().scene).toMatchObject({ version: 2 });
    expect(t.s().scene.judges[1]!.toughness).toBe(0.9);
    expect(t.causes.at(-1)).toEqual([{ op: "judge.update", id: "judge_2", patch: { toughness: 0.9 } }]);
    expect(t.store.commands.log.at(-1)).toMatchObject({ status: "acked", version: 2 });
  });

  it("a main app that never acks triggers rollback (scene.sync) and stage_timeout", async () => {
    const t = setup();
    const p = t.store.applyScene([{ op: "audience.set", count: 40 }]);
    t.clock.advance(1999);
    expect(t.stage.last("scene.sync")).toBeUndefined();
    t.clock.advance(1);
    expect(await p).toMatchObject({ ok: false, reason: "stage_timeout" });
    const sync = t.stage.last("scene.sync")!;
    expect(sync.payload.scene).toMatchObject({ version: 1, audience: { count: 10 } });
    expect(sync.payload.venue.id).toBe("greybox");
    expect(sync.payload.deck).toEqual(deck);
    expect(t.s().scene.audience.count).toBe(10);
    expect(t.store.commands.log.at(-1)).toMatchObject({ status: "failed", error: "ack timeout" });
  });

  it("ack ok:false rolls back and returns invalid_args", async () => {
    const t = setup();
    const p = t.store.applyScene([{ op: "lighting.set", preset: "dim", transitionMs: 500 }]);
    ack(t, false);
    expect(await p).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(t.stage.last("scene.sync")).toBeDefined();
    expect(t.s().scene.lighting).toBe("default");
  });

  it("stage offline → stage_offline, nothing sent", async () => {
    const t = setup();
    t.stage.connected = false;
    expect(await t.store.applyScene([{ op: "audience.set", count: 3 }])).toMatchObject({ ok: false, reason: "stage_offline" });
    expect(t.store.commands.log).toHaveLength(0);
  });

  it("semantic checks: seats must exist, ids and seats unique, 1-5 judges", async () => {
    const t = setup();
    const bad = [
      [{ op: "judges.set", judges: [judge(1, { seat: "judge_seat_5" })] }],   // no such seat
      [{ op: "judges.set", judges: [judge(1), judge(1, { seat: "judge_seat_2" })] }],
      [{ op: "judges.set", judges: [judge(1), judge(2, { seat: "judge_seat_1" })] }],
      [{ op: "judges.set", judges: [] }],
      [{ op: "judge.update", id: "judge_5", patch: { toughness: 1 } }],
      [{ op: "judge.update", id: "judge_1", patch: { toughness: 3 } }],
      [],
    ] as const;
    for (const ops of bad) expect(await t.store.applyScene(ops as never), JSON.stringify(ops)).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await t.store.applyScene([{ op: "venue.set", venueId: "lecture_hall" }])).toMatchObject({ ok: false, reason: "not_available" });
    expect(t.stage.sent.filter((m) => m.type === "scene.apply")).toHaveLength(0);
  });

  it("judges.set is refused during Q&A; other ops are fine", async () => {
    const t = to("qa");
    expect(await t.store.applyScene([{ op: "judges.set", judges: [judge(1)] }])).toMatchObject({ ok: false, reason: "wrong_phase" });
    const p = t.store.applyScene([{ op: "judge.update", id: "judge_1", patch: { style: "warm" } }]);
    ack(t);
    expect(await p).toMatchObject({ ok: true });
  });

  it("serialises batches: one in flight, the next waits for its ack", async () => {
    const t = setup();
    const p1 = t.store.applyScene([{ op: "audience.set", count: 1 }]);
    const p2 = t.store.applyScene([{ op: "audience.set", count: 2 }]);
    expect(t.stage.sent.filter((m) => m.type === "scene.apply")).toHaveLength(1);
    ack(t);
    expect(await p1).toEqual({ ok: true, version: 2 });
    expect(t.stage.last("scene.apply")!.payload).toMatchObject({ version: 3, ops: [{ count: 2 }] });
    ack(t);
    expect(await p2).toEqual({ ok: true, version: 3 });
    expect(t.s().scene.audience.count).toBe(2);
  });

  it("ignores stale or mismatched acks", async () => {
    const t = setup();
    const p = t.store.applyScene([{ op: "audience.set", count: 5 }]);
    const m = t.stage.last("scene.apply")!;
    t.store.commands.onAck({ batchId: "other", version: 2, ok: true });
    t.store.commands.onAck({ batchId: m.payload.batchId, version: 99, ok: true });
    expect(t.store.commands.pendingCount()).toBe(1);
    ack(t);
    expect(await p).toMatchObject({ ok: true });
  });
});
