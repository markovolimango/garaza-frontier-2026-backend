/**
 * SessionStore: owns SessionState; every change goes through dispatch (spec: "Brain core").
 * dispatch is synchronous and validated; any action not listed for a phase returns
 * wrong_phase. Side effects that belong to other components (STT, feedback controller,
 * director, run summary, JJ) are NOT here: they subscribe and react to the cause.
 * The coaching rules are injected as a CoachPolicy (packages/rules implements it).
 */
import { nanoid } from "nanoid";
import {
  BehaviorKind, FEEDBACK_ELIGIBLE, FeedbackCategory, FeedbackLevel, GazeCalibration, PresentationBrief, RunMode,
  type CoachState, type DownlinkMessage, type Recommendation, type Result, type RunId, type RunState, type SceneDef,
  type SceneOp, type SessionContext, type SessionState, type VenueDef,
} from "@coach/protocol";
import { z } from "zod";
import type { Clock } from "./clock.ts";
import { SceneCommander, type StageLink } from "./commands.ts";
import type { Logger } from "./log.ts";
import { viewFor } from "./views.ts";

// ---------------- actions ----------------
export type SessionAction =
  | { type: "session_start" }
  | { type: "save_brief"; brief: PresentationBrief }
  | { type: "start_run"; mode?: RunMode; level?: FeedbackLevel }
  | { type: "slide"; index: number; from?: "stage" | "brain" }
  | { type: "presentation_done" } | { type: "qa_done" } | { type: "end_run" } | { type: "abort_run" }
  | { type: "run_it_back" }
  | { type: "wake"; via: "phrase" | "ptt" | "operator" } | { type: "resume" }
  | { type: "set_targets"; targets: BehaviorKind[] }
  | { type: "set_level"; level: FeedbackLevel }
  | { type: "set_categories"; enabled: FeedbackCategory[] }
  | { type: "start_calibration" } | { type: "calibration_done"; calibration: GazeCalibration }
  | { type: "show_final" } | { type: "reset" };

/** Changes that are not user actions, also delivered to subscribers. */
export type SessionEvent =
  | { type: "countdown"; secondsLeft: 3 | 2 | 1 | 0 }
  | { type: "presentation_started" }
  | { type: "context"; patch: Partial<SessionContext> };

export type SessionCause = SessionAction | SessionEvent | SceneOp[];

const ActionSchema: z.ZodType<SessionAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_start") }),
  z.object({ type: z.literal("save_brief"), brief: PresentationBrief }),
  z.object({ type: z.literal("start_run"), mode: RunMode.optional(), level: FeedbackLevel.optional() }),
  z.object({ type: z.literal("slide"), index: z.number().int().min(0), from: z.enum(["stage", "brain"]).optional() }),
  z.object({ type: z.literal("presentation_done") }), z.object({ type: z.literal("qa_done") }),
  z.object({ type: z.literal("end_run") }), z.object({ type: z.literal("abort_run") }), z.object({ type: z.literal("run_it_back") }),
  z.object({ type: z.literal("wake"), via: z.enum(["phrase", "ptt", "operator"]) }), z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("set_targets"), targets: z.array(z.enum(FEEDBACK_ELIGIBLE)).max(2) }),
  z.object({ type: z.literal("set_level"), level: FeedbackLevel }),
  z.object({ type: z.literal("set_categories"), enabled: z.array(FeedbackCategory) }),
  z.object({ type: z.literal("start_calibration") }), z.object({ type: z.literal("calibration_done"), calibration: GazeCalibration }),
  z.object({ type: z.literal("show_final") }), z.object({ type: z.literal("reset") }),
]);

// ---------------- coaching policy port ----------------
/** Implemented by packages/rules (coach.ts + summarizeRun). The brain only calls it. */
export interface CoachPolicy {
  initial(): CoachState;
  recommend(c: CoachState): Recommendation;
  /** A run ended (not aborted): summarise it and advance the coach. Must be synchronous and pure. */
  afterRun(prev: CoachState, run: RunState): CoachState;
  setTargets(prev: CoachState, targets: BehaviorKind[], completedRuns: number): CoachState;
  setLevel(prev: CoachState, level: FeedbackLevel): CoachState;
}

