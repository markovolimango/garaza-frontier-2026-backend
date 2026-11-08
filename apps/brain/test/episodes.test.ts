/** Behaviour episodes in the brain: `behavior` start/end → RunLog → digest, progress, coach policy, persistence. */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type BehaviorKind, type ClientRole, type Deck, type SceneDef } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { buildDigest } from "../src/digest.ts";
import { observedCoach } from "../src/observedCoach.ts";
import { loadLatest, SessionPersistence } from "../src/persist.ts";
import { buildProgress } from "../src/progress.ts";
import { behaviorCounts, RunLog } from "../src/runlog.ts";
import { SessionStore } from "../src/session.ts";
import { judge } from "./helpers.ts";

const DECK: Deck = { deckId: "deck_abc", name: "acme", slides: [0, 1, 2].map((i) => ({ index: i, url: `/api/decks/deck_abc/${i}.png`, text: `slide ${i}` })) };
const SCENE: SceneDef = { version: 1, venueId: "greybox", qa: { questions: 0, answerCapMs: 45_000 }, judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default" };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function rig(o: { sensor?: boolean; dir?: string } = {}) {
  const clock = new VirtualClock();
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  let n = 0;
  const store = new SessionStore({
    clock, coach, venue: GREYBOX_VENUE, initialScene: SCENE, newSessionId: () => `sess${++n}`,
    stage: { isConnected: () => true, send: () => true },
  });
  const inbound = new Map<string, (m: { payload: unknown }, role: ClientRole) => void>();
  const hub = {
    on: (type: string, fn: (m: { payload: unknown }, role: ClientRole) => void) => { inbound.set(type, fn); },
    onOutbound: () => {},
    connections: () => ({ stage: true, sensor: o.sensor ?? true, operator: false }),
  };
  runLog = new RunLog({ session: store, hub: hub as never, clock });
  const persistence = o.dir ? new SessionPersistence({ dir: o.dir, session: store, runLog, clock }) : null;
  const behavior = (kind: BehaviorKind, phase: "start" | "end", clientTs = clock.now()) =>
    inbound.get("behavior")!({ payload: { kind, phase, clientTs, conf: 1 } }, "sensor");
  const observe = (rule: string, kind: BehaviorKind | null) =>
    inbound.get("coach.observation")!({ payload: { rule, kind, category: "posture", text: rule, clientTs: 0 } }, "sensor");
  /** An episode of `ms` that started `ago` ms before now (as the coach back-dates its starts). */
  const episode = (kind: BehaviorKind, ms: number) => { behavior(kind, "start"); clock.advance(ms); behavior(kind, "end"); };
  const start = (args: { mode?: "training"; level?: "strong" } = {}) => {
    expect(store.dispatch({ type: "start_run", ...args })).toEqual({ ok: true });
    clock.advance(3000);
  };
  const finish = () => expect(store.dispatch({ type: "presentation_done" })).toEqual({ ok: true });
  store.setContext({ deck: DECK });
  store.dispatch({ type: "session_start" });
  return { clock, store, runLog, persistence, behavior, observe, episode, start, finish };
}

