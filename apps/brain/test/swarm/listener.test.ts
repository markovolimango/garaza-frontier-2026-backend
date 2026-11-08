/** Swarm listener (Gemini Live filler detector) and the filler feedback agent, without the network. */
import { describe, expect, it } from "vitest";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import { GREYBOX_VENUE, type DownlinkMessage, type SceneDef, type Uplink } from "@coach/protocol";
import { buildDigest } from "../../src/digest.ts";
import { observedCoach } from "../../src/observedCoach.ts";
import { behaviorCounts, RunLog } from "../../src/runlog.ts";
import { SessionStore } from "../../src/session.ts";
import { SwarmBoard, type Phrase } from "../../src/swarm/board.ts";
import { FillerFeedback } from "../../src/swarm/feedback.ts";
import { Listener, type ListenerSessionLike } from "../../src/swarm/listener.ts";
import { VirtualClock, flush, judge } from "../helpers.ts";

class FakeLive implements ListenerSessionLike {
  realtime: Record<string, unknown>[] = []; toolResponses: unknown[] = []; closed = false;
  constructor(readonly params: LiveConnectParameters) {}
  sendRealtimeInput(p: Record<string, unknown>) { this.realtime.push(p); }
  sendToolResponse(p: unknown) { this.toolResponses.push(p); }
  close() { this.closed = true; }
  get audioFrames() { return this.realtime.filter((p) => p.audio).length; }
  get streamEnds() { return this.realtime.filter((p) => p.audioStreamEnd).length; }
  msg(m: Partial<LiveServerMessage>) { this.params.callbacks.onmessage(m as LiveServerMessage); }
  report(args: { phrase?: string; fillers: string[] }, id = "c1") { this.msg({ toolCall: { functionCalls: [{ id, name: "report_fillers", args }] } }); }
  serverClose(code = 1011) { this.params.callbacks.onclose?.({ code, reason: "x" } as never); }
}

const SCENE: SceneDef = { version: 1, venueId: "greybox", qa: { questions: 1, answerCapMs: 45_000 }, judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default" };
const DECK = { deckId: "deck_abc", name: "acme", slides: [0, 1, 2].map((i) => ({ index: i, url: `/x/${i}.png`, text: `slide ${i}` })) };
const LOUD = Int16Array.from({ length: 320 }, () => 3000);
const QUIET = new Int16Array(320);

function rig(o: { key?: string | null; failConnects?: number } = {}) {
  const clock = new VirtualClock();
  let runLog: RunLog | null = null;
  const coach = observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: 1, maxTrainingRuns: 5 });
  const store = new SessionStore({
    clock, coach, venue: GREYBOX_VENUE, initialScene: SCENE, newSessionId: () => "sess1",
    stage: { isConnected: () => true, send: () => true },
  });
  const micFns: ((pcm: Int16Array) => void)[] = [];
  const outFns: ((m: DownlinkMessage, roles: unknown[]) => void)[] = [];
  const playbackFns: ((m: Uplink<"audio.playback">) => void)[] = [];
  const hub = {
    onMic: (fn: (pcm: Int16Array) => void) => { micFns.push(fn); },
    onOutbound: (fn: (m: DownlinkMessage, roles: unknown[]) => void) => { outFns.push(fn); },
    on: (_t: "audio.playback", fn: (m: Uplink<"audio.playback">) => void) => { playbackFns.push(fn); },
  };
  runLog = new RunLog({ session: store, hub: { on: () => {}, onOutbound: () => {}, connections: () => ({ stage: true, sensor: true, operator: false }) }, clock });
  const board = new SwarmBoard({ clock });
  const vignettes: [string, number, number][] = [];
  const sync = { forceVignette: (k: "warn" | "reward", i: number, h: number) => { vignettes.push([k, i, h]); } };
  new FillerFeedback({ board, session: store, sync, clock });
  const sessions: FakeLive[] = [];
  let failConnects = o.failConnects ?? 0;
  const listener = new Listener({
    board, session: store, hub, runLog, clock, apiKey: o.key === undefined ? "k" : o.key, model: "gemini-3.1-flash-live-preview", speechRms: 700,
    connect: async (p) => {
      if (failConnects > 0) { failConnects--; throw new Error("refused"); }
      const s = new FakeLive(p); sessions.push(s); return s;
    },
  });
  const phrases: Phrase[] = [];
  const fillers: string[][] = [];
  board.on("phrase", (e) => phrases.push(e.phrase));
  board.on("filler", (e) => fillers.push(e.words));
  const notes: string[] = [];
  board.on("agent.note", (e) => notes.push(e.text));

  /** `ms` of mic frames (20 ms each), loud or quiet. */
  const talk = (ms: number, loud = true) => { for (let t = 0; t < ms; t += 20) { clock.advance(20); for (const f of micFns) f(loud ? LOUD : QUIET); } };
  const out = (m: DownlinkMessage) => { for (const f of outFns) f(m, ["stage"]); };
  const playback = (utteranceId: string, state: "started" | "ended" | "stopped") => {
    for (const f of playbackFns) f({ payload: { source: 2, utteranceId, state } } as Uplink<"audio.playback">);
  };
  const d = (a: Parameters<SessionStore["dispatch"]>[0]) => expect(store.dispatch(a)).toEqual({ ok: true });
  /** start_run → countdown → presentation (session connected). */
  const present = async (a: { mode?: "training" | "baseline"; level?: "strong" | "gentle" } = {}) => {
    d({ type: "start_run", ...a });
    clock.advance(3000);
    await flush();
  };
  const status = (id: "listener" | "feedback") => board.allStatuses().find((s) => s.id === id)!;
  store.setContext({ deck: DECK });
  d({ type: "session_start" });
  return { clock, store, runLog, board, listener, sessions, phrases, fillers, notes, vignettes, talk, out, playback, d, present, status };
}

