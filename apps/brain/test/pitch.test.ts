import { describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type RunId, type SceneDef } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { placeholderCoach } from "../src/placeholders.ts";
import { buildPitchDashboard, PitchMode, pitchHttp } from "../src/pitch.ts";
import type { RunRecord } from "../src/runlog.ts";
import { SessionStore } from "../src/session.ts";
import type { Phrase } from "../src/swarm/board.ts";
import { judge } from "./helpers.ts";

const scene0: SceneDef = {
  version: 1, venueId: "greybox", qa: { questions: 2, answerCapMs: 45_000 },
  judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default",
};

function setup() {
  const clock = new VirtualClock();
  const stage = { isConnected: () => true, send: () => true };
  const session = new SessionStore({ clock, coach: placeholderCoach, venue: GREYBOX_VENUE, stage, initialScene: scene0 });
  const silent: boolean[] = [];
  const pitch = new PitchMode({
    session, clock, runLog: { get: () => null, list: () => [] }, phrases: () => [],
    jj: { setSilent: (on) => { silent.push(on); } },
  });
  return { clock, session, pitch, silent };
}

describe("pitch mode: the session", () => {
  it("starts from setup without a deck, listens at once, can't be paused, and ends without Q&A", () => {
    const t = setup();
    expect(t.session.get().context.deck).toBeNull();
    expect(t.pitch.start()).toMatchObject({ ok: true, runId: "run_1" });
    expect(t.silent).toEqual([true]);
    const run = t.session.get().run!;
    expect(t.session.get().phase).toBe("running");
    expect(run).toMatchObject({ pitch: true, phase: "presentation", mode: "baseline", feedbackLevel: "off" });
    expect(run.presentationStartedAt).toBe(run.startedAt);
    expect(t.pitch.start()).toMatchObject({ ok: true, runId: "run_1" });   // double click: the same run
    expect(t.pitch.exit()).toMatchObject({ ok: false, reason: "wrong_phase" });   // JJ stays out during the talk
    t.session.dispatch({ type: "wake", via: "phrase" });                   // "Hey JJ" in the pitch
    expect(t.session.get().run!.paused).toBe(false);
    t.clock.advance(90_000);
    t.session.dispatch({ type: "presentation_done" });                     // a "slides done" key: no Q&A
    expect(t.session.get().phase).toBe("debrief");
    expect(t.session.get().run!.phase).toBe("ended");
    expect(t.pitch.stop()).toMatchObject({ ok: true, runId: "run_1" });
    expect(t.pitch.start()).toMatchObject({ ok: true, runId: "run_2" });   // another pitch after the dashboard
    expect(t.pitch.stop()).toMatchObject({ ok: true, runId: "run_2" });
    expect(t.session.get().completedRuns).toEqual(["run_1", "run_2"]);
    expect(t.pitch.exit()).toEqual({ ok: true });
    expect(t.silent).toEqual([true, true, false]);   // the double click changed nothing
  });

  it("stop without a pitch says so; a normal run is not a pitch", () => {
    const t = setup();
    expect(t.pitch.stop()).toMatchObject({ ok: false, reason: "not_available" });
    expect(t.pitch.dashboard()).toBeNull();
  });

  it("the coaching loop gives JJ its voice back: a reset, a session start, a normal run", () => {
    const t = setup();
    t.pitch.start();
    t.pitch.stop();
    expect(t.silent).toEqual([true]);
    t.session.dispatch({ type: "reset", full: true });                     // the pitch page closed, then "Delete and start over"
    expect(t.silent).toEqual([true, false]);
    t.pitch.start();
    t.pitch.stop();
    t.session.setContext({ deck: { deckId: "d", name: "d", slides: [{ index: 0, url: "/x/0.png", text: "" }] } });
    t.session.dispatch({ type: "start_run" });                              // JJ's loop again
    expect(t.silent).toEqual([true, false, true, false]);
  });
});