describe("behaviour episodes in the run log", () => {
  it("pairs start and end per kind, keeps the sender's times and the slide, several kinds at once", () => {
    const t = rig();
    t.start();
    const runStart = t.clock.now();
    t.clock.advance(10_000);
    t.behavior("arms_crossed", "start", t.clock.now() - 1_000);   // back-dated by the coach
    t.store.dispatch({ type: "slide", index: 1, from: "stage" });
    t.clock.advance(2_000);
    t.behavior("looking_down", "start");
    t.behavior("arms_crossed", "start");                          // already open: ignored
    t.clock.advance(5_000);
    t.behavior("arms_crossed", "end", t.clock.now() - 500);
    t.clock.advance(1_000);
    t.behavior("looking_down", "end");
    const eps = t.runLog.latest()!.episodes;
    expect(eps.map((e) => [e.kind, e.startAt - runStart, e.endAt! - runStart, e.slideIndex])).toEqual([
      ["arms_crossed", 9_000, 16_500, 0], ["looking_down", 12_000, 18_000, 1]]);
  });

  it("ignores starts outside a run, closes open episodes at the run end, and distrusts far-off clocks", () => {
    const t = rig();
    t.behavior("sway", "start");                                  // no run yet
    t.start();
    t.behavior("sway", "start", 42);                              // clock far off → arrival time
    const at = t.clock.now();
    t.clock.advance(4_000);
    t.finish();
    t.behavior("sway", "end");                                    // after the run: already closed
    const rec = t.runLog.latest()!;
    expect(rec.episodes).toEqual([expect.objectContaining({ kind: "sway", startAt: at, endAt: rec.endedAt })]);
  });

  it("the digest gives counts, time and the exact moments; observations of the same rule do not double", () => {
    const t = rig();
    t.start();
    t.clock.advance(60_000);
    t.episode("arms_crossed", 7_000);
    t.observe("body.arms_crossed", "arms_crossed");               // the throttled rule fired for the same thing
    t.clock.advance(20_000);
    t.episode("arms_crossed", 3_000);
    t.clock.advance(10_000);
    t.finish();
    const d = buildDigest(t.runLog.latest()!, null);
    const row = d.observations.find((o) => o.rule === "body.arms_crossed")!;
    expect(row).toMatchObject({ kind: "arms_crossed", category: "posture", label: "Crossed arms", count: 2,
      time: { totalMs: 10_000, longestMs: 7_000, pct: 10 } });
    expect(row.examples.map((e) => [e.tRunMs, e.durationMs, e.text])).toEqual([
      [60_000, 7_000, "held 7 s (until 1:07)"], [87_000, 3_000, "held 3 s (until 1:30)"]]);
    expect(behaviorCounts(t.runLog.latest()!).get("arms_crossed")).toBe(2);
  });

  it("progress compares runs per minute and by share of time", () => {
    const t = rig();
    t.start();                                                    // baseline: 2 min, 4 episodes of 15 s
    for (let i = 0; i < 4; i++) { t.clock.advance(15_000); t.episode("arms_crossed", 15_000); }
    t.finish();
    expect(t.store.get().coach.targets.map((x) => x.kind)).toEqual(["arms_crossed"]);   // picked from episodes
    t.start();                                                    // training: 1 min, 1 episode of 3 s
    t.clock.advance(30_000); t.episode("arms_crossed", 3_000); t.clock.advance(27_000);
    t.finish();
    const row = buildProgress(t.runLog.list(), t.store.get()).rows[0]!;
    expect(row).toMatchObject({ rule: "body.arms_crossed", counts: [4, 1], perMin: [2, 1], timePct: [50, 5], trend: "better", isTarget: true });
  });
});

describe("the observed coach with episodes", () => {
  it("a target is clean only in a run the camera coach measured", () => {
    const t = rig({ sensor: false });
    t.start();
    t.clock.advance(30_000);
    t.finish();
    expect(t.store.dispatch({ type: "set_targets", targets: ["arms_crossed"] })).toEqual({ ok: true });
    t.start();                                                    // training, no camera coach connected
    t.clock.advance(30_000);
    t.finish();
    expect(t.store.get().coach.targets).toEqual([expect.objectContaining({ kind: "arms_crossed", status: "learning", cleanStreak: 0 })]);
  });

  it("a measured run without the target's episodes fixes it", () => {
    const t = rig();
    t.start(); t.episode("face_touch", 2_000); t.clock.advance(30_000); t.finish();
    t.start(); t.clock.advance(30_000); t.finish();
    expect(t.store.get().coach.targets).toEqual([expect.objectContaining({ kind: "face_touch", status: "learning", cleanStreak: 0 })]);
    expect(t.store.get().coach.stage).toBe("fading");             // all targets fixed → next stage (streaks reset)
  });
});

describe("episodes are saved", () => {
  it("survive a restart, and files saved before episodes existed still load", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-episodes-")); dirs.push(dir);
    const a = rig({ dir });
    a.start(); a.episode("sway", 4_000); a.finish();
    a.persistence!.saveNow();
    const saved = loadLatest(dir)!;
    expect(saved.runs[0]!.episodes).toEqual([expect.objectContaining({ kind: "sway", segment: "presentation" })]);

    const old = structuredClone(saved) as unknown as { runs: Record<string, unknown>[] };
    delete old.runs[0]!.episodes;
    mkdirSync(join(dir, "old"), { recursive: true });
    writeFileSync(join(dir, "old", "session.json"), JSON.stringify(old));
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ sessionId: "old", savedAt: 1 }));
    expect(loadLatest(dir)!.runs[0]!.episodes).toEqual([]);
  });
});

