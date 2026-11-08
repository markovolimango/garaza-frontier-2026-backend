/** Swarm reporter: run / session narratives from the board + RunLog, LLM or fallback, HTTP, PDF. No network. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GREYBOX_VENUE, RunNarrative, SessionNarrative, type ClientRole, type Deck, type RunId, type SceneDef } from "@coach/protocol";
import { VirtualClock } from "../../src/clock.ts";
import { observedCoach } from "../../src/observedCoach.ts";
import { RunLog } from "../../src/runlog.ts";
import { SessionStore } from "../../src/session.ts";
import { SwarmBoard, type SwarmEvent } from "../../src/swarm/board.ts";
import type { HttpRoute, SwarmContext } from "../../src/swarm/context.ts";
import { fillerStats, markFillers } from "../../src/swarm/reportData.ts";
import { installReporter, type ReporterLlm, type ReporterOptions } from "../../src/swarm/reporter.ts";
import { flush, judge } from "../helpers.ts";

const DECK: Deck = { deckId: "deck_abc", name: "acme", slides: [0, 1, 2].map((i) => ({ index: i, url: `/x/${i}.png`, text: `slide ${i}` })) };
const SCENE: SceneDef = { version: 1, venueId: "greybox", qa: { questions: 2, answerCapMs: 45_000 }, judges: [judge(1, { title: "VC investor" }), judge(2, { title: "CTO" }), judge(3)], audience: { count: 10 }, lighting: "default" };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function rig(opts: ReporterOptions = {}) {
  const clock = new VirtualClock();
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  let n = 0;
  const store = new SessionStore({ clock, coach, venue: GREYBOX_VENUE, initialScene: SCENE, newSessionId: () => `sess${++n}`, stage: { isConnected: () => true, send: () => true } });
  const inbound = new Map<string, (m: { payload: unknown }, role: ClientRole) => void>();
  const hub = { on: (t: string, fn: (m: { payload: unknown }, role: ClientRole) => void) => { inbound.set(t, fn); }, onOutbound: () => {}, connections: () => ({ stage: true, sensor: true, operator: false }) };
  runLog = new RunLog({ session: store, hub: hub as never, clock });
  const board = new SwarmBoard({ clock });
  const events: SwarmEvent[] = [];
  for (const t of ["report.ready", "agent.note"] as const) board.on(t, (e) => events.push(e));
  const dir = mkdtempSync(join(tmpdir(), "reporter-"));
  dirs.push(dir);
  const routes: HttpRoute[] = [];
  const ctx = {
    board, brain: { session: store } as never, runLog, clock, log: () => {}, media: null as never, judges: null as never,
    models: { apiKey: null, text: "t", report: "r", listener: "l", video: "v" }, speechRms: 500, videoAnalysis: true, chrome: "",
    sessionDir: dir, sessionFolder: () => join(dir, store.get().sessionId), http: (r: HttpRoute) => { routes.push(r); },
  } satisfies SwarmContext;
  const reporter = installReporter(ctx, opts);
  store.setContext({ deck: DECK });
  store.dispatch({ type: "session_start" });

  const behavior = (kind: string, phase: "start" | "end") => inbound.get("behavior")!({ payload: { kind, phase, clientTs: clock.now(), conf: 1 } }, "sensor");
  const phrase = (runId: RunId, text: string, fillers: string[], segment: "presentation" | "qa" = "presentation") => {
    board.emit({ type: "phrase", phrase: { runId, segment, text, fillers, startAt: clock.now(), endAt: clock.now() + 3_000, slideIndex: store.get().run?.slideIndex ?? 0 } });
    clock.advance(4_000);
  };
  /** One full run: phrases with fillers, crossed arms twice, two judge questions (one answered). */
  const run = () => {
    expect(store.dispatch({ type: "start_run" })).toEqual({ ok: true });
    clock.advance(3_000);
    const runId = store.get().run!.runId;
    phrase(runId, "So um we built a tool that, like, helps teams ship.", ["um", "like"]);
    behavior("arms_crossed", "start"); clock.advance(6_000); behavior("arms_crossed", "end");
    store.dispatch({ type: "slide", index: 1, from: "stage" });
    phrase(runId, "Uh, our customers are uh mostly startups.", ["uh", "uh"]);
    behavior("arms_crossed", "start"); clock.advance(4_000); behavior("arms_crossed", "end");
    phrase(runId, "We grew forty percent last quarter.", []);
    board.emit({ type: "video.note", note: { runId, kind: "arms_crossed", atMs: 9_000, durationMs: 6_000, text: "arms folded while explaining the product" } });
    expect(store.dispatch({ type: "presentation_done" })).toEqual({ ok: true });
    const asked1 = clock.now();
    board.emit({ type: "judge.line", line: { runId, judgeId: "judge_1", kind: "question", text: "How do you price it?", at: asked1 } });
    phrase(runId, "We charge per seat, twenty dollars a month, and we tested it with ten paying teams.", [], "qa");
    runLog!.recordQa(runId, { judgeId: "judge_1", judgeTitle: "VC investor", question: "How do you price it?", askedAt: asked1, answerMs: 9_000 });
    const asked2 = clock.now();
    runLog!.recordQa(runId, { judgeId: "judge_2", judgeTitle: "CTO", question: "What is hard to copy?", askedAt: asked2, answerMs: 0 });
    clock.advance(5_000);
    expect(store.dispatch({ type: "qa_done" })).toEqual({ ok: true });
    return runId;
  };

  const get = async (url: string) => {
    let code = 0; let headers: Record<string, string> = {}; let body: Buffer | string = "";
    const req = { method: "GET", url } as IncomingMessage;
    const res = { writeHead: (c: number, h: Record<string, string>) => { code = c; headers = h ?? {}; }, end: (b: Buffer | string) => { body = b; } } as unknown as ServerResponse;
    let handled = false;
    for (const r of routes) if (await r(req, res)) { handled = true; break; }
    return { handled, code, headers, body, json: () => JSON.parse(String(body)) as { status: string; report: unknown } };
  };
  return { clock, store, runLog, board, events, dir, reporter, run, get, ctx };
}

