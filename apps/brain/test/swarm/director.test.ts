import { describe, expect, it } from "vitest";
import { GREYBOX_VENUE, type ClientRole, type Deck, type DownlinkMessage, type RunId, type SceneDef } from "@coach/protocol";
import { VirtualClock } from "../../src/clock.ts";
import { DirectorAgent, type DirectorLlm, type LlmCall } from "../../src/director/agent.ts";
import { Director } from "../../src/director/director.ts";
import { observedCoach } from "../../src/observedCoach.ts";
import { RunLog } from "../../src/runlog.ts";
import { SessionStore } from "../../src/session.ts";
import { SwarmBoard, type SwarmCommand } from "../../src/swarm/board.ts";
import { flush, judge, silent, voiced } from "../helpers.ts";

const PANEL = [
  judge(1, { title: "Customer advocate", style: "warm", toughness: 0.3 }),
  judge(2, { title: "Startup mentor", style: "neutral", toughness: 0.5 }),
  judge(3, { title: "VC investor", style: "skeptical", toughness: 0.8, priorities: ["unit economics", "market size"] }),
  judge(4, { title: "Technical expert", style: "neutral", toughness: 0.6 }),
];
const DECK: Deck = { deckId: "d", name: "acme", slides: [
  { index: 0, url: "/0.png", text: "Acme: meeting notes that write themselves" },
  { index: 1, url: "/1.png", text: "Traction: 40 paying teams" },
  { index: 2, url: "/2.png", text: "Pricing: 40 euros per seat per month" },
] };

class FakeStage { sent: DownlinkMessage[] = []; isConnected() { return true; } send(m: DownlinkMessage) { this.sent.push(m); return true; } }

type Handler = (c: LlmCall) => unknown;
function rig(opts: { questions?: number; plan?: Handler; decide?: Handler; noLlm?: boolean; brief?: Extract<SwarmCommand, { type: "director.brief" }> } = {}) {
  const clock = new VirtualClock();
  const scene: SceneDef = { version: 1, venueId: "greybox", qa: { questions: opts.questions ?? 2, answerCapMs: 20_000 }, judges: PANEL, audience: { count: 10 }, lighting: "default" };
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  const store = new SessionStore({ clock, coach, venue: GREYBOX_VENUE, stage: new FakeStage(), initialScene: scene, newSessionId: () => "sess" });
  store.setContext({ deck: DECK });
  const micFns: ((pcm: Int16Array) => void)[] = [];
  const gestures: string[] = [];
  const hub = {
    onMic: (fn: (pcm: Int16Array) => void) => { micFns.push(fn); },
    send: (_role: "stage", m: DownlinkMessage) => { if (m.type === "actor.gesture") gestures.push(`${m.payload.actorId}:${m.payload.gesture}`); return true; },
    on: () => {}, onOutbound: () => {},
    connections: () => ({ stage: true, sensor: false, operator: false }),
  };
  runLog = new RunLog({ session: store, hub: hub as never, clock });
  const board = new SwarmBoard({ clock });
  if (opts.brief) board.command(opts.brief);
  const calls: LlmCall[] = [];
  const llm: DirectorLlm = async (c) => {
    calls.push(c);
    const h = c.task === "plan" ? opts.plan : opts.decide;
    if (!h) throw new Error(`no ${c.task}`);
    return h(c);
  };
  const said: { judge: string; text: string }[] = [];
  const voices = { speakJudge: (actorId: string, text: string) => { said.push({ judge: actorId, text }); return { utteranceId: `u${said.length}`, done: new Promise<void>((r) => clock.setTimeout(r, 2000)) }; } };
  const agent = new DirectorAgent({ board, session: store, hub: hub as never, clock, llm: opts.noLlm ? null : llm });
  const director = new Director({ session: store, hub: hub as never, voices: voices as never, clock, runLog, silenceMs: 1500, noAnswerMs: 5000, echoGuardMs: 0, thinkMs: 0, strategy: agent });
  const run = async (ms: number, mic?: () => Int16Array) => {
    for (let t = 0; t < ms; t += 20) { if (mic) for (const f of micFns) f(mic()); clock.advance(20); await flush(2); }
  };
  const runId = () => store.get().run!.runId as RunId;
  /** The listener's phrase (as the swarm listener emits it). */
  const phrase = (text: string, segment: "presentation" | "qa", fillers: string[] = []) =>
    board.emit({ type: "phrase", phrase: { runId: runId(), segment, text, fillers, startAt: clock.now() - 1500, endAt: clock.now(), slideIndex: store.get().run!.slideIndex } });
  const toPresentation = async () => {
    store.dispatch({ type: "session_start" });
    store.dispatch({ type: "start_run" });
    clock.advance(3000);
    await run(100);
    expect(store.get().run!.phase).toBe("presentation");
  };
  /** The presenter answers for `ms` (mic voiced, a qa phrase at the end), then is silent. */
  const answer = async (text: string, ms = 2000) => { await run(ms, () => voiced()); phrase(text, "qa"); await run(1600, () => silent()); };
  const status = () => board.allStatuses().find((a) => a.id === "director")!;
  return { clock, store, board, runLog, said, gestures, calls, director, agent, run, phrase, toPresentation, answer, status };
}

