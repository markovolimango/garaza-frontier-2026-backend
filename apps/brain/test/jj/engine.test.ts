import { describe, expect, it } from "vitest";
import { AUDIO_FLAG } from "@coach/protocol";
import { JJEngine } from "../../src/jj/engine.ts";
import { FakeVoiceAgent } from "../../src/jj/fake-agent.ts";
import { ToolRegistry, createCoachTools } from "../../src/jj/tools.ts";
import { FakeContext, FakeHub, FakeMic, FakeReports, FakeSession, VirtualClock, flush, silent, voiced } from "../helpers.ts";

function setup() {
  const clock = new VirtualClock();
  const session = new FakeSession(clock);
  const hub = new FakeHub();
  const mic = new FakeMic();
  const reports = new FakeReports();
  const agent = new FakeVoiceAgent();
  const tools = createCoachTools({ session, context: new FakeContext(), reports, hub, judgeVoices: ["a", "b", "c"] }, new ToolRegistry(() => clock.now()));
  const engine = new JJEngine({ agent, tools, session, hub, mic, reports, clock, systemPrompt: "SYS", voice: "Puck", connectRetryMs: 1000 });
  // Mirror the spec's mic routing table so tests read naturally.
  session.subscribe((s) => {
    mic.jj = ["intro", "calibrating", "debrief", "final"].includes(s.phase) || (s.phase === "running" && s.wake.active);
  });
  engine.start();
  return { clock, session, hub, mic, reports, agent, tools, engine };
}

async function toIntro() {
  const t = setup();
  t.session.dispatch({ type: "session_start" });
  await flush();
  return t;
}

async function toPresentation() {
  const t = await toIntro();
  t.session.dispatch({ type: "start_run" });
  t.session.setRunPhase("presentation");
  return t;
}

describe("JJEngine: connection and greeting", () => {
  it("does not connect in setup; connects and greets on session_start", async () => {
    const t = setup();
    expect(t.agent.connects).toHaveLength(0);
    t.session.dispatch({ type: "session_start" });
    await flush();
    expect(t.agent.connects).toHaveLength(1);
    expect(t.agent.connects[0]).toMatchObject({ systemPrompt: "SYS", voice: "Puck" });
    expect(t.agent.connects[0]!.tools).toHaveLength(21);
    expect(t.agent.connects[0]!.contextText).toMatch(/^\[SESSION CONTEXT]/);
    expect(t.agent.sentText).toEqual([{ text: expect.stringMatching(/^\[SESSION START] first session/), turnComplete: true }]);
    expect(t.hub.ofType("jj.state").at(-1)!.payload).toEqual({ connected: true, listening: true, speaking: false });
  });

  it("gives the agent a context provider with digest, panel and coach state", async () => {
    const t = await toIntro();
    const ctx = t.agent.contextProvider!();
    expect(ctx).toContain("A pitch.");
    expect(ctx).toContain("judge_1");
    expect(ctx).toContain('"stage":"baseline"');
  });

  it("shows a toast and retries when the connect fails", async () => {
    const t = setup();
    t.agent.failNextConnect = new Error("boom");
    t.session.dispatch({ type: "session_start" });
    await flush();
    expect(t.hub.ofType("hud.toast")[0]!.payload.level).toBe("warn");
    expect(t.agent.connected).toBe(false);
    t.clock.advance(1000);
    await flush();
    expect(t.agent.connects).toHaveLength(2);
    expect(t.agent.connected).toBe(true);
  });

  it("publishes jj.state to stage and operator only on change", async () => {
    const t = await toIntro();
    const before = t.hub.ofType("jj.state").length;
    t.agent.speak();
    t.agent.speak();
    const states = t.hub.sent.filter((x) => x.msg.type === "jj.state").slice(before);
    expect(states.map((x) => x.role)).toEqual(["stage", "operator"]);
    expect(states[0]!.msg.payload).toMatchObject({ speaking: true });
  });

  it("toasts when the agent drops and closes on reset", async () => {
    const t = await toIntro();
    t.agent.drop();
    expect(t.hub.ofType("hud.toast").at(-1)!.payload.text).toMatch(/reconnecting/);
    t.session.dispatch({ type: "reset" });
    expect(t.agent.closes).toBe(1);
  });
});