const LLM_RUN = {
  headline: "Clear pitch; drop the “uh” before your numbers.",
  summary: "You explained the product clearly.",
  strengths: [{ text: "Concrete pricing answer", evidence: "“twenty dollars a month”" }],
  improvements: [{ title: "Fillers before numbers", why: "They blur your strongest facts.", evidence: "“Uh, our customers are uh mostly startups.”", drill: "Say the customer line three times with a pause instead of “uh”." }],
  qa: [{ index: 0, answerSummary: "Per seat, $20/month, tested with ten teams.", verdict: "strong", tip: "Add the margin." },
       { index: 1, answerSummary: "Nothing.", verdict: "no answer", tip: "Name one moat." }],
  body: [{ kind: "crossed arms", note: "Arms folded twice while explaining the product." }],
  nextRun: "Same deck, kill the fillers on slide 2.",
};
const LLM_SESSION = { headline: "Fewer fillers, open arms", summary: "Two runs.", progress: ["Fillers 4 → 4"], strengths: ["Pricing answers"], focus: [{ title: "Fillers", why: "Still there", drill: "Pause" }] };

/** An LLM whose answers the test releases by hand. */
function deferredLlm() {
  const calls: { system: string; prompt: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const llm: ReporterLlm = <T,>(o: { system: string; prompt: string }) => new Promise<T>((resolve, reject) => { calls.push({ ...o, resolve: resolve as (v: unknown) => void, reject }); });
  return { llm, calls };
}

describe("reporter: run narrative", () => {
  it("waits for the last notes, is pending while the LLM writes, then ready with the LLM's words on the data's facts", async () => {
    const { llm, calls } = deferredLlm();
    const t = rig({ llm });
    const runId = t.run();
    expect((await t.get(`/api/swarm/report/run/${runId}`)).json()).toEqual({ status: "pending", report: null });   // settling
    expect(calls).toHaveLength(0);
    t.board.emit({ type: "phrase", phrase: { runId, segment: "qa", text: "Um, late phrase.", fillers: ["um"], startAt: t.clock.now(), endAt: t.clock.now() + 500, slideIndex: 1 } });
    t.clock.advance(3_000);
    expect(calls).toHaveLength(1);
    expect(t.board.allStatuses().find((s) => s.id === "reporter")).toMatchObject({ state: "thinking", detail: "writing run 1 report" });
    expect(calls[0]!.prompt).toContain("[[Uh]], our customers are [[uh]] mostly startups.");
    expect(calls[0]!.prompt).toContain("How do you price it?");
    expect(calls[0]!.prompt).toContain("arms folded while explaining the product");
    expect((await t.get(`/api/swarm/report/run/${runId}`)).json().status).toBe("pending");
    calls[0]!.resolve(LLM_RUN);
    await flush();
    const r = (await t.get(`/api/swarm/report/run/${runId}`)).json();
    expect(r.status).toBe("ready");
    const n = RunNarrative.parse(r.report);
    expect(n).toMatchObject({ runId, index: 1, source: "llm", headline: LLM_RUN.headline, nextRun: LLM_RUN.nextRun });
    expect(n.fillers).toMatchObject({ count: 5, measured: true, top: [{ word: "um", count: 2 }, { word: "uh", count: 2 }, { word: "like", count: 1 }] });
    expect(n.qa.map((q) => [q.judge, q.question, q.verdict])).toEqual([["VC investor", "How do you price it?", "strong"], ["CTO", "What is hard to copy?", "no answer"]]);
    expect(n.body).toEqual([{ kind: "Crossed arms", count: 2, note: "Arms folded twice while explaining the product." }]);
    expect(t.events.filter((e) => e.type === "report.ready")).toEqual([{ type: "report.ready", scope: "run", runId }]);
    expect(t.events.find((e) => e.type === "agent.note")).toMatchObject({ from: "reporter", text: expect.stringContaining("[REPORTER] run 1 report ready: Clear pitch") });
    expect(t.board.allStatuses().find((s) => s.id === "reporter")).toMatchObject({ state: "idle", detail: "ready: run 1 report" });
  });

  it("falls back to a narrative built from the data when the LLM fails", async () => {
    const t = rig({ llm: () => Promise.reject(new Error("timeout after 20000 ms")) });
    const runId = t.run();
    t.clock.advance(3_000);
    await flush();
    const n = RunNarrative.parse((await t.get(`/api/swarm/report/run/${runId}`)).json().report);
    expect(n.source).toBe("fallback");
    expect(n.headline).toMatch(/^Run 1: 4 filler words, crossed arms 2×, 1\/2 questions answered well/);
    expect(n.improvements.map((i) => i.title)).toEqual(expect.arrayContaining(["Crossed arms", "Filler words", "Answers to the judges"]));
    expect(n.improvements.find((i) => i.title === "Filler words")!.evidence).toContain("[[um]]");
    expect(n.improvements.every((i) => i.drill.length > 20)).toBe(true);
    expect(n.qa.map((q) => q.verdict)).toEqual(["ok", "no answer"]);
    expect(n.qa[0]!.answerSummary).toContain("twenty dollars a month");
    expect(n.body[0]!.note).toMatch(/2 times, 10 s in total .*On the recording: 0:09: arms folded/);
    expect(t.board.allStatuses().find((s) => s.id === "reporter")!.detail).toMatch(/^ready: run 1 report \(from the data; LLM: timeout/);
  });

  it("waits for the body agent's video notes (capped), and rebuilds once when notes come after the report", async () => {
    const { llm, calls } = deferredLlm();
    const t = rig({ llm });
    t.board.status("body", "thinking", "watching run 1");
    const r1 = t.run();
    t.clock.advance(3_000);
    expect(calls).toHaveLength(0);
    expect(t.board.allStatuses().find((s) => s.id === "reporter")!.detail).toBe("waiting for run 1's video notes");
    t.clock.advance(9_000);
    t.board.emit({ type: "video.note", note: { runId: r1, kind: "sway", atMs: 20_000, text: "steps side to side on slide 2" } });
    t.board.emit({ type: "video.note", note: { runId: r1, kind: "sway", atMs: 25_000, text: "rocks back and forth" } });
    t.clock.advance(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("rocks back and forth");
    calls[0]!.resolve(LLM_RUN); await flush();

    // run 2: body stays "thinking" → the cap (25 s); its notes arrive later → one rebuild ("updated")
    const r2 = t.run();
    t.clock.advance(24_000);
    expect(calls).toHaveLength(1);
    t.clock.advance(1_000);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(LLM_RUN); await flush();
    t.board.emit({ type: "video.note", note: { runId: r2, kind: "arms_crossed", atMs: 5_000, text: "late note" } });
    t.board.status("body", "idle", "run_2: 1 video note");
    t.clock.advance(1_500);
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(LLM_RUN); await flush();
    expect(t.events.filter((e) => e.type === "agent.note").at(-1)).toMatchObject({ text: expect.stringContaining("[REPORTER] run 2 report updated") });
  });

  it("answers none for unknown or unfinished runs, and report.make rebuilds a run with JJ's focus", async () => {
    const { llm, calls } = deferredLlm();
    const t = rig({ llm });
    expect((await t.get("/api/swarm/report/run/run_9")).json()).toEqual({ status: "none", report: null });
    expect((await t.get("/api/swarm/report/session")).json()).toEqual({ status: "none", report: null });
    expect((await t.get("/api/other")).handled).toBe(false);
    const runId = t.run();
    t.clock.advance(3_000);
    calls[0]!.resolve(LLM_RUN); await flush();
    t.board.command({ type: "report.make", scope: "run", focus: "the Q&A" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("\"coachJJAsksToFocusOn\": \"the Q&A\"");
    calls[1]!.reject(new Error("503")); await flush();
    expect(RunNarrative.parse(t.board.runReport(runId)).source).toBe("fallback");
  });
});

describe("reporter: session narrative and PDF", () => {
  it("builds the session report on report.make and on show_final, and goes stale after another run", async () => {
    const { llm, calls } = deferredLlm();
    const t = rig({ llm });
    const r1 = t.run();
    t.clock.advance(3_000); calls[0]!.resolve(LLM_RUN); await flush();
    t.board.command({ type: "report.make", scope: "session" });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("Clear pitch");
    expect((await t.get("/api/swarm/report/session")).json().status).toBe("pending");
    calls[1]!.resolve(LLM_SESSION); await flush();
    const s1 = (await t.get("/api/swarm/report/session")).json();
    expect(s1.status).toBe("ready");
    expect(SessionNarrative.parse(s1.report)).toMatchObject({ headline: "Fewer fillers, open arms", source: "llm", runs: [{ runId: r1, index: 1, headline: LLM_RUN.headline }] });
    expect(t.events.filter((e) => e.type === "report.ready").at(-1)).toEqual({ type: "report.ready", scope: "session" });

    const r2 = t.run();
    t.clock.advance(3_000);
    expect(calls).toHaveLength(3);                            // run 2's report
    calls[2]!.reject(new Error("overloaded")); await flush();
    expect((await t.get("/api/swarm/report/session")).json()).toMatchObject({ status: "pending" });   // stale: run 2 missing
    await flush();
    expect(calls).toHaveLength(4);
    calls[3]!.reject(new Error("overloaded")); await flush();
    const s2 = SessionNarrative.parse((await t.get("/api/swarm/report/session")).json().report);
    expect(s2.runs.map((r) => r.runId)).toEqual([r1, r2]);
    expect(s2.source).toBe("fallback");
    expect(s2.progress[0]).toMatch(/^Filler words: 4 → 4/);
    expect(s2.focus.length).toBeGreaterThan(0);

    expect(t.store.dispatch({ type: "show_final" })).toEqual({ ok: true });
    await flush();
    expect(calls).toHaveLength(4);                            // fresh: show_final doesn't write it again
  });

  it("PDF: 501 without Chrome; with a renderer, a PDF in the session folder, as a download on ?download=1", async () => {
    const none = rig({ llm: () => Promise.reject(new Error("no key")), chromePath: null });
    none.run(); none.clock.advance(3_000); await flush();
    const r501 = await none.get("/api/swarm/report/session.pdf");
    expect(r501.code).toBe(501);
    expect(r501.json()).toMatchObject({ reason: "no_chrome" });

    const htmls: string[] = [];
    const t = rig({ llm: () => Promise.reject(new Error("no key")), renderPdf: async (html) => { htmls.push(html); return Buffer.from("%PDF-1.7 fake"); } });
    expect((await t.get("/api/swarm/report/session.pdf")).code).toBe(404);              // no run yet
    t.run(); t.clock.advance(3_000); await flush();
    const r = await t.get("/api/swarm/report/session.pdf?download=1");
    expect(r.code).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="coach-report-practice\.pdf"/);
    const file = join(t.ctx.sessionFolder(), "report.pdf");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("%PDF-1.7 fake");
    expect(htmls[0]).toContain("Run by run");
    expect(htmls[0]).toContain("<mark>um</mark>");
    expect(htmls[0]).not.toContain("presenterGoals");
    const html = await t.get("/api/swarm/report/session.html");
    expect(html.headers["content-type"]).toMatch(/text\/html/);
  });

  it("PDF: a reset while it renders drops it (nothing written) and doesn't end the new session's PDF job", async () => {
    const renders: ((b: Buffer) => void)[] = [];
    const t = rig({ llm: () => Promise.reject(new Error("no key")), renderPdf: () => new Promise((r) => { renders.push(r); }) });
    t.run(); t.clock.advance(3_000); await flush();
    const oldFolder = t.ctx.sessionFolder();
    const first = t.get("/api/swarm/report/session.pdf");
    await flush();
    expect(renders).toHaveLength(1);
    t.store.dispatch({ type: "reset" });                  // the next presenter
    t.store.dispatch({ type: "session_start" });
    t.run(); t.clock.advance(3_000); await flush();
    const newFolder = t.ctx.sessionFolder();
    expect(newFolder).not.toBe(oldFolder);
    const second = t.get("/api/swarm/report/session.pdf");
    await flush();
    expect(renders).toHaveLength(2);
    renders[0]!(Buffer.from("%PDF old session"));
    expect((await first).code).toBe(409);
    expect(existsSync(join(oldFolder, "report.pdf"))).toBe(false);
    expect(existsSync(join(newFolder, "report.pdf"))).toBe(false);
    const third = t.get("/api/swarm/report/session.pdf");  // joins the new session's job, still under way
    await flush();
    expect(renders).toHaveLength(2);
    renders[1]!(Buffer.from("%PDF new session"));
    expect(String((await second).body)).toBe("%PDF new session");
    expect(String((await third).body)).toBe("%PDF new session");
    expect(readFileSync(join(newFolder, "report.pdf"), "utf8")).toBe("%PDF new session");
  });

  it("drops a report still being written when the session is reset", async () => {
    const { llm, calls } = deferredLlm();
    const t = rig({ llm });
    const runId = t.run();
    t.clock.advance(3_000);
    t.store.dispatch({ type: "reset", full: true });
    calls[0]!.resolve(LLM_RUN); await flush();
    expect(t.board.runReport(runId)).toBeNull();
  });
});

describe("reporter data", () => {
  it("marks fillers in place and counts them per minute", () => {
    expect(markFillers({ text: "So um, like, it's like fast. Umbrella.", fillers: ["um", "like", "like"] })).toBe("So [[um]], [[like]], it's [[like]] fast. Umbrella.");
    const p = (text: string, fillers: string[]) => ({ runId: "run_1" as RunId, segment: "presentation" as const, text, fillers, startAt: 0, endAt: 1, slideIndex: 0 });
    expect(fillerStats([p("um uh", ["um", "uh"]), p("UM", ["UM"])], 120_000)).toMatchObject({ count: 3, perMin: 1.5, top: [{ word: "um", count: 2 }, { word: "uh", count: 1 }], measured: true });
    expect(fillerStats([], 60_000)).toMatchObject({ count: 0, measured: false });
  });
});