const planOf = (qs: [string, string, string][]) => () => ({ questions: qs.map(([judgeId, topic, text]) => ({ judgeId, topic, text, slideIndex: -1 })) });

describe("director agent: planning during the presentation", () => {
  it("plans from the transcript, keeps the plan ready, and the Q&A opens with it at once", async () => {
    const t = rig({ plan: planOf([["judge_3", "pricing", "You said 40 euros a seat. Why would a team of ten pay 400 a month?"], ["judge_1", "problem", "Who on the team feels this pain first?"]]) });
    await t.toPresentation();
    expect(t.status().detail).toMatch(/ready/);
    await t.run(100);                                    // first plan at the presentation start (deck + brief, no words yet)
    expect(t.calls.map((c) => c.task)).toEqual(["plan"]);
    expect(t.calls[0]!.prompt).toContain("Questions to write: 2");
    expect(t.calls[0]!.prompt).toContain("judge_3 · VC investor · style skeptical · tone (tough)");
    expect(t.calls[0]!.prompt).toContain("Slide 2: Pricing: 40 euros per seat per month");
    expect(t.calls[0]!.prompt).toContain("nothing said yet");
    expect(t.status()).toMatchObject({ state: "listening", detail: "planning · 2 questions ready" });
    t.phrase("We charge 40 euros per seat, and um, teams love it.", "presentation", ["um"]);
    t.store.dispatch({ type: "slide", index: 1, from: "stage" });
    await t.run(3100);                                   // slide change → replan after the debounce, with the words so far
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.prompt).toContain("We charge 40 euros per seat, and um, teams love it.");
    await t.run(25_000);                                 // and every 25 s
    expect(t.calls.length).toBeGreaterThanOrEqual(3);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(100);
    expect(t.said).toEqual([{ judge: "judge_3", text: "You said 40 euros a seat. Why would a team of ten pay 400 a month?" }]);
    expect(t.board.judgeLines().map((l) => [l.judgeId, l.kind])).toContainEqual(["judge_3", "question"]);
  });

  it("falls back to the template plan when planning fails, and fills a short plan from the templates", async () => {
    const t = rig({ questions: 3, plan: planOf([["judge_2", "team", "Why is this team the one to build it?"], ["judge_9", "x", "Unknown judge question?"]]) });
    await t.toPresentation();
    await t.run(100);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(100);
    const plan = t.agent.plan(t.store.get().run!.runId, t.store.get());
    expect(plan.map((q) => q.judgeId)).toEqual(["judge_2", "judge_3", "judge_4"]);   // LLM's one (unknown judge dropped) + templates
    expect(plan[1]!.topic).toBe("pricing");

    const f = rig({ plan: () => { throw new Error("503 high demand"); } });
    await f.toPresentation();
    await f.run(100);
    expect(f.status().detail).toBe("planning · 2 questions ready (templates)");
    f.store.dispatch({ type: "presentation_done" });
    await f.run(100);
    expect(f.said[0]!.judge).toBe("judge_3");
    expect(f.said[0]!.text).toContain('"Pricing: 40 euros per seat per month"');
  });
});

