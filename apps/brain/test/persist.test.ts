import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type ClientRole, type Deck, type DownlinkMessage, type SceneDef, type SessionState } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { Uploads } from "../src/context/uploads.ts";
import { observedCoach } from "../src/observedCoach.ts";
import { loadLatest, SessionPersistence, sessionHttp } from "../src/persist.ts";
import { buildProgress, progressHttp } from "../src/progress.ts";
import { RunLog, type RunRecord } from "../src/runlog.ts";
import { SessionStore } from "../src/session.ts";
import { judge } from "./helpers.ts";

const DECK: Deck = { deckId: "deck_abc", name: "acme", slides: [0, 1, 2].map((i) => ({ index: i, url: `/api/decks/deck_abc/${i}.png`, text: `slide ${i}` })) };
const SCENE: SceneDef = { version: 1, venueId: "greybox", qa: { questions: 0, answerCapMs: 45_000 }, judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default" };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "brain-persist-")); dirs.push(d); return d; };

/** A session store + run log over a fake hub, optionally continuing a saved session. */
function rig(o: { restore?: { state: SessionState; runs: RunRecord[] }; sensor?: boolean; dir?: string } = {}) {
  const clock = new VirtualClock();
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  let n = 0;
  const store = new SessionStore({
    clock, coach, venue: GREYBOX_VENUE, initialScene: SCENE, newSessionId: () => `sess${++n}`,
    stage: { isConnected: () => true, send: () => true }, ...(o.restore ? { restore: o.restore.state } : {}),
  });
  const inbound = new Map<string, (m: { payload: unknown }, role: ClientRole) => void>();
  const hub = {
    on: (type: string, fn: (m: { payload: unknown }, role: ClientRole) => void) => { inbound.set(type, fn); },
    onOutbound: (_fn: (m: DownlinkMessage, roles: ClientRole[]) => void) => {},
    connections: () => ({ stage: true, sensor: o.sensor ?? true, operator: false }),
  };
  runLog = new RunLog({ session: store, hub: hub as never, clock, ...(o.restore ? { restore: o.restore.runs } : {}) });
  const persistence = o.dir ? new SessionPersistence({ dir: o.dir, session: store, runLog, clock }) : null;
  const observe = (rule: string, kind: string | null, times = 1) => {
    for (let i = 0; i < times; i++) inbound.get("coach.observation")!({ payload: { rule, kind, category: "movement", text: rule, clientTs: 0 } }, "sensor");
  };
  /** One run: countdown, 60 s of presentation with the given observations, then slides done (no Q&A). */
  const runOnce = (obs: [rule: string, kind: string | null, times: number][], args: { mode?: "training"; level?: "strong" } = {}) => {
    expect(store.dispatch({ type: "start_run", ...args })).toEqual({ ok: true });
    clock.advance(3000);
    for (const [rule, kind, times] of obs) observe(rule, kind, times);
    clock.advance(60_000);
    expect(store.dispatch({ type: "presentation_done" })).toEqual({ ok: true });
  };
  if (!o.restore) { store.setContext({ deck: DECK }); store.dispatch({ type: "session_start" }); }
  return { clock, store, runLog, persistence, observe, runOnce };
}

const SWAY = "body.torso_movement_high";
const HANDS = "body.hand_movement_high";

describe("session progress", () => {
  it("counts each behaviour per run and says what got better", () => {
    const t = rig();
    t.runOnce([[SWAY, "sway", 3], [HANDS, null, 1]]);           // baseline → target sway
    t.runOnce([[SWAY, "sway", 1], [HANDS, null, 1]]);           // training
    t.runOnce([[HANDS, null, 2]]);                              // training, sway clean
    const p = buildProgress(t.runLog.list(), t.store.get());
    expect(p.runs.map((r) => [r.index, r.mode, r.observations])).toEqual([[1, "baseline", 4], [2, "training", 2], [3, "training", 2]]);
    expect(p.runs.every((r) => r.score !== null && r.coach)).toBe(true);
    expect(p.rows.map((r) => [r.label, r.counts, r.trend, r.isTarget])).toEqual([
      ["Moving around / swaying", [3, 1, 0], "better", true],
      ["Fast hand movement", [1, 1, 2], "worse", false],
    ]);
    expect(p.headline).toBe("Moving around / swaying 3 → 0 · Fast hand movement 1 → 2");
  });

  it("leaves out runs still under way, shows null without the camera coach, and rows for targets never seen", () => {
    const t = rig({ sensor: false });
    t.runOnce([]);
    expect(t.store.dispatch({ type: "set_targets", targets: ["arms_crossed"] })).toEqual({ ok: true });
    t.store.dispatch({ type: "start_run" });
    const p = buildProgress(t.runLog.list(), t.store.get());
    expect(p.runs).toHaveLength(1);
    expect(p.rows).toEqual([expect.objectContaining({ rule: "kind:arms_crossed", label: "Crossed arms", counts: [null], isTarget: true, trend: "same" })]);
    expect(p.headline).toBeNull();
  });

  it("is served at GET /api/progress", () => {
    const t = rig();
    t.runOnce([[SWAY, "sway", 1]]);
    let body = "";
    const handled = progressHttp(t.runLog, () => t.store.get())({ method: "GET", url: "/api/progress" } as never, { writeHead: () => {}, end: (b: string) => { body = b; } } as never);
    expect(handled).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ sessionId: "sess1", runs: [{ runId: "run_1" }], rows: [{ rule: SWAY, counts: [1] }] });
  });
});