describe("JJEngine: full-duplex audio", () => {
  it("forwards mic frames only while the router includes jj", async () => {
    const t = await toIntro();
    t.engine.acceptMic(voiced());
    expect(t.agent.sentAudio).toHaveLength(1);
    t.session.dispatch({ type: "start_run" });
    t.engine.acceptMic(voiced());
    expect(t.agent.sentAudio).toHaveLength(1);
  });

  it("frames each JJ utterance on source 0: actor.say + start flag, then an end-flagged empty frame", async () => {
    const t = await toIntro();
    t.agent.speak(2400);
    t.agent.speak(2400);
    t.agent.finishTurn();
    t.agent.speak(100);
    t.agent.finishTurn();
    expect(t.hub.audio).toEqual([
      { source: 0, flags: AUDIO_FLAG.utteranceStart, seq: 1, samples: 2400 },
      { source: 0, flags: 0, seq: 1, samples: 2400 },
      { source: 0, flags: AUDIO_FLAG.utteranceEnd, seq: 1, samples: 0 },
      { source: 0, flags: AUDIO_FLAG.utteranceStart, seq: 2, samples: 100 },
      { source: 0, flags: AUDIO_FLAG.utteranceEnd, seq: 2, samples: 0 },
    ]);
    expect(t.hub.ofType("actor.say").map((m) => m.payload)).toEqual([
      { actorId: "jj", utteranceId: "jj_u1", source: 0, text: "" },
      { actorId: "jj", utteranceId: "jj_u2", source: 0, text: "" },
    ]);
  });

  it("barge-in flushes JJ audio on the stage", async () => {
    const t = await toIntro();
    t.agent.speak();
    t.agent.bargeIn();
    expect(t.hub.ofType("audio.stop")).toEqual([{ type: "audio.stop", payload: { source: 0, utteranceId: "jj_u1" } }]);
    expect(t.hub.audio.filter((a) => a.flags & AUDIO_FLAG.utteranceEnd)).toHaveLength(0);
  });

  it("start_run interrupts JJ mid-sentence and stops its audio", async () => {
    const t = await toIntro();
    t.agent.speak();
    await t.agent.callTool("start_run");
    expect(t.agent.interrupts).toBe(1);
    expect(t.hub.ofType("audio.stop")).toHaveLength(1);
  });

  it("drops JJ audio during a run unless woken", async () => {
    const t = await toPresentation();
    t.agent.speak();
    expect(t.hub.audio).toHaveLength(0);
    expect(t.hub.ofType("actor.say")).toHaveLength(0);
  });
});