describe("director agent: Q&A decisions", () => {
  it("asks a follow-up from the same judge on a vague answer, stores the answers, closes with verdicts and notes JJ", async () => {
    let n = 0;
    const t = rig({
      plan: planOf([["judge_3", "pricing", "What does a team pay you per month?"], ["judge_4", "tech", "What is hard to copy here?"]]),
      decide: (c) => {
        n++;
        if (n === 1) { expect(c.prompt).toContain("ANSWER (2 s): It depends, we are still figuring it out"); expect(c.prompt).toContain("FOLLOW-UPS ALLOWED: yes"); return { action: "followup", text: "So what is the number?", verdict: "dodged", note: "no number given" }; }
        if (n === 2) { expect(c.prompt).toContain("FOLLOW-UPS ALLOWED: no"); return { action: "next", text: "", verdict: "answered", note: "40 euros per seat" }; }
        return { action: "next", text: "", verdict: "answered", note: "clear: on-device model" };
      },
    });
    await t.toPresentation();
    await t.run(100);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);                                   // judge_3 asks
    await t.answer("It depends, we are still figuring it out");
    await t.run(2100);                                   // judge_3 follows up
    expect(t.said.map((s) => [s.judge, s.text])).toEqual([["judge_3", "What does a team pay you per month?"], ["judge_3", "So what is the number?"]]);
    await t.answer("Forty euros per seat per month.");
    await t.run(2100);                                   // judge_4's planned question (no second follow-up)
    expect(t.said.at(-1)).toEqual({ judge: "judge_4", text: "What is hard to copy here?" });
    await t.answer("The on-device model, two years of work.");
    await t.run(2100);                                   // closing
    expect(t.store.get().phase).toBe("debrief");
    expect(t.runLog.latest()!.qa.map((q) => [q.judgeId, q.answer])).toEqual([
      ["judge_3", "It depends, we are still figuring it out"], ["judge_3", "Forty euros per seat per month."], ["judge_4", "The on-device model, two years of work."]]);
    const lines = t.board.judgeLines().filter((l) => l.kind !== "reaction");
    expect(lines.map((l) => l.kind)).toEqual(["question", "followup", "question", "closing"]);
    expect(lines.at(-1)!.verdicts!.map((v) => [v.kind, v.topic, v.verdict, v.note])).toEqual([
      ["question", "pricing", "dodged", "no number given"], ["followup", "pricing", "answered", "40 euros per seat"], ["question", "tech", "answered", "clear: on-device model"]]);
    expect(t.agent.summary(t.store.get().run!.runId, [])).toContain("dodged: pricing (no number given)");
    expect(t.status()).toMatchObject({ state: "idle", detail: "Q&A done · 3 turns" });
  });

  it("emits the note to JJ at the end of the Q&A", async () => {
    const t = rig({ questions: 1, plan: planOf([["judge_3", "pricing", "What do you charge?"]]), decide: () => ({ action: "next", text: "", verdict: "dodged", note: "no number given" }) });
    const notes: string[] = [];
    t.board.on("agent.note", (e) => { if (e.from === "director") notes.push(e.text); });
    await t.toPresentation();
    await t.run(100);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);
    await t.answer("We have a few ideas about that.");
    await t.run(2100);
    expect(notes).toEqual(["Q&A: 1 question; dodged: pricing (no number given)."]);
  });

  it("on a decision timeout goes to the next planned question within ~4 s (heuristic verdict)", async () => {
    const t = rig({ plan: planOf([["judge_3", "pricing", "What do you charge?"], ["judge_1", "problem", "Who has this problem?"]]), decide: () => new Promise(() => {}) });
    await t.toPresentation();
    await t.run(100);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);
    await t.answer("We think teams will love it.");
    await t.run(3900);
    expect(t.said).toHaveLength(1);                      // still deciding
    await t.run(2300);                                   // timeout at 4 s → next question
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3", "judge_1"]);
    await t.run(1600);
    await t.answer("Engineering managers.");
    await t.run(6100);
    expect(t.store.get().phase).toBe("debrief");
    const closing = t.board.judgeLines().find((l) => l.kind === "closing")!;
    expect(closing.verdicts!.map((v) => [v.verdict, v.note])).toEqual([["partial", "no number given"], ["partial", "very short answer"]]);
  });

  it("without an LLM runs on templates with no extra wait", async () => {
    const t = rig({ noLlm: true });
    await t.toPresentation();
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3"]);
    await t.answer("Forty euros a seat.");
    await t.run(2100);
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3", "judge_4"]);
    expect(t.calls).toHaveLength(0);
  });
});

