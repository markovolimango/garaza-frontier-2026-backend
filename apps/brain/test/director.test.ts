import { describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type ClientRole, type Deck, type DownlinkMessage, type SceneDef } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { buildDigest, digestHttp } from "../src/digest.ts";
import { Director } from "../src/director/director.ts";
import { CLOSING_LINE, deckFacts, planQuestions, snippet } from "../src/director/questions.ts";
import { observedCoach } from "../src/observedCoach.ts";
import { RunLog } from "../src/runlog.ts";
import { SessionStore } from "../src/session.ts";
import { flush, judge, silent, voiced } from "./helpers.ts";

const PANEL = [
  judge(1, { title: "Customer advocate", style: "warm", toughness: 0.3 }),
  judge(2, { title: "Startup mentor", style: "neutral", toughness: 0.5 }),
  judge(3, { title: "VC investor", style: "skeptical", toughness: 0.8 }),
  judge(4, { title: "Technical expert", style: "neutral", toughness: 0.6 }),
];
const DECK: Deck = { deckId: "d", name: "acme", slides: [
  { index: 0, url: "/0.png", text: "Acme: meeting notes that write themselves" },
  { index: 1, url: "/1.png", text: "Traction: 40 paying teams" },
  { index: 2, url: "/2.png", text: "Pricing: 40 euros per seat per month" },
] };

describe("judge questions (no LLM)", () => {
  it("finds topics in the deck and quotes them", () => {
    expect(deckFacts(DECK).map((f) => [f.topic, f.slideIndex])).toEqual([["problem", 0], ["traction", 1], ["pricing", 2]]);
    expect(snippet("  A very long line about the product that keeps going and going and going on and on, really  ", 40)).toBe("A very long line about the product that");
  });

  it("toughest judge first, style-matched topics, deck-specific where possible, deterministic", () => {
    const q = planQuestions(DECK, PANEL, 3);
    expect(q.map((x) => [x.judgeId, x.topic])).toEqual([["judge_3", "pricing"], ["judge_4", "traction"], ["judge_2", "gtm"]]);
    expect(q[0]!.text).toContain('"Pricing: 40 euros per seat per month"');
    expect(q[0]!.slideIndex).toBe(2);
    expect(planQuestions(DECK, PANEL, 3)).toEqual(q);
    expect(planQuestions(DECK, PANEL, 1, 1)[0]!.judgeId).toBe("judge_4");   // next run opens with another judge
  });

  it("falls back to generic questions without a deck, and never repeats a topic", () => {
    const q = planQuestions(null, PANEL, 6);
    expect(q).toHaveLength(6);
    expect(new Set(q.map((x) => x.topic)).size).toBe(6);
    expect(q.every((x) => x.slideIndex === null && x.text.endsWith("?"))).toBe(true);
    expect(planQuestions(DECK, [], 3)).toEqual([]);
  });
});

class FakeStage {
  sent: DownlinkMessage[] = [];
  isConnected() { return true; }
  send(m: DownlinkMessage) { this.sent.push(m); return true; }
}

function rig(opts: { questions?: number; thinkMs?: number } = {}) {
  const clock = new VirtualClock();
  const scene: SceneDef = { version: 1, venueId: "greybox", qa: { questions: opts.questions ?? 2, answerCapMs: 45_000 }, judges: PANEL, audience: { count: 10 }, lighting: "default" };
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  const store = new SessionStore({ clock, coach, venue: GREYBOX_VENUE, stage: new FakeStage(), initialScene: scene, newSessionId: () => "sess" });
  store.setContext({ deck: DECK });
  const micFns: ((pcm: Int16Array) => void)[] = [];
  const inbound = new Map<string, (m: { payload: unknown }, role: ClientRole) => void>();
  const outFns: ((m: DownlinkMessage, roles: ClientRole[]) => void)[] = [];
  const gestures: string[] = [];
  const looks: string[] = [];
  const hub = {
    onMic: (fn: (pcm: Int16Array) => void) => { micFns.push(fn); },
    send: (_role: "stage", m: DownlinkMessage) => {
      if (m.type === "actor.gesture") gestures.push(`${m.payload.actorId}:${m.payload.gesture}`);
      if (m.type === "actor.lookAt") looks.push(`${m.payload.actorId}>${m.payload.target}`);
      for (const f of outFns) f(m, ["stage"]);
      return true;
    },
    on: (type: string, fn: (m: { payload: unknown }, role: ClientRole) => void) => { inbound.set(type, fn); },
    onOutbound: (fn: (m: DownlinkMessage, roles: ClientRole[]) => void) => { outFns.push(fn); },
    connections: () => ({ stage: true, sensor: true, operator: false }),
  };
  runLog = new RunLog({ session: store, hub: hub as never, clock });
  const said: { judge: string; text: string }[] = [];
  const voices = { speakJudge: (actorId: string, text: string) => { said.push({ judge: actorId, text }); return { utteranceId: `u${said.length}`, done: new Promise<void>((r) => clock.setTimeout(r, 2000)) }; } };
  const director = new Director({ session: store, hub: hub as never, voices: voices as never, clock, runLog, silenceMs: 1500, noAnswerMs: 5000, echoGuardMs: 0, thinkMs: opts.thinkMs ?? 0 });
  /** Advance virtual time in small steps, letting promises settle in between. */
  const run = async (ms: number, mic?: () => Int16Array) => {
    for (let t = 0; t < ms; t += 20) { if (mic) for (const f of micFns) f(mic()); clock.advance(20); await flush(2); }
  };
  const observe = (rule: string, kind: string | null) => inbound.get("coach.observation")!({ payload: { rule, kind, category: kind ? "movement" : null, text: rule, clientTs: 0 } }, "sensor");
  const toQa = async () => {
    store.dispatch({ type: "session_start" });
    store.dispatch({ type: "start_run" });
    clock.advance(3000);
    await run(1000);
    store.dispatch({ type: "slide", index: 1, from: "stage" });
    observe("body.torso_movement_high", "sway");
    observe("body.hand_movement_high", null);
    await run(1000);
    store.dispatch({ type: "presentation_done" });
    await flush();
  };
  return { clock, store, director, runLog, said, gestures, looks, run, observe, toQa };
}