describe("listener: session per run", () => {
  it("without a key it stays off and never connects", async () => {
    const t = rig({ key: null });
    await t.present();
    t.talk(500);
    expect(t.sessions).toHaveLength(0);
    expect(t.status("listener")).toMatchObject({ state: "off", detail: expect.stringContaining("no Gemini key") });
  });

  it("opens a silent Live session when the presentation starts, keeps it through the Q&A, closes after the run", async () => {
    const t = rig();
    t.d({ type: "start_run" });
    await flush();
    expect(t.sessions).toHaveLength(0);                                    // countdown: not yet
    t.clock.advance(3000);
    await flush();
    expect(t.sessions).toHaveLength(1);
    const { model, config } = t.sessions[0]!.params;
    expect(model).toBe("gemini-3.1-flash-live-preview");
    expect(config).toMatchObject({
      responseModalities: ["AUDIO"],
      systemInstruction: expect.stringContaining("Never speak"),
      tools: [{ functionDeclarations: [expect.objectContaining({ name: "report_fillers" })] }],
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 400 } },
    });
    expect(t.status("listener")).toMatchObject({ state: "listening", detail: "slide 1 · 0 fillers" });
    t.d({ type: "presentation_done" });                                    // → Q&A: same session
    expect(t.store.get().run!.phase).toBe("qa");
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]!.closed).toBe(false);
    t.d({ type: "qa_done" });                                              // run over: grace for the last phrase
    expect(t.sessions[0]!.closed).toBe(false);
    expect(t.sessions[0]!.streamEnds).toBeGreaterThan(0);
    t.sessions[0]!.report({ phrase: "um that's it", fillers: ["um"] });   // late report still lands
    expect(t.phrases).toHaveLength(1);
    t.clock.advance(3000);
    expect(t.sessions[0]!.closed).toBe(true);
    expect(t.status("listener")).toMatchObject({ state: "idle", detail: "waiting for a run" });
    expect(t.notes).toEqual([expect.stringContaining("run 1: 1 phrases, 1 filler word (um 1)")]);
  });

  it("an aborted run closes its session; the next run opens a new one", async () => {
    const t = rig();
    await t.present();
    t.d({ type: "abort_run" });
    t.clock.advance(3000);
    expect(t.sessions[0]!.closed).toBe(true);
    await t.present();
    expect(t.sessions).toHaveLength(2);
    expect(t.listener.runId).toBe("run_2");
    expect(t.sessions[1]!.closed).toBe(false);
  });

  it("reconnects when the session drops while the run is live, and after a failed connect", async () => {
    const t = rig();
    await t.present();
    t.sessions[0]!.serverClose();
    expect(t.status("listener")).toMatchObject({ state: "working", detail: expect.stringContaining("reconnecting") });
    t.talk(100);
    expect(t.sessions[0]!.audioFrames).toBe(0);
    t.clock.advance(500);
    await flush();
    expect(t.sessions).toHaveLength(2);
    t.talk(100);
    expect(t.sessions[1]!.audioFrames).toBe(5);
    expect(t.status("listener").state).toBe("listening");
    // dropped after the run ended: no reconnect
    t.d({ type: "end_run" });
    t.sessions[1]!.serverClose();
    t.clock.advance(10_000);
    await flush();
    expect(t.sessions).toHaveLength(2);
  });

  it("retries a refused connect with backoff and gives up with an error status", async () => {
    const t = rig({ failConnects: 99 });
    await t.present();
    for (let i = 0; i < 8; i++) { t.clock.advance(5000); await flush(); }
    expect(t.sessions).toHaveLength(0);
    t.talk(200);                                                            // mic frames keep the error status
    expect(t.status("listener")).toMatchObject({ state: "error", detail: expect.stringContaining("refused") });
    const ok = rig({ failConnects: 1 });
    await ok.present();
    ok.clock.advance(500);
    await flush();
    expect(ok.sessions).toHaveLength(1);
    expect(ok.status("listener").state).toBe("listening");
  });
});