export interface SessionStoreOptions {
  clock: Clock;
  coach: CoachPolicy;
  venue: VenueDef;
  stage: StageLink;
  initialScene: SceneDef;
  enabledCategories?: FeedbackCategory[];
  countdownMs?: number;          // 3000
  ackTimeoutMs?: number;         // 2000
  newSessionId?: () => string;
  log?: Logger;
}

type Sub = (s: SessionState, cause: SessionCause) => void;

export class SessionStore {
  private s: SessionState;
  private readonly subs: Sub[] = [];
  private readonly sceneHistory = new Map<number, SceneDef>();
  readonly commands: SceneCommander;
  private countdown: { timer: unknown; left: 3 | 2 | 1; nextAt: number } | null = null;
  private countdownRemainingOnPause: number | null = null;
  private readonly log: Logger;

  constructor(private readonly o: SessionStoreOptions) {
    this.log = o.log ?? (() => {});
    const scene = structuredClone(o.initialScene);
    this.s = this.fresh(scene, { deck: null, docs: [], brief: null, digest: null }, false);
    this.sceneHistory.set(scene.version, structuredClone(scene));
    this.commands = new SceneCommander({
      clock: o.clock, venue: () => this.o.venue, stage: o.stage, ackTimeoutMs: o.ackTimeoutMs ?? 2000, log: this.log,
      getScene: () => this.s.scene,
      commit: (scene, ops) => {
        this.s.scene = scene;
        this.sceneHistory.set(scene.version, structuredClone(scene));
        this.emit(ops);
      },
      guard: (ops) => ops.some((op) => op.op === "judges.set") && this.s.phase === "running" && this.s.run?.phase === "qa"
        ? { ok: false, reason: "wrong_phase", hint: "the panel cannot be replaced during Q&A" } : null,
      syncMessage: (scene) => this.syncMessage(scene),
    });
  }

  get(): Readonly<SessionState> { return this.s; }
  venue(): VenueDef { return this.o.venue; }

  subscribe(fn: Sub): () => void {
    this.subs.push(fn);
    return () => { const i = this.subs.indexOf(fn); if (i >= 0) this.subs.splice(i, 1); };
  }

  applyScene(ops: SceneOp[]): Promise<Result<{ version: number }>> { return this.commands.apply(ops); }

  /** The full scene.sync downlink (scene + venue + deck). */
  syncMessage(scene: SceneDef = this.s.scene): DownlinkMessage {
    return { type: "scene.sync", payload: { scene, venue: this.o.venue, deck: this.s.context.deck } };
  }

  /** For ContextService (uploads, digest). Not a user action. */
  setContext(patch: Partial<SessionContext>): void {
    this.s.context = { ...this.s.context, ...patch };
    this.emit({ type: "context", patch });
  }

  dispatch(raw: SessionAction): Result {
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid_args", hint: z.prettifyError(parsed.error) };
    const a = parsed.data;
    const r = this.reduce(a);
    if (r.ok) this.emit(a);
    else this.log("info", "session.refused", { action: a.type, reason: r.reason, phase: this.s.phase });
    return r;
  }

  // ---------------- transitions ----------------