describe("JJEngine: wake mid-run", () => {
  it("sends the wake note, then the buffered audio from 300 ms before the phrase, then live audio", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "slide", index: 3 });
    const phraseStart = t.clock.now() - 800;
    t.engine.noteWakePhrase(phraseStart);
    t.session.dispatch({ type: "wake", via: "phrase" });
    await flush();
    expect(t.agent.sentText.at(-1)).toEqual({ text: "[WOKEN DURING RUN: presentation, slide 4]", turnComplete: false });
    expect(t.mic.replayed).toEqual([phraseStart - 300]);
    expect(t.agent.sentAudio).toHaveLength(50);              // 1 s buffer in 20 ms frames
    expect(t.agent.sentAudio[0]).toHaveLength(320);
    t.engine.acceptMic(voiced());
    expect(t.agent.sentAudio).toHaveLength(51);
  });

  it("names the Q&A segment and skips replay for push-to-talk", async () => {
    const t = await toPresentation();
    t.session.setRunPhase("qa");
    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    expect(t.agent.textsMatching(/WOKEN/)).toEqual(["[WOKEN DURING RUN: Q&A, slide 1]"]);
    expect(t.mic.replayed).toEqual([]);
  });

  it("lets JJ speak while woken and auto-resumes after JJ finished and 2.5 s of user silence", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    // user keeps talking for 3 s: no resume
    for (let i = 0; i < 150; i++) { t.engine.acceptMic(voiced()); t.clock.advance(20); }
    expect(t.session.s.run!.paused).toBe(true);
    // JJ answers with 1 s of audio
    t.agent.speak(24000);
    t.agent.finishTurn();
    expect(t.hub.audio[0]!.flags).toBe(AUDIO_FLAG.utteranceStart);
    // 1 s of playback + 2.4 s silence: still paused
    for (let i = 0; i < 170; i++) { t.engine.acceptMic(silent()); t.clock.advance(20); }
    expect(t.session.s.run!.paused).toBe(true);
    t.clock.advance(200);
    expect(t.session.s.run!.paused).toBe(false);
    expect(t.session.actions.at(-1)).toEqual({ type: "resume" });
  });

  it("a user transcript while woken also counts as speech", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    t.agent.speak(2400); t.agent.finishTurn();
    t.clock.advance(2000);
    t.agent.transcript({ who: "user", text: "and also", final: false });
    t.clock.advance(2000);
    expect(t.session.s.run!.paused).toBe(true);
    t.clock.advance(600);
    expect(t.session.s.run!.paused).toBe(false);
  });

  it("resumes after the no-reply safety timeout when JJ never answers", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "operator" });
    await flush();
    t.clock.advance(9_900);
    expect(t.session.s.run!.paused).toBe(true);
    t.clock.advance(200);
    expect(t.session.s.run!.paused).toBe(false);
  });

  it("stops tracking when JJ resumes via the tool; a later late reply is dropped", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    expect(await t.agent.callTool("resume_run")).toEqual({ ok: true });
    expect(t.clock.pending()).toBe(0);
    t.agent.speak();
    expect(t.hub.audio).toHaveLength(0);
  });

  it("an utterance started while woken may finish after the run resumes", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    t.agent.speak();
    await t.agent.callTool("resume_run");
    t.agent.speak();
    t.agent.finishTurn();
    expect(t.hub.audio.map((a) => a.flags)).toEqual([AUDIO_FLAG.utteranceStart, 0, AUDIO_FLAG.utteranceEnd]);
  });

  it("a 'make them tougher' wake changes the panel and resumes", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "wake", via: "phrase" });
    await flush();
    expect(await t.agent.callTool("set_judges", { toughness: 0.9 })).toMatchObject({ ok: true });
    expect(await t.agent.callTool("resume_run")).toEqual({ ok: true });
    expect(t.session.s.scene.judges.every((j) => j.toughness === 0.9)).toBe(true);
    expect(t.session.s.run!.paused).toBe(false);
  });
});

describe("JJEngine: debrief and UI notes", () => {
  it("sends [RUN ENDED] with the compact report once when the run reaches debrief", async () => {
    const t = await toPresentation();
    t.reports.reports.set("run_1", { run_id: "run_1", patterns: [{ kind: "arms_crossed" }] });
    t.session.dispatch({ type: "end_run" });
    await flush();
    const ended = t.agent.sentText.filter((x) => x.text.startsWith("[RUN ENDED]"));
    expect(ended).toEqual([{ text: '[RUN ENDED] {"run_id":"run_1","patterns":[{"kind":"arms_crossed"}]}', turnComplete: true }]);
    t.session.dispatch({ type: "set_targets", targets: ["arms_crossed"] });
    await flush();
    expect(t.agent.textsMatching(/RUN ENDED/)).toHaveLength(1);
  });

  it("tells JJ about aborted runs", async () => {
    const t = await toPresentation();
    t.session.dispatch({ type: "abort_run" });
    await flush();
    expect(t.agent.textsMatching(/^\[RUN ABORTED] run_1/)).toHaveLength(1);
  });

  it("notes successful UI tool invocations to JJ silently, but not its own or read-only ones", async () => {
    const t = await toIntro();
    const n = t.agent.sentText.length;
    await t.tools.invoke("set_audience", { count: 5 }, "operator");
    await t.tools.invoke("highlight_pattern", { kind: "sway" }, "stage");
    await t.agent.callTool("set_qa", { questions: 1 });
    await t.tools.invoke("set_qa", { questions: 9 }, "stage");   // invalid: not noted
    const notes = t.agent.sentText.slice(n);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ turnComplete: false, text: expect.stringMatching(/^\[UI ACTION] the operator ran set_audience \{"count":5\}/) });
  });

  it("routes agent tool calls through the registry with caller jj", async () => {
    const t = await toIntro();
    expect(await t.agent.callTool("set_lighting", { preset: "stage" })).toMatchObject({ ok: true });
    expect(t.session.s.scene.lighting).toBe("stage");
    expect(await t.agent.callTool("set_lighting", { preset: "disco" })).toMatchObject({ ok: false, reason: "invalid_args" });
  });

  it("reconnect() closes and reconnects", async () => {
    const t = await toIntro();
    await t.engine.reconnect();
    expect(t.agent.closes).toBe(1);
    expect(t.agent.connects).toHaveLength(2);
    expect(t.engine.status().connected).toBe(true);
  });
});