describe("director agent: JJ's brief", () => {
  it("tough brief: tougher tone in the prompts, the question count, no follow-ups, a tough closing line", async () => {
    const t = rig({
      questions: 3,
      brief: { type: "director.brief", strictness: "tough", questions: 1, followUps: false, focus: ["pricing"] },
      plan: (c) => {
        expect(c.prompt).toContain("Questions to write: 1");
        expect(c.prompt).toContain("judge_1 · Customer advocate · style warm · tone (tough)");
        expect(c.prompt).toContain("focus topics: pricing");
        return planOf([["judge_3", "pricing", "Your price, in one number?"], ["judge_1", "x", "Extra?"]])();
      },
      decide: (c) => { expect(c.prompt).toContain("FOLLOW-UPS ALLOWED: no"); return { action: "followup", text: "Ignored follow-up?", verdict: "partial", note: "vague" }; },
    });
    await t.toPresentation();
    await t.run(100);
    expect(t.calls).toHaveLength(1);
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);
    await t.answer("Around forty euros I think.");
    await t.run(2100);
    expect(t.said.map((s) => s.text)).toEqual(["Your price, in one number?", "Thank you. We have what we need."]);
    expect(t.store.get().phase).toBe("debrief");
  });

  it("a brief mid-presentation replans; a kind judge override changes only that judge", async () => {
    const t = rig({ plan: planOf([["judge_3", "pricing", "What do you charge?"], ["judge_1", "problem", "Who has this problem?"]]) });
    await t.toPresentation();
    await t.run(100);
    expect(t.calls).toHaveLength(1);
    t.board.command({ type: "director.brief", perJudge: { judge_3: "kind" }, questions: 3 });
    await t.run(1100);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.prompt).toContain("Questions to write: 3");
    expect(t.calls[1]!.prompt).toContain("judge_3 · VC investor · style skeptical · tone (kind)");
    expect(t.calls[1]!.prompt).toContain("judge_4 · Technical expert · style neutral · tone (neutral)");
  });

  it("a reset forgets the brief and drops a plan still being written for the old session", async () => {
    const prompts: string[] = [];
    const pending: ((v: unknown) => void)[] = [];
    const t = rig({
      brief: { type: "director.brief", strictness: "tough", focus: ["pricing"], interrupts: true },
      plan: (c) => { prompts.push(c.prompt); return new Promise((r) => { pending.push(r); }); },
    });
    await t.toPresentation();
    await t.run(100);                                    // planning for run_1 is under way
    expect(prompts[0]).toContain("judge_1 · Customer advocate · style warm · tone (tough)");
    expect(prompts[0]).toContain("focus topics: pricing");
    t.store.dispatch({ type: "reset" });
    await t.toPresentation();                            // the next presenter: run_1 again
    expect(t.store.get().run!.runId).toBe("run_1");
    await t.run(100);
    expect(prompts).toHaveLength(2);                     // a new plan for the new presenter, without the old brief
    expect(prompts[1]).toContain("judge_1 · Customer advocate · style warm · tone (kind)");
    expect(prompts[1]).not.toContain("pricing");
    pending[0]!({ questions: [{ judgeId: "judge_1", topic: "old", text: "A question for the old presenter?", slideIndex: -1 }] });
    await t.run(100);                                    // the old session's plan arrives late: dropped
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3"]);   // the template plan, not the stale one
    expect(t.said[0]!.text).not.toContain("old presenter");
  });

  it("interrupts (brief): a tough judge cuts in on a rambling answer past half the cap", async () => {
    const t = rig({ questions: 1, noLlm: true, brief: { type: "director.brief", interrupts: true } });
    await t.toPresentation();
    t.store.dispatch({ type: "presentation_done" });
    await t.run(2000);                                   // judge_3 (tough) asks
    const ramble = "so um basically the thing is that we like have many ideas and um you know the market is big and we are sort of figuring it out as we go along with the pricing and everything";
    for (let i = 0; i < 6; i++) { await t.run(1800, () => voiced()); t.phrase(ramble, "qa", ["um", "basically", "like"]); }
    expect(t.said.map((s) => s.judge)).toEqual(["judge_3", "judge_3"]);
    expect(t.said[1]!.text).toBe("Let me stop you there.");
    expect(t.board.judgeLines().filter((l) => l.kind !== "reaction").map((l) => [l.kind, l.text])).toContainEqual(["followup", "Let me stop you there."]);
    await t.run(2100);                                   // no LLM: the follow-up asks for the short version
    expect(t.said.at(-1)!.text).toMatch(/^In one sentence, please\. /);
  });
});

describe("director agent: live reactions", () => {
  it("numbers → a note; at most one reaction per 8 s; rambling → the toughest checks the watch", async () => {
    const t = rig({ noLlm: true });
    await t.toPresentation();
    await t.run(8000);
    t.phrase("We have 40 paying teams after three months.", "presentation");
    expect(t.gestures).toEqual(["judge_3:note"]);
    t.phrase("And we are the only ones doing this.", "presentation");
    expect(t.gestures).toEqual(["judge_3:note"]);       // too soon
    await t.run(8000);
    t.phrase("So um the thing is that we basically um built it ourselves and like it took a long while to get it right for everyone", "presentation", ["um", "basically", "um", "like"]);
    expect(t.gestures).toEqual(["judge_3:note", "judge_3:check_watch"]);
    expect(t.board.judgeLines().filter((l) => l.kind === "reaction").map((l) => l.judgeId)).toEqual(["judge_3", "judge_3"]);
  });
});