describe("Director", () => {
  it("asks the planned questions, listens to each answer, closes, and dispatches qa_done", async () => {
    const t = rig();
    await t.toQa();
    expect(t.director.running).toBe(true);
    await t.run(2000);                                   // judge_3 asks
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3"]);
    await t.run(3000, () => voiced());                   // the presenter answers for 3 s
    await t.run(1800, () => silent());                   // then stops: answer over after 1.5 s of silence
    expect(t.gestures).toContain("judge_3:nod");
    await t.run(2100);                                   // judge_4 asks
    await t.run(5400);                                   // no answer at all: next after 5 s
    await t.run(2100);                                   // closing line
    expect(t.said.map((s) => s.text).at(-1)).toBe(CLOSING_LINE);
    expect(t.store.get().phase).toBe("debrief");
    const qa = t.runLog.latest()!.qa;
    expect(qa.map((q) => q.judgeId)).toEqual(["judge_3", "judge_4"]);
    expect(qa[0]!.answerMs).toBeGreaterThan(2500);
    expect(qa[1]!.answerMs).toBe(0);
    expect(t.runLog.latest()!.endedBy).toBe("qa_done");
  });

  it("turns the panel: the asker reads their notes, the others look at the asker, all watch the answer", async () => {
    const t = rig({ questions: 1, thinkMs: 700 });
    await t.toQa();
    expect(t.looks.splice(0)).toEqual(["judge_1>presenter", "judge_2>presenter", "judge_3>presenter", "judge_4>presenter", "judge_3>notes"]);
    await t.run(800);                                    // judge_3 looks up and asks; the panel turns to judge_3
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3"]);
    expect(t.looks.splice(0)).toEqual(["judge_1>judge_3", "judge_2>judge_3", "judge_3>presenter", "judge_4>judge_3"]);
    await t.run(2000);                                   // question over: everyone watches the presenter answer
    expect(t.looks.splice(0)).toEqual(["judge_1>presenter", "judge_2>presenter", "judge_4>presenter"]);
    t.store.dispatch({ type: "wake", via: "ptt" });      // JJ listens: the panel waits, reading notes
    expect(t.looks.splice(0)).toEqual(["judge_1>notes", "judge_2>notes", "judge_3>notes", "judge_4>notes"]);
    t.store.dispatch({ type: "resume" });
    expect(t.looks.splice(0)).toEqual(["judge_1>presenter", "judge_2>presenter", "judge_3>presenter", "judge_4>presenter"]);
    await t.run(1000, () => voiced());
    await t.run(1800, () => silent());                   // answer over; judge_3 closes
    expect(t.looks.splice(0)).toEqual(["judge_1>judge_3", "judge_2>judge_3", "judge_4>judge_3"]);
    await t.run(2100);
    expect(t.said.at(-1)!.text).toBe(CLOSING_LINE);
    expect(t.looks).toEqual(["judge_1>presenter", "judge_2>presenter", "judge_4>presenter"]);
    expect(t.store.get().phase).toBe("debrief");
  });

  it("holds the Q&A while JJ is listening, and stops when the run is ended early", async () => {
    const t = rig({ questions: 3 });
    await t.toQa();
    await t.run(2100);                                   // judge_3 asks
    expect(t.said).toHaveLength(1);
    t.store.dispatch({ type: "wake", via: "ptt" });      // the presenter asks JJ something
    await t.run(8000, () => voiced());                   // talking to JJ is not an answer, and nothing moves on
    expect(t.said).toHaveLength(1);
    t.store.dispatch({ type: "resume" });
    await t.run(1000, () => silent());                   // its no-answer time ran out while held: next question at once
    expect(t.said).toHaveLength(2);
    t.store.dispatch({ type: "end_run" });
    await t.run(20_000, () => silent());
    expect(t.said).toHaveLength(2);                      // nothing after the run ended
    expect(t.director.running).toBe(false);
    expect(t.runLog.latest()!.endedBy).toBe("end_run");
  });
});