describe("the end of a session: report export and delete", () => {
  const brief = { title: "Acme seed pitch", audience: "investors", goal: "a second meeting", keyPoints: ["traction"], setting: "investor pitch",
    presenterGoals: ["I freeze up when people stare at me"] };

  it("the export has the numbers run by run, never the presenter's personal goals", async () => {
    const { buildExportHtml, exportHttp } = await import("../src/export.ts");
    const t = rig();
    expect(t.store.dispatch({ type: "save_brief", brief })).toEqual({ ok: true });
    t.start(); for (let i = 0; i < 3; i++) { t.clock.advance(10_000); t.episode("arms_crossed", 10_000); } t.finish();
    t.start(); t.clock.advance(30_000); t.episode("arms_crossed", 2_000); t.clock.advance(28_000); t.finish();
    const html = buildExportHtml(t.store.get(), t.runLog.list(), t.clock.now());
    expect(html).toContain("Presentation practice: Acme seed pitch");
    expect(html).toContain("Crossed arms 3 → 1");
    expect(html).toMatch(/<b>3×<\/b><br><small>3\/min · 50% of time<\/small>/);
    expect(html).not.toContain("freeze");
    let headers: Record<string, string> = {};
    const handled = exportHttp(t.runLog, () => t.store.get())({ method: "GET", url: "/api/session/export.html?download=1" } as never,
      { writeHead: (_: number, h: Record<string, string>) => { headers = h; }, end: () => {} } as never);
    expect(handled).toBe(true);
    expect(headers["content-disposition"]).toBe('attachment; filename="report-Acme-seed-pitch.html"');
  });

  it("JJ's final gets first → last per behaviour", async () => {
    const { compactProgress } = await import("../src/progress.ts");
    const t = rig();
    t.start(); t.episode("looking_down", 30_000); t.clock.advance(30_000); t.finish();
    t.start(); t.clock.advance(60_000); t.finish();
    const c = compactProgress(buildProgress(t.runLog.list(), t.store.get()));
    expect(c.behaviours).toEqual([{ label: "Looking down", target: true, status: "learning", trend: "better",
      first: { run: 1, count: 1, per_min: 1, pct_of_time: 50 }, last: { run: 2, count: 0, per_min: 0, pct_of_time: 0 } }]);
  });

  it("a full reset erases the previous session from disk; keepData and a partial reset don't", async () => {
    const { existsSync } = await import("node:fs");
    const { PassThrough } = await import("node:stream");
    const { sessionHttp } = await import("../src/persist.ts");
    const dir = mkdtempSync(join(tmpdir(), "brain-reset-")); dirs.push(dir);
    const reset = async (t: ReturnType<typeof rig>, body: unknown) => {
      const req = Object.assign(new PassThrough(), { method: "POST", url: "/api/session/reset" });
      let out = "";
      const done = sessionHttp({ session: t.store, runLog: t.runLog, persistence: t.persistence })(req as never, { writeHead: () => {}, end: (b: string) => { out = b; } } as never);
      req.end(JSON.stringify(body));
      await done;
      return JSON.parse(out) as { deleted: boolean };
    };
    const t = rig({ dir });
    t.store.dispatch({ type: "save_brief", brief });
    t.start(); t.episode("sway", 3_000); t.finish();
    t.persistence!.saveNow();
    expect(existsSync(join(dir, "sess1", "session.json"))).toBe(true);
    expect(await reset(t, { full: false })).toMatchObject({ deleted: false });           // keeps the deck: sess1 stays
    expect(await reset(t, { full: true, keepData: true })).toMatchObject({ deleted: false });   // sess2 stays
    expect([existsSync(join(dir, "sess1")), existsSync(join(dir, "sess2"))]).toEqual([true, true]);
    expect(await reset(t, {})).toMatchObject({ deleted: true });                        // erases sess3
    expect([existsSync(join(dir, "sess3")), existsSync(join(dir, "sess4", "session.json"))]).toEqual([false, true]);
    expect(loadLatest(dir)!.state.sessionId).toBe("sess4");
  });
});