  private reduce(a: SessionAction): Result {
    const s = this.s;
    const now = this.o.clock.now();
    const ok: Result = { ok: true };
    const wrong = (hint?: string): Result => ({ ok: false, reason: "wrong_phase", hint: hint ?? `${a.type} is not possible during ${this.phaseLabel()}` });
    const run = s.phase === "running" ? s.run : null;
    const live = run && run.phase !== "ended" && run.phase !== "aborted" ? run : null;

    switch (a.type) {
      case "session_start":
        if (s.phase !== "setup") return wrong();
        if (!s.context.deck) return { ok: false, reason: "no_deck", hint: "upload slides first" };
        s.phase = s.introDone ? "debrief" : "intro";
        return ok;

      case "save_brief":
        if (s.phase !== "intro") return wrong("the brief is saved during the intro");
        s.context = { ...s.context, brief: a.brief };
        return ok;

      case "start_run": {
        if (!["intro", "debrief", "final"].includes(s.phase)) return wrong();
        const rec = this.o.coach.recommend(s.coach);
        const mode = a.mode ?? rec.mode;
        const level = mode === "training" ? a.level ?? (a.mode ? (rec.mode === "training" ? rec.level : "strong") : rec.level) : "off";
        this.beginRun(mode, level, s.scene.version);
        return ok;
      }

      case "run_it_back": {
        if (!["debrief", "final"].includes(s.phase)) return wrong();
        const last = s.run;
        if (!last) return wrong("there is no run to repeat");
        if (s.scene.version !== last.sceneVersion) this.restoreScene(last.sceneVersion);
        this.beginRun(last.mode, last.feedbackLevel, last.sceneVersion);
        return ok;
      }

      case "slide": {
        if (!live || (live.phase !== "presentation" && live.phase !== "countdown")) return wrong("slides change during the presentation");
        const n = s.context.deck?.slides.length ?? 0;
        if (a.index >= n) return { ok: false, reason: "invalid_args", hint: `the deck has ${n} slides` };
        live.slideIndex = a.index;
        return ok;
      }

      case "presentation_done":
        if (!live || live.phase !== "presentation") return wrong();
        live.presentationEndedAt = now;
        if (s.scene.qa.questions === 0) { this.finishRun(live); return ok; }
        live.phase = "qa";
        return ok;

      case "qa_done":
        if (!live || live.phase !== "qa") return wrong();
        this.finishRun(live);
        return ok;

      case "end_run":
        if (!live) return wrong("no run in progress");
        if (live.phase === "presentation" || live.phase === "countdown") live.presentationEndedAt ??= now;
        this.finishRun(live);
        return ok;

      case "abort_run":
        if (!live) return wrong("no run in progress");
        this.stopCountdown();
        this.endPause(live);
        live.phase = "aborted";
        live.endedAt = now;
        s.phase = s.completedRuns.length ? "debrief" : "intro";
        return ok;

      case "wake":
        if (!live || live.phase === "ended") return ok;          // outside runs JJ already listens: no-op
        if (live.paused) return ok;
        live.paused = true;
        s.wake = { active: true, via: a.via, since: now };
        if (this.countdown) { this.countdownRemainingOnPause = Math.max(0, this.countdown.nextAt - now); this.o.clock.clearTimeout(this.countdown.timer); }
        return ok;

      case "resume":
        if (!live || !live.paused) return wrong("the run is not paused");
        this.endPause(live);
        if (this.countdown && this.countdownRemainingOnPause !== null) this.scheduleCountdownTick(this.countdownRemainingOnPause);
        this.countdownRemainingOnPause = null;
        return ok;

      case "set_targets":
        if (s.phase === "setup") return wrong();
        s.coach = this.o.coach.setTargets(s.coach, [...new Set(a.targets)], s.completedRuns.length);
        return ok;

      case "set_level":
        if (s.phase === "setup") return wrong();
        s.coach = this.o.coach.setLevel(s.coach, a.level);
        return ok;

      case "set_categories":
        s.enabledCategories = [...new Set(a.enabled)];
        return ok;

      case "start_calibration":
        if (s.phase !== "intro" && s.phase !== "debrief") return wrong();
        this.beforeCalibration = s.phase;
        s.phase = "calibrating";
        return ok;

      case "calibration_done":
        if (s.phase !== "calibrating") return wrong();
        s.calibration = a.calibration;
        s.phase = this.beforeCalibration ?? "intro";
        return ok;

      case "show_final":
        if (s.phase !== "debrief") return wrong("the final report follows a debrief");
        if (s.completedRuns.length === 0) return { ok: false, reason: "not_available", hint: "no run has finished yet" };
        s.phase = "final";
        return ok;

      case "reset": {
        this.stopCountdown();
        this.s = this.fresh(s.scene, s.context, s.introDone);
        return ok;
      }
    }
  }

  private beforeCalibration: "intro" | "debrief" | null = null;

  private fresh(scene: SceneDef, context: SessionContext, introDone: boolean): SessionState {
    const coach = this.o.coach.initial();
    const state: SessionState = {
      sessionId: (this.o.newSessionId ?? (() => nanoid()))(),
      phase: "setup", view: "setup", context, scene, run: null, completedRuns: [],
      coach: { ...coach, recommendation: coach.recommendation ?? this.o.coach.recommend(coach) },
      enabledCategories: this.o.enabledCategories ?? ["posture", "movement", "gaze", "disfluencies", "pace"],
      calibration: null, introDone, wake: { active: false, via: null, since: null },
    };
    state.view = viewFor(state).view;
    return state;
  }