describe("pitch mode: the dashboard", () => {
  const T0 = 1_000_000;
  const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
    runId: "run_1" as RunId,
    run: { runId: "run_1" as RunId, index: 1, mode: "baseline", feedbackLevel: "off", targets: [], enabledCategories: [], sceneVersion: 1,
      phase: "ended", slideIndex: 0, paused: false, pausedMs: 0, startedAt: T0, presentationStartedAt: T0, endedAt: T0 + 120_000, pitch: true },
    slides: [], observations: [], feedback: [], wakes: 0, qa: [], coachConnected: true, qaStartedAt: null,
    endedAt: T0 + 120_000, endedBy: null,
    episodes: [
      { kind: "arms_crossed", startAt: T0 + 10_000, endAt: T0 + 22_000, slideIndex: 0, segment: "presentation", conf: 1 },
      { kind: "arms_crossed", startAt: T0 + 60_000, endAt: T0 + 66_000, slideIndex: 0, segment: "presentation", conf: 1 },
      { kind: "sway", startAt: T0 + 30_000, endAt: T0 + 33_000, slideIndex: 0, segment: "presentation", conf: 1 },
    ],
    ...over,
  });
  const phrase = (s: number, text: string, fillers: string[] = []): Phrase =>
    ({ runId: "run_1" as RunId, segment: "presentation", text, fillers, startAt: T0 + s * 1000, endAt: T0 + s * 1000 + 3000, slideIndex: 0 });

  it("speech: words per minute, fillers with their moments; body: count, time and share per behaviour", () => {
    const phrases = [
      phrase(2, "um so we built a coach for presenters", ["um"]),
      phrase(40, "uh it listens and um watches", ["uh", "um"]),
      phrase(80, "and you get this dashboard"),
    ];
    const d = buildPitchDashboard(rec(), phrases, T0 + 200_000);
    expect(d).toMatchObject({ runId: "run_1", live: false, durationMs: 120_000 });
    expect(d.speech).toMatchObject({ measured: true, words: 19, wpm: 10 });
    expect(d.speech.fillers).toMatchObject({ count: 3, perMin: 1.5, top: [{ word: "um", count: 2 }, { word: "uh", count: 1 }] });
    expect(d.speech.fillers.at).toEqual([{ tMs: 2000, words: ["um"] }, { tMs: 40_000, words: ["uh", "um"] }]);
    expect(d.body.rows.map((r) => [r.kind, r.count, r.totalMs, r.pct])).toEqual([["arms_crossed", 2, 18_000, 15], ["sway", 1, 3000, 2.5]]);
    expect(d.body.rows[0]).toMatchObject({ label: "Crossed arms", longestMs: 12_000, episodes: [{ fromMs: 10_000, toMs: 22_000 }, { fromMs: 60_000, toMs: 66_000 }] });
  });

  it("while the talk goes on it is live and counts up to now; no transcript = not measured", () => {
    const d = buildPitchDashboard(rec({ endedAt: null, episodes: [] }), [], T0 + 30_000);
    expect(d).toMatchObject({ live: true, durationMs: 30_000 });
    expect(d.speech).toMatchObject({ measured: false, words: 0, wpm: null, fillers: { count: 0, perMin: null } });
  });

  it("HTTP: start, stop, dashboard, exit", async () => {
    const t = setup();
    const routes = pitchHttp(t.pitch);
    const call = (method: string, url: string) => new Promise<{ status: number; body: unknown }>((resolve) => {
      let status = 0;
      const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => resolve({ status, body: JSON.parse(b) }) };
      if (!routes({ method, url } as never, res as never)) resolve({ status: 0, body: null });
    });
    expect(await call("POST", "/api/pitch/start")).toMatchObject({ status: 200, body: { ok: true, runId: "run_1" } });
    expect(await call("POST", "/api/pitch/stop")).toMatchObject({ status: 200, body: { ok: true, runId: "run_1" } });
    expect(await call("GET", "/api/pitch/dashboard")).toMatchObject({ status: 404 });   // this test's run log is empty
    expect(await call("POST", "/api/pitch/exit")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await call("GET", "/api/other")).toMatchObject({ status: 0 });
  });
});