describe("listener: audio gate", () => {
  it("sends every frame while live; nothing while paused (JJ) and for a 400 ms tail after", async () => {
    const t = rig();
    await t.present();
    const s = t.sessions[0]!;
    t.talk(200);
    expect(s.audioFrames).toBe(10);
    expect(s.realtime[0]).toMatchObject({ audio: { mimeType: "audio/pcm;rate=16000", data: expect.any(String) } });
    t.d({ type: "wake", via: "ptt" });
    expect(s.streamEnds).toBe(1);                                           // flush the model's VAD
    expect(t.status("listener").detail).toContain("paused");
    t.talk(1000);
    expect(s.audioFrames).toBe(10);
    t.d({ type: "resume" });
    t.talk(380);
    expect(s.audioFrames).toBe(10);                                         // echo tail
    t.talk(100);
    expect(s.audioFrames).toBe(15);
  });

  it("nothing while a judge speaks: actor.say until playback ended (+ tail), or until the estimate runs out", async () => {
    const t = rig();
    await t.present();
    t.d({ type: "presentation_done" });
    const s = t.sessions[0]!;
    t.out({ type: "actor.say", payload: { actorId: "judge_2", utteranceId: "judge_2_u1", source: 2, text: "What is your moat?" } });
    expect(t.status("listener").detail).toContain("a judge is speaking");
    t.talk(1000);
    expect(s.audioFrames).toBe(0);
    t.playback("judge_2_u1", "ended");
    t.talk(380);
    expect(s.audioFrames).toBe(0);
    t.talk(100);
    expect(s.audioFrames).toBe(5);
    // no playback report and no idle gesture: the estimate (3 s + 80 ms per char) reopens the gate
    t.out({ type: "actor.say", payload: { actorId: "judge_1", utteranceId: "judge_1_u2", source: 1, text: "x".repeat(10) } });
    t.talk(3700);
    expect(s.audioFrames).toBe(5);
    t.talk(200);
    expect(s.audioFrames).toBeGreaterThan(5);
    // the judge's idle gesture also ends it
    const before = s.audioFrames;
    t.out({ type: "actor.say", payload: { actorId: "judge_3", utteranceId: "judge_3_u3", source: 3, text: "long question ".repeat(20) } });
    t.talk(200);
    t.out({ type: "actor.gesture", payload: { actorId: "judge_3", gesture: "idle" } });
    t.talk(500);
    expect(s.audioFrames).toBe(before + 6);                                 // frames at +400 … +500 after the idle gesture
  });
});

describe("listener: phrases, fillers and the run log", () => {
  it("each report_fillers → answered, a phrase with the gate's speech times and slide, and a filler event", async () => {
    const t = rig();
    await t.present();
    const s = t.sessions[0]!;
    t.d({ type: "slide", index: 1, from: "stage" });
    t.talk(200, false);
    const speechStart = t.clock.now();
    t.talk(1500);
    const speechEnd = t.clock.now();
    t.talk(600, false);
    s.report({ phrase: "So, um, our product is like fast", fillers: ["um", "Like"] }, "call_7");
    expect(s.toolResponses).toEqual([{ functionResponses: [{ id: "call_7", name: "report_fillers", response: { ok: true } }] }]);
    expect(t.phrases).toEqual([{ runId: "run_1", segment: "presentation", text: "So, um, our product is like fast", fillers: ["um", "like"], startAt: speechStart, endAt: speechEnd, slideIndex: 1 }]);
    expect(t.fillers).toEqual([["um", "like"]]);
    expect(t.board.phrases("run_1" as never)).toHaveLength(1);
    s.report({ phrase: "It saves time.", fillers: [] }, "call_8");
    expect(t.phrases).toHaveLength(2);
    expect(t.fillers).toHaveLength(1);                                     // no filler event without fillers
    expect(t.status("listener")).toMatchObject({ state: "listening", detail: "slide 2 · 2 fillers" });
    // Q&A phrases are marked as such
    t.d({ type: "presentation_done" });
    t.talk(600);
    t.talk(600, false);
    s.report({ phrase: "Uh, good question.", fillers: ["uh"] }, "call_9");
    expect(t.phrases.at(-1)).toMatchObject({ segment: "qa", fillers: ["uh"] });
  });

  it("a burst (≥ 2 fillers within 10 s) becomes one filler_burst observation; reports and the coach see it", async () => {
    const t = rig();
    await t.present();
    const s = t.sessions[0]!;
    const phrase = (text: string, fillers: string[]) => { t.talk(1000); t.talk(500, false); s.report({ phrase: text, fillers }); };
    phrase("Um, hello.", ["um"]);
    expect(t.runLog.latest()!.observations).toHaveLength(0);
    phrase("Uh, we are, like, a team.", ["uh", "like"]);                 // 3 within 10 s → one burst
    const obs = t.runLog.latest()!.observations;
    expect(obs).toEqual([expect.objectContaining({ rule: "speech.fillers", kind: "filler_burst", category: "disfluencies", slideIndex: 0, segment: "presentation" })]);
    expect(obs[0]!.text).toContain("3 filler words");
    t.talk(15_000, false);
    phrase("Um, next slide.", ["um"]);                                     // alone: no burst
    expect(t.runLog.latest()!.observations).toHaveLength(1);
    phrase("Er, so, yes.", ["er", "so"]);
    expect(t.runLog.latest()!.observations).toHaveLength(2);
    t.d({ type: "end_run" });
    const rec = t.runLog.latest()!;
    expect(behaviorCounts(rec).get("filler_burst")).toBe(2);
    expect(JSON.stringify(buildDigest(rec, null))).toContain("Filler words");
    expect(t.store.get().coach.targets.map((x) => x.kind)).toContain("filler_burst");   // baseline → a training target
  });
});