describe("RunLog, digest and the observed coach", () => {
  it("builds the run digest: slides, observations, Q&A, strengths, next run", async () => {
    const t = rig({ questions: 1 });
    await t.toQa();
    await t.run(2100);
    await t.run(1000, () => voiced());
    await t.run(1800, () => silent());
    await t.run(2100);
    const rec = t.runLog.latest()!;
    const d = buildDigest(rec, t.store.get().coach.recommendation);
    expect(d.endedBy).toBe("qa_done");
    expect(d.slides.map((s) => s.index)).toEqual([0, 1]);
    expect(d.slides[0]!.dwellMs).toBe(1000);
    expect(d.observations.map((o) => [o.label, o.count])).toEqual([["Moving around / swaying", 1], ["Fast hand movement", 1]]);
    expect(d.observations[0]!.examples[0]).toMatchObject({ slideIndex: 1, segment: "presentation" });
    expect(d.strengths).toEqual(["Arms open, not crossed", "Hands away from your face", "Kept your head up",
      "Comfortable speaking pace", "No long pauses", "No filler words"]);
    expect(d.qa).toHaveLength(1);
    expect(d.durations.presentationMs).toBe(2000);
    expect(d.next).toMatchObject({ mode: "training", level: "strong" });
    expect(d.next!.reason).toContain("swaying");
  });

  it("after the baseline the coach targets what it saw; a clean training run fixes it", async () => {
    const t = rig({ questions: 0 });
    await t.toQa();                                      // questions: 0 → presentation_done ends the run
    expect(t.store.get().coach).toMatchObject({ stage: "training", level: "strong" });
    expect(t.store.get().coach.targets.map((x) => x.kind)).toEqual(["sway"]);
    t.store.dispatch({ type: "start_run" });
    expect(t.store.get().run).toMatchObject({ mode: "training", feedbackLevel: "strong", targets: ["sway"] });
    t.clock.advance(3000);
    t.store.dispatch({ type: "presentation_done" });
    expect(t.store.get().coach.stage).toBe("fading");    // sway not seen: clean run, cleanRuns 1 → fixed → next stage
    expect(t.store.get().coach.recommendation).toMatchObject({ mode: "training", level: "gentle" });
  });

  it("picks camera behaviours (fast hands, looking down) as targets from the baseline", () => {
    const seen = (kind: string, n: number) => Array.from({ length: n }, () => ({ kind, category: "movement" }));
    const log = { get: () => ({ observations: [...seen("fast_hands", 3), ...seen("looking_down", 2), ...seen("sway", 1)] }) };
    const coach = observedCoach(log as never, { cleanRuns: 1, maxTrainingRuns: 5 });
    const run = { runId: "run_1", mode: "baseline" } as never;
    const next = coach.afterRun(coach.initial(), run);
    expect(next.targets.map((x) => x.kind)).toEqual(["fast_hands", "looking_down"]);
    expect(coach.recommend(next).reason).toBe("Next run with strong live feedback on fast hand movements and looking down.");
  });

  it("serves the digest over HTTP", async () => {
    const t = rig({ questions: 0 });
    await t.toQa();
    const routes = digestHttp(t.runLog, () => null);
    const call = (url: string) => {
      let status = 0; let body = "";
      const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } };
      const handled = routes({ method: "GET", url } as never, res as never);
      return { handled, status, json: body ? JSON.parse(body) : null };
    };
    expect(call("/api/runs").json).toEqual([{ runId: "run_1", index: 1, mode: "baseline", level: "off", ended: true }]);
    expect(call("/api/runs/run_1/report").json).toMatchObject({ runId: "run_1", observations: [{ rule: "body.torso_movement_high" }, { rule: "body.hand_movement_high" }] });
    expect(call("/api/runs/run_9/report").status).toBe(404);
    expect(call("/api/tools").handled).toBe(false);
  });
});
