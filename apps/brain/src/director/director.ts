/**
 * Director (Q&A): when a run enters the Q&A, the judges ask `scene.qa.questions` questions
 * (questions.ts), each through JudgeVoices (actor.say + ElevenLabs audio + talk/idle gestures).
 * After a question it listens to the presenter on the mic (/ws/mic, any route): the answer ends
 * after `silenceMs` of silence following speech, after `noAnswerMs` without speech, or at the
 * answer cap. A wake (JJ listening) holds the Q&A until the run resumes. After the last answer
 * a judge closes and the director dispatches `qa_done`. Ending the run early cancels it.
 *
 * Gaze (`actor.lookAt`, sent on change): the judge about to ask looks down at their notes for
 * `thinkMs`, then at the presenter while the others turn to that judge; during the answer the
 * whole panel watches the presenter. While JJ is woken they wait looking at their notes.
 *
 * With a `strategy` (the swarm's director agent, director/agent.ts) the plan comes from it, each
 * answer's words are stored with the turn, and after every answer it decides: a follow-up from the
 * same judge (at most one per question), the next planned question, or closing early. It may also
 * let a judge cut in on a rambling answer. Without one the Q&A runs as before (template plan).
 */
import type { Downlink, JudgeId, LookTarget, RunId, SessionState } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import { rms } from "../jj/pcm.ts";
import type { Logger } from "../log.ts";
import type { RunLog } from "../runlog.ts";
import type { SessionStore } from "../session.ts";
import { CLOSING_LINE, planQuestions, type PlannedQuestion } from "./questions.ts";

export interface DirectorVoices { speakJudge(actorId: JudgeId, text: string): { utteranceId: string; done: Promise<void> } }
export interface DirectorHub {
  onMic(fn: (pcm16k: Int16Array) => void): void;
  send(role: "stage", msg: Downlink<"actor.gesture" | "actor.lookAt">): boolean;
}

export interface DirectorOptions {
  session: SessionStore;
  hub: DirectorHub;
  voices: DirectorVoices;
  clock: Clock;
  log?: Logger;
  runLog?: RunLog;
  /** Mic RMS (Int16) that counts as speech. Default 700 (JJ_SPEECH_RMS). */
  speechRms?: number;
  /** Silence after speech that ends an answer. Default 1800 ms. */
  silenceMs?: number;
  /** No speech at all for this long: move on. Default 12 s. */
  noAnswerMs?: number;
  /** Overrides scene.qa.answerCapMs. */
  answerCapMs?: number;
  /** Ignore the mic this long after a judge stops (speaker echo). Default 400 ms. */
  echoGuardMs?: number;
  /** The judge about to ask looks at their notes this long first. Default 700 ms (0: no pause). */
  thinkMs?: number;
  /** The director agent: plan, answers, follow-ups, interrupts, judge lines, status. */
  strategy?: DirectorStrategy;
}

export type TurnKind = "question" | "followup";
/** One asked question (or follow-up) and its answer. */
export interface AskedTurn {
  q: PlannedQuestion; kind: TurnKind; askedAt: number;
  /** When the judge finished asking and the panel started listening. */
  listenFrom: number; endedAt: number; lastVoiceAt: number; answerMs: number;
  /** A judge cut in (interrupt). */
  interrupted: boolean; answer: string;
}
export type NextStep = { type: "followup"; text: string } | { type: "next" } | { type: "close"; text?: string };
export type LineKind = "question" | "followup" | "closing" | "interrupt";
export type DirectorState = "speaking" | "listening" | "thinking" | "idle";
export interface CutIn { judgeId: JudgeId; text: string }

export interface DirectorStrategy {
  /** The questions for the Q&A starting now: a plan prepared during the presentation (synchronous, no wait). */
  plan(runId: RunId, s: Readonly<SessionState>): PlannedQuestion[];
  /** The answer's words (may wait briefly for the transcript). "" when unknown. */
  answer(runId: RunId, turn: AskedTurn): Promise<string>;
  /** After each answer. Must settle within its own timeout; a rejection counts as "next". */
  decide(runId: RunId, a: { turn: AskedTurn; followUpAllowed: boolean; remaining: PlannedQuestion[]; turns: AskedTurn[] }): Promise<NextStep>;
  /** Polled while the presenter answers: a judge and a line → that judge cuts in. */
  interrupt?(runId: RunId, a: { q: PlannedQuestion; listenFrom: number; elapsedMs: number; capMs: number }): CutIn | null;
  /** Every line a judge is about to speak. */
  line?(runId: RunId, judgeId: JudgeId, kind: LineKind, text: string): void;
  status?(state: DirectorState, detail: string): void;
  /** The closing line (default CLOSING_LINE). */
  closing?(runId: RunId, closer: JudgeId): string;
  /** The Q&A finished (not called when cancelled). */
  done?(runId: RunId, turns: AskedTurn[]): void;
}

interface Active { runId: RunId; cancelled: boolean }
type Gaze = (id: JudgeId) => LookTarget;
const FRAME_MS = 20;
const MIN_SPEECH_MS = 300;
const TICK_MS = 200;