describe("feedback agent: filler vignette", () => {
  const phraseIn = (t: ReturnType<typeof rig>, fillers: string[]) => { t.talk(800); t.talk(500, false); t.sessions[0]!.report({ phrase: fillers.join(" ") + " hello", fillers }); };

  it("burst (default): fires on ≥ 2 fillers within 10 s, strong = 0.7 for 2.5 s; not in a baseline run", async () => {
    const base = rig();
    await base.present();
    phraseIn(base, ["um", "uh", "like"]);
    expect(base.vignettes).toEqual([]);                                      // feedbackLevel off
    expect(base.status("feedback").detail).toContain("no live feedback");

    const t = rig();
    await t.present({ mode: "training", level: "strong" });
    phraseIn(t, ["um"]);
    expect(t.vignettes).toEqual([]);
    phraseIn(t, ["uh"]);
    expect(t.vignettes).toEqual([["warn", 0.7, 2500]]);
    expect(t.status("feedback")).toMatchObject({ state: "working", detail: expect.stringMatching(/^red: 2 fillers in \d+ s$/) });
    phraseIn(t, ["like"]);                                                  // counting starts again after a vignette
    expect(t.vignettes).toHaveLength(1);
    t.clock.advance(2500);
    expect(t.status("feedback")).toMatchObject({ state: "watching", detail: "fillers: burst · 1 shown" });
  });

  it("every / off policies, gentle intensity, paused runs", async () => {
    const t = rig();
    await t.present({ mode: "training", level: "gentle" });
    t.board.command({ type: "feedback.policy", fillers: "every", body: "targets" });
    phraseIn(t, ["um"]);
    expect(t.vignettes).toEqual([["warn", 0.4, 2500]]);
    t.board.command({ type: "feedback.policy", fillers: "off", body: "targets" });
    phraseIn(t, ["um", "uh"]);
    expect(t.vignettes).toHaveLength(1);
    t.board.command({ type: "feedback.policy", fillers: "every", body: "targets" });
    t.d({ type: "wake", via: "ptt" });
    t.sessions[0]!.report({ phrase: "um", fillers: ["um"] });              // a late report while JJ listens
    expect(t.vignettes).toHaveLength(1);
  });

  it("with targets fires only when filler_burst is one; without targets only if disfluencies is enabled", async () => {
    const other = rig();
    other.d({ type: "set_targets", targets: ["arms_crossed"] });
    await other.present({ mode: "training", level: "strong" });
    phraseIn(other, ["um", "uh"]);
    expect(other.vignettes).toEqual([]);
    expect(other.status("feedback").detail).toContain("not a target");

    const target = rig();
    target.d({ type: "set_targets", targets: ["arms_crossed", "filler_burst"] });
    await target.present({ mode: "training", level: "strong" });
    phraseIn(target, ["um", "uh"]);
    expect(target.vignettes).toHaveLength(1);

    const noDisfl = rig();
    noDisfl.d({ type: "set_categories", enabled: ["posture"] });
    await noDisfl.present({ mode: "training", level: "strong" });
    expect(noDisfl.store.get().run!.enabledCategories).not.toContain("disfluencies");
    phraseIn(noDisfl, ["um", "uh"]);
    expect(noDisfl.vignettes).toEqual([]);
  });
});