  private beginRun(mode: RunMode, level: FeedbackLevel, sceneVersion: number): void {
    const s = this.s;
    const index = (s.run?.index ?? 0) + 1;
    const run: RunState = {
      runId: `run_${index}` as RunId, index, mode, feedbackLevel: mode === "training" ? level : "off",
      targets: s.coach.targets.map((t) => t.kind).slice(0, 2),
      enabledCategories: [...s.enabledCategories],
      sceneVersion, phase: "countdown", slideIndex: 0, paused: false, pausedMs: 0, startedAt: this.o.clock.now(),
    };
    s.run = run;
    s.phase = "running";
    s.introDone = true;
    s.wake = { active: false, via: null, since: null };
    this.startCountdown();
  }

  private finishRun(run: RunState): void {
    const s = this.s;
    this.stopCountdown();
    this.endPause(run);
    run.phase = "ended";
    run.endedAt = this.o.clock.now();
    s.completedRuns = [...s.completedRuns, run.runId];
    try { s.coach = this.o.coach.afterRun(s.coach, run); }
    catch (err) { this.log("error", "coach.afterRun_failed", { err: String(err) }); }
    s.coach = { ...s.coach, recommendation: this.o.coach.recommend(s.coach) };
    s.phase = "debrief";     // running: ended → debrief is automatic
  }

  private endPause(run: RunState): void {
    const s = this.s;
    if (run.paused && s.wake.since !== null) run.pausedMs += this.o.clock.now() - s.wake.since;
    run.paused = false;
    s.wake = { active: false, via: null, since: null };
  }

  /** Re-applies the scene a repeated run started with (run_it_back). Async, best effort. */
  private restoreScene(version: number): void {
    const snap = this.sceneHistory.get(version);
    if (!snap) { this.log("warn", "session.scene_version_unknown", { version }); return; }
    void this.applyScene([
      { op: "judges.set", judges: snap.judges }, { op: "audience.set", count: snap.audience.count },
      { op: "lighting.set", preset: snap.lighting, transitionMs: 0 }, { op: "qa.set", qa: snap.qa },
    ]).then((r) => { if (!r.ok) this.log("warn", "session.scene_restore_failed", { reason: r.reason }); });
  }

  // ---------------- countdown (3-2-1 over the dimmed first slide) ----------------

  private startCountdown(): void {
    this.stopCountdown();
    const step = (this.o.countdownMs ?? 3000) / 3;
    this.countdown = { timer: null, left: 3, nextAt: this.o.clock.now() + step };
    this.emitLater({ type: "countdown", secondsLeft: 3 });
    this.scheduleCountdownTick(step);
  }

  private scheduleCountdownTick(ms: number): void {
    const c = this.countdown;
    if (!c) return;
    c.nextAt = this.o.clock.now() + ms;
    c.timer = this.o.clock.setTimeout(() => this.countdownTick(), ms);
  }

  private countdownTick(): void {
    const c = this.countdown;
    const run = this.s.run;
    if (!c || !run || run.phase !== "countdown") { this.countdown = null; return; }
    const step = (this.o.countdownMs ?? 3000) / 3;
    if (c.left > 1) {
      c.left = (c.left - 1) as 2 | 1;
      this.emit({ type: "countdown", secondsLeft: c.left });
      this.scheduleCountdownTick(step);
      return;
    }
    this.countdown = null;
    run.phase = "presentation";
    run.presentationStartedAt = this.o.clock.now();
    this.emit({ type: "countdown", secondsLeft: 0 });
    this.emit({ type: "presentation_started" });
  }

  private stopCountdown(): void {
    if (this.countdown) this.o.clock.clearTimeout(this.countdown.timer);
    this.countdown = null;
    this.countdownRemainingOnPause = null;
  }

  // ---------------- notify ----------------

  private pendingEvents: SessionEvent[] = [];
  /** Queue an event to be delivered right after the action that caused it. */
  private emitLater(e: SessionEvent): void { this.pendingEvents.push(e); }

  private emit(cause: SessionCause): void {
    this.s.view = viewFor(this.s).view;
    for (const fn of [...this.subs]) {
      try { fn(this.s, cause); } catch (err) { this.log("error", "session.subscriber_failed", { err: String(err) }); }
    }
    const later = this.pendingEvents.splice(0);
    for (const e of later) this.emit(e);
  }

  private phaseLabel(): string {
    const s = this.s;
    return s.phase === "running" && s.run ? `the run (${s.run.phase})` : s.phase;
  }
}