export class Director {
  private active: Active | null = null;
  private paused = false;
  private onLevel: ((level: number) => void) | null = null;
  private readonly log: Logger;
  /** Where the panel should look now, and what each judge was last told. */
  private gaze: Gaze = () => "presenter";
  private readonly looks = new Map<JudgeId, LookTarget>();

  constructor(private readonly o: DirectorOptions) {
    this.log = o.log ?? (() => {});
    o.session.subscribe((s) => this.onChange(s));
    o.hub.onMic((pcm) => this.onLevel?.(rms(pcm)));
  }

  /** True while the judges' Q&A for a run is under way. */
  get running(): boolean { return this.active !== null; }

  private onChange(s: Readonly<SessionState>): void {
    const run = s.run;
    const wasPaused = this.paused;
    this.paused = !!run?.paused;
    const inQa = s.phase === "running" && run?.phase === "qa";
    if (inQa && this.active?.runId !== run!.runId) { void this.runQa(run!.runId, s); return; }
    if (this.active && (!inQa || run!.runId !== this.active.runId)) { this.cancel(); return; }
    if (this.active && this.paused !== wasPaused) this.look(this.gaze);   // notes while JJ listens, back after
  }

  /** Points the panel (actor.lookAt for each judge whose target changed); held at notes while woken. */
  private look(gaze: Gaze): void {
    this.gaze = gaze;
    for (const j of this.o.session.get().scene.judges) {
      const target = this.paused ? "notes" : gaze(j.id);
      if (this.looks.get(j.id) === target) continue;
      this.looks.set(j.id, target);
      this.o.hub.send("stage", { type: "actor.lookAt", payload: { actorId: j.id, target } });
    }
  }

  private cancel(): void {
    if (!this.active) return;
    this.active.cancelled = true;
    this.log("info", "director.cancelled", { runId: this.active.runId });
    this.active = null;
    this.onLevel = null;
    this.o.strategy?.status?.("idle", "Q&A stopped");
  }

  private async runQa(runId: RunId, s: Readonly<SessionState>): Promise<void> {
    this.cancel();
    const me: Active = { runId, cancelled: false };
    this.active = me;
    const st = this.o.strategy;
    const plan = st ? st.plan(runId, s) : planQuestions(s.context.deck ?? null, s.scene.judges, s.scene.qa.questions, (s.run?.index ?? 1) - 1);
    const capMs = this.o.answerCapMs ?? s.scene.qa.answerCapMs;
    this.log("info", "director.start", { runId, questions: plan.map((q) => `${q.judgeId}: ${q.topic}`) });
    this.looks.clear();
    this.look(() => "presenter");
    const queue = [...plan];
    const turns: AskedTurn[] = [];
    let closingText: string | null = null;
    while (queue.length) {
      const q = queue.shift()!;
      let turn = await this.ask(me, q, capMs, "question");
      if (!turn) return;
      turns.push(turn);
      if (!st) continue;
      let followed = false;
      for (;;) {
        const step = await this.decide(me, turn, !followed && turn.kind === "question", queue, turns);
        if (me.cancelled) return;
        if (step.type === "followup") {
          followed = true;
          turn = await this.ask(me, { ...q, text: step.text }, capMs, "followup");
          if (!turn) return;
          turns.push(turn);
          continue;
        }
        if (step.type === "close") { queue.length = 0; closingText = step.text?.trim() || null; }
        break;
      }
    }
    if (!(await this.untilAwake(me))) return;
    const closer = turns[0]?.q.judgeId ?? plan[0]?.judgeId ?? s.scene.judges[0]?.id;
    if (closer) {
      const text = closingText ?? st?.closing?.(runId, closer) ?? CLOSING_LINE;
      this.look((id) => (id === closer ? "presenter" : closer));
      st?.line?.(runId, closer, "closing", text);
      st?.status?.("speaking", "closing the Q&A");
      await this.o.voices.speakJudge(closer, text).done;
    }
    if (me.cancelled) return;
    this.look(() => "presenter");
    this.active = null;
    st?.done?.(runId, turns);
    const r = this.o.session.dispatch({ type: "qa_done" });
    this.log("info", "director.done", { runId, ok: r.ok, turns: turns.length });
  }

  /** The strategy's next step; any failure → the next planned question. */
  private async decide(me: Active, turn: AskedTurn, followUpAllowed: boolean, remaining: PlannedQuestion[], turns: AskedTurn[]): Promise<NextStep> {
    const st = this.o.strategy!;
    st.status?.("thinking", followUpAllowed ? "follow-up or next question?" : "next question");
    this.look((id) => (id === turn.q.judgeId ? "notes" : "presenter"));
    try {
      const step = await st.decide(me.runId, { turn, followUpAllowed, remaining: [...remaining], turns: [...turns] });
      if (step.type === "followup" && (!followUpAllowed || !step.text.trim())) return { type: "next" };
      return step;
    } catch (err) {
      this.log("warn", "director.decide_failed", { runId: me.runId, err: String(err) });
      return { type: "next" };
    }
  }