describe("JJEngine: captions (jj.transcript)", () => {
  const lines = (t: Awaited<ReturnType<typeof toIntro>>, role = "stage") =>
    t.hub.sent.filter((x) => x.role === role && x.msg.type === "jj.transcript").map((x) => x.msg.payload as { lineId: string; who: string; text: string; final: boolean; utteranceId?: string });

  it("relays what JJ and the user say outside runs, to the stage and the operator", async () => {
    const t = await toIntro();
    t.agent.transcript({ who: "user", text: "Hi JJ, I'm", final: false });
    t.agent.transcript({ who: "user", text: " ready.", final: false });
    t.clock.advance(1500);                                   // the user stopped: line final
    t.agent.speak();                                         // JJ's utterance jj_u1 starts
    t.agent.transcript({ who: "jj", text: "Great,", final: false });
    t.agent.transcript({ who: "jj", text: " let's start.", final: false });
    t.agent.finishTurn();
    t.clock.advance(2000);
    expect(lines(t).map((l) => [l.who, l.text, l.final])).toEqual([
      ["user", "Hi JJ, I'm", false],
      ["user", "Hi JJ, I'm ready.", false],
      ["user", "Hi JJ, I'm ready.", true],
      ["jj", "Great,", false],
      ["jj", "Great, let's start.", false],
      ["jj", "Great, let's start.", true],
    ]);
    expect(lines(t).at(-1)!.utteranceId).toBe("jj_u1");
    expect(lines(t, "operator")).toEqual(lines(t));
  });

  it("stays quiet mid-presentation, captions a wake, and closes JJ's line when a run starts", async () => {
    const t = await toPresentation();
    t.agent.transcript({ who: "jj", text: "Late reply nobody should see.", final: false });
    t.agent.transcript({ who: "user", text: "talking to the audience", final: false });
    t.clock.advance(2000);
    expect(lines(t)).toEqual([]);

    t.session.dispatch({ type: "wake", via: "ptt" });
    await flush();
    t.agent.transcript({ who: "user", text: "Am I too fast?", final: true });
    t.agent.speak();
    t.agent.transcript({ who: "jj", text: "A little. Breathe", final: false });
    expect(lines(t).map((l) => l.text)).toEqual(["Am I too fast?", "A little. Breathe"]);
    t.agent.bargeIn();                                       // the user talks over JJ: JJ's line ends
    expect(lines(t).at(-1)).toMatchObject({ who: "jj", text: "A little. Breathe", final: true });
  });

  it("start_run ends open lines; nothing after that while the run is live", async () => {
    const t = await toIntro();
    t.agent.speak();
    t.agent.transcript({ who: "jj", text: "Off you go", final: false });
    await t.agent.callTool("start_run");
    expect(lines(t).at(-1)).toMatchObject({ text: "Off you go", final: true });
    const n = lines(t).length;
    t.agent.transcript({ who: "jj", text: " and good luck!", final: false });
    t.clock.advance(3000);
    expect(lines(t)).toHaveLength(n);
  });
});
