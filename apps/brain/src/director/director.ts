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
  }

  private async runQa(runId: RunId, s: Readonly<SessionState>): Promise<void> {
    this.cancel();
    const me: Active = { runId, cancelled: false };
    this.active = me;
    const plan = planQuestions(s.context.deck ?? null, s.scene.judges, s.scene.qa.questions, (s.run?.index ?? 1) - 1);
    const capMs = this.o.answerCapMs ?? s.scene.qa.answerCapMs;
    this.log("info", "director.start", { runId, questions: plan.map((q) => `${q.judgeId}: ${q.topic}`) });
    this.looks.clear();
    this.look(() => "presenter");
    for (const q of plan) {
      if (!(await this.ask(me, q, capMs))) return;
    }
    if (!(await this.untilAwake(me))) return;
    const closer = plan[0]?.judgeId ?? s.scene.judges[0]?.id;
    if (closer) {
      this.look((id) => (id === closer ? "presenter" : closer));
      await this.o.voices.speakJudge(closer, CLOSING_LINE).done;
    }
    if (me.cancelled) return;
    this.look(() => "presenter");
    this.active = null;
    const r = this.o.session.dispatch({ type: "qa_done" });
    this.log("info", "director.done", { runId, ok: r.ok });
  }

  private async ask(me: Active, q: PlannedQuestion, capMs: number): Promise<boolean> {
    if (!(await this.untilAwake(me))) return false;
    const thinkMs = this.o.thinkMs ?? 700;
    if (thinkMs > 0) {
      this.look((id) => (id === q.judgeId ? "notes" : "presenter"));   // the next judge reads their question
      await this.sleep(thinkMs);
      if (!(await this.untilAwake(me))) return false;
    }
    const askedAt = this.o.clock.now();
    this.look((id) => (id === q.judgeId ? "presenter" : q.judgeId));   // the panel turns to the judge who asks
    await this.o.voices.speakJudge(q.judgeId, q.text).done;
    if (me.cancelled) return false;
    this.look(() => "presenter");                                     // everyone watches the answer
    await this.sleep(this.o.echoGuardMs ?? 400);
    if (me.cancelled) return false;
    const answerMs = await this.listen(me, capMs);
    if (me.cancelled) return false;
    this.o.runLog?.recordQa(me.runId, { judgeId: q.judgeId, judgeTitle: q.judgeTitle, question: q.text, askedAt, answerMs });
    this.o.hub.send("stage", { type: "actor.gesture", payload: { actorId: q.judgeId, gesture: "nod" } });
    this.log("info", "director.answered", { runId: me.runId, judgeId: q.judgeId, answerMs });
    return true;
  }

  /** Resolves with the answer's length (0 when nothing was said). */
  private listen(me: Active, capMs: number): Promise<number> {
    const { clock } = this.o;
    const threshold = this.o.speechRms ?? 700;
    const silenceMs = this.o.silenceMs ?? 1800;
    const noAnswerMs = this.o.noAnswerMs ?? 12_000;
    return new Promise((resolve) => {
      const start = clock.now();
      let spokeMs = 0;
      let firstVoice = 0;
      let lastVoice = 0;
      let timer: unknown = null;
      const finish = () => {
        if (timer !== null) clock.clearTimeout(timer);
        this.onLevel = null;
        resolve(spokeMs >= MIN_SPEECH_MS ? lastVoice - firstVoice : 0);
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