  private async ask(me: Active, q: PlannedQuestion, capMs: number, kind: TurnKind): Promise<AskedTurn | null> {
    const st = this.o.strategy;
    if (!(await this.untilAwake(me))) return null;
    const thinkMs = this.o.thinkMs ?? 700;
    if (thinkMs > 0) {
      this.look((id) => (id === q.judgeId ? "notes" : "presenter"));   // the next judge reads their question
      await this.sleep(thinkMs);
      if (!(await this.untilAwake(me))) return null;
    }
    const askedAt = this.o.clock.now();
    this.look((id) => (id === q.judgeId ? "presenter" : q.judgeId));   // the panel turns to the judge who asks
    st?.line?.(me.runId, q.judgeId, kind, q.text);
    st?.status?.("speaking", `${q.judgeTitle} asks${kind === "followup" ? " a follow-up" : ""}`);
    await this.o.voices.speakJudge(q.judgeId, q.text).done;
    if (me.cancelled) return null;
    this.look(() => "presenter");                                     // everyone watches the answer
    await this.sleep(this.o.echoGuardMs ?? 400);
    if (me.cancelled) return null;
    const listenFrom = this.o.clock.now();
    st?.status?.("listening", `answer to ${q.judgeTitle}`);
    const heard = await this.listen(me, capMs, q, listenFrom);
    if (me.cancelled) return null;
    const { answerMs, cut } = heard;
    this.o.hub.send("stage", { type: "actor.gesture", payload: { actorId: q.judgeId, gesture: "nod" } });
    const turn: AskedTurn = { q, kind, askedAt, listenFrom, endedAt: this.o.clock.now(), lastVoiceAt: heard.lastVoiceAt, answerMs, interrupted: !!cut, answer: "" };
    if (cut) {                                                        // a judge cuts in on a rambling answer
      this.look((id) => (id === cut.judgeId ? "presenter" : cut.judgeId));
      st?.line?.(me.runId, cut.judgeId, "interrupt", cut.text);
      st?.status?.("speaking", "a judge cuts in");
      await this.o.voices.speakJudge(cut.judgeId, cut.text).done;
      if (me.cancelled) return null;
    }
    if (st) {
      st.status?.("thinking", `reading the answer to ${q.judgeTitle}`);
      try { turn.answer = await st.answer(me.runId, turn); } catch { turn.answer = ""; }
      if (me.cancelled) return null;
    }
    this.o.runLog?.recordQa(me.runId, { judgeId: q.judgeId, judgeTitle: q.judgeTitle, question: q.text, askedAt, answerMs,
      ...(st ? { answer: turn.answer } : {}) });
    this.log("info", "director.answered", { runId: me.runId, judgeId: q.judgeId, kind, answerMs, interrupted: turn.interrupted });
    return turn;
  }

  /** The answer's length (0 when nothing was said), the last voice time, and a judge's cut-in if any. */
  private listen(me: Active, capMs: number, q: PlannedQuestion, listenFrom: number): Promise<{ answerMs: number; lastVoiceAt: number; cut: CutIn | null }> {
    const { clock } = this.o;
    const threshold = this.o.speechRms ?? 700;
    const silenceMs = this.o.silenceMs ?? 1800;
    const noAnswerMs = this.o.noAnswerMs ?? 12_000;
    const st = this.o.strategy;
    return new Promise((resolve) => {
      const start = clock.now();
      let spokeMs = 0;
      let firstVoice = 0;
      let lastVoice = 0;
      let timer: unknown = null;
      const finish = (cut: CutIn | null = null) => {
        if (timer !== null) clock.clearTimeout(timer);
        this.onLevel = null;
        resolve({ answerMs: spokeMs >= MIN_SPEECH_MS ? lastVoice - firstVoice : 0, lastVoiceAt: lastVoice, cut });
      };
      this.onLevel = (level) => {
        if (this.paused || level < threshold) return;
        const now = clock.now();
        if (!firstVoice) firstVoice = now;
        lastVoice = now;
        spokeMs += FRAME_MS;
      };
      const check = () => {
        timer = null;
        const now = clock.now();
        if (me.cancelled || now - start >= capMs) return finish();
        if (!this.paused) {
          if (spokeMs >= MIN_SPEECH_MS && now - lastVoice >= silenceMs) return finish();
          if (spokeMs < MIN_SPEECH_MS && now - start >= noAnswerMs) return finish();
          if (st?.interrupt && spokeMs >= MIN_SPEECH_MS) {
            const cut = st.interrupt(me.runId, { q, listenFrom, elapsedMs: now - start, capMs });
            if (cut) return finish(cut);
          }
        }
        timer = clock.setTimeout(check, TICK_MS);
      };
      timer = clock.setTimeout(check, TICK_MS);
    });
  }

  /** Waits while JJ is woken; false when the Q&A was cancelled meanwhile. */
  private async untilAwake(me: Active): Promise<boolean> {
    while (this.paused && !me.cancelled) await this.sleep(250);
    return !me.cancelled;
  }

  private sleep(ms: number): Promise<void> { return new Promise((r) => this.o.clock.setTimeout(r, ms)); }
}