describe("session persistence", () => {
  it("a restarted brain continues the saved session: phase, coach, runs and their reports", () => {
    const dir = tmp();
    const a = rig({ dir });
    a.runOnce([[SWAY, "sway", 2]]);
    a.runOnce([[SWAY, "sway", 1]]);
    expect(a.persistence!.saveNow()).toBe(true);

    const saved = loadLatest(dir)!;
    expect(saved.state.sessionId).toBe("sess1");
    const b = rig({ restore: saved });
    const s = b.store.get();
    expect(s).toMatchObject({ sessionId: "sess1", phase: "debrief", view: "report", completedRuns: ["run_1", "run_2"], introDone: true });
    expect(s.coach.targets.map((x) => x.kind)).toEqual(["sway"]);
    expect(s.context.deck?.deckId).toBe("deck_abc");
    expect(b.runLog.get("run_1")!.observations).toHaveLength(2);
    expect(buildProgress(b.runLog.list(), s).rows[0]!.counts).toEqual([2, 1]);
    b.runOnce([]);                                                // and the next run is run_3
    expect(b.store.get().completedRuns.at(-1)).toBe("run_3");
  });

  it("a run under way when the brain stopped is aborted on restore and kept in the log", () => {
    const dir = tmp();
    const a = rig({ dir });
    a.store.dispatch({ type: "start_run" });
    a.clock.advance(3000);
    a.observe(SWAY, "sway");
    a.store.dispatch({ type: "wake", via: "ptt" });
    a.persistence!.saveNow();

    const b = rig({ restore: loadLatest(dir)! });
    const s = b.store.get();
    expect(s.phase).toBe("intro");                                // no run finished yet
    expect(s.run).toMatchObject({ runId: "run_1", phase: "aborted", paused: false });
    expect(s.wake.active).toBe(false);
    expect(b.runLog.get("run_1")).toMatchObject({ endedBy: "aborted", observations: [{ rule: SWAY }] });
    expect(buildProgress(b.runLog.list(), s).runs).toEqual([]);
    b.runOnce([]);
    expect(b.store.get().run?.runId).toBe("run_2");
  });

  it("saves on its own after changes (debounced), and a bad file means a fresh start, not a crash", () => {
    const dir = tmp();
    const a = rig({ dir });
    expect(loadLatest(dir)).toBeNull();                          // session_start: saved 500 ms later
    a.clock.advance(600);
    expect(loadLatest(dir)?.state.phase).toBe("intro");
    a.runOnce([]);
    a.clock.advance(600);
    expect(loadLatest(dir)?.runs).toHaveLength(1);
    writeFileSync(join(dir, "sess1", "session.json"), "{ not json");
    const warnings: string[] = [];
    expect(loadLatest(dir, (_l, msg) => warnings.push(msg))).toBeNull();
    expect(warnings).toEqual(["persist.load_failed"]);
  });

  it("reset starts a new session; the run log starts again at run_1", async () => {
    const t = rig();
    t.runOnce([[SWAY, "sway", 1]]);
    expect(t.store.dispatch({ type: "reset" })).toEqual({ ok: true });
    expect(t.runLog.list()).toEqual([]);
    expect(t.store.get()).toMatchObject({ sessionId: "sess2", phase: "setup", introDone: true, context: { deck: { deckId: "deck_abc" } } });

    const reset = sessionHttp({ session: t.store, runLog: t.runLog, persistence: null });
    const req = Object.assign(new (await import("node:stream")).PassThrough(), { method: "POST", url: "/api/session/reset" });
    let body = "";
    const done = reset(req as never, { writeHead: () => {}, end: (b: string) => { body = b; } } as never);
    req.end("{}");
    expect(await done).toBe(true);
    expect(JSON.parse(body)).toEqual({ ok: true, sessionId: "sess3", full: true, deleted: false });   // no persistence: nothing on disk
    expect(t.store.get()).toMatchObject({ phase: "setup", introDone: false, context: { deck: null }, scene: { version: 2 } });
  });

  it("slides of a deck uploaded before a restart are still served", async () => {
    const dir = tmp();
    const slideDir = join(dir, "sess_old", "uploads", "deck", "deck_abc");
    mkdirSync(slideDir, { recursive: true });
    writeFileSync(join(slideDir, "0.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const t = rig();
    const uploads = new Uploads({ session: t.store, sessionDir: dir });
    const res = { status: 0, writeHead(s: number) { this.status = s; }, end() {} };
    expect(await uploads.handle({ method: "GET", url: "/api/decks/deck_abc/0.png" } as never, res as never)).toBe(true);
    expect(res.status).toBe(200);
    await uploads.handle({ method: "GET", url: "/api/decks/deck_zzz/0.png" } as never, res as never);
    expect(res.status).toBe(404);
  });
});
