/**
 * Simulated brain pieces for exercising the real JJ engine before the hub, session store,
 * speech pipeline and context LLM exist. Behaviour follows the spec's transition and mic
 * routing tables closely enough for a voice test; it is NOT the brain core.
 */
import type {
  BehaviorKind, FeedbackLevel, JudgeDef, PresentationBrief, Result, RunId, RunMode, SceneOp, SessionState,
} from "@coach/protocol";
import type { ContextPort, JJClock, MicPort, ReportsPort, SessionActionLike, SessionPort } from "../ports.ts";

type Sub = (s: SessionState, cause: SessionActionLike | SceneOp[]) => void;

const judge = (n: number, title: string, toughness: number, style: JudgeDef["style"]): JudgeDef => ({
  id: `judge_${n}` as JudgeDef["id"], title, background: `${title} from the default panel.`, seat: `judge_seat_${n}`,
  voiceId: `voice_${n}`, toughness, style, priorities: [],
});

export function initialSimState(): SessionState {
  return {
    sessionId: `sim_${Date.now().toString(36)}`, phase: "setup", view: "setup",
    context: {
      deck: {
        deckId: "sim_deck", name: "Sample pitch",
        slides: ["Acme: meeting notes that write themselves", "The problem", "Our product", "Traction: 40 paying teams",
          "Pricing: 40 euros per seat", "Team", "The ask: 1M seed"].map((text, index) => ({ index, url: `/sim/${index}.png`, text })),
      },
      docs: [], brief: null,
      digest: "Seed pitch for Acme, an AI meeting-notes tool. Claims 40 paying teams and 40 EUR per seat pricing; asks for 1M. Weak points: churn not shown, competition not addressed.",
    },
    scene: {
      version: 1, venueId: "sim_room", qa: { questions: 2, answerCapMs: 45_000 },
      judges: [judge(1, "Seed investor", 0.3, "warm"), judge(2, "Technical founder", 0.5, "neutral"), judge(3, "Domain expert", 0.8, "skeptical")],
      audience: { count: 12 }, lighting: "default",
    },
    run: null, completedRuns: [],
    coach: { stage: "baseline", level: "off", targets: [], score: 0.8, recommendation: null, trainingRuns: 0 },
    enabledCategories: ["posture", "movement", "gaze", "disfluencies", "pace"], calibration: null, introDone: false,
    wake: { active: false, via: null, since: null },
  };
}

export interface SimSessionOptions {
  clock: JJClock;
  countdownMs?: number;
  /** Simulated main-app ack latency for scene batches. */
  ackMs?: number;
  /** Called when a run finishes so the reports sim can produce a report first. */
  onRunFinished?: (s: SessionState) => void;
}

export class SimSession implements SessionPort {
  s: SessionState = initialSimState();
  private subs: Sub[] = [];
  private countdownTimer: unknown = null;
  private pauseStartedAt: number | null = null;

  constructor(private readonly o: SimSessionOptions) {}

  get(): Readonly<SessionState> { return this.s; }
  subscribe(fn: Sub): () => void { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn); }; }
  private emit(c: SessionActionLike | SceneOp[]): void { this.s.view = viewOf(this.s); for (const f of this.subs) f(this.s, c); }

  dispatch(a: SessionActionLike): Result {
    const s = this.s;
    const now = this.o.clock.now();
    const done = (): Result => { this.emit(a); return { ok: true }; };
    const wrong = (hint?: string): Result => ({ ok: false, reason: "wrong_phase", ...(hint ? { hint } : {}) });
    const running = s.phase === "running" && s.run !== null;

    switch (a.type) {
      case "session_start":
        if (s.phase !== "setup") return wrong();
        if (!s.context.deck) return { ok: false, reason: "no_deck" };
        s.phase = s.introDone || s.completedRuns.length ? "debrief" : "intro";
        return done();

      case "save_brief":
        if (s.phase !== "intro") return wrong("save_brief only works during the intro");
        s.context.brief = a.brief as PresentationBrief;
        return done();

      case "start_run":
      case "run_it_back": {
        if (!["intro", "debrief", "final"].includes(s.phase)) return wrong();
        const last = s.run;
        if (a.type === "run_it_back" && !last) return wrong("no run to repeat");
        const rec = s.coach.recommendation;
        const mode: RunMode = a.type === "run_it_back" ? last!.mode : (a.mode as RunMode | undefined) ?? rec?.mode ?? (s.completedRuns.length ? "training" : "baseline");
        const level: FeedbackLevel = a.type === "run_it_back" ? last!.feedbackLevel
          : mode !== "training" ? "off" : (a.level as FeedbackLevel | undefined) ?? rec?.level ?? "strong";
        const index = s.completedRuns.length + (s.run && s.run.phase === "aborted" ? 1 : 0) + 1;
        s.run = {
          runId: `run_${index}` as RunId, index, mode, feedbackLevel: level,
          targets: s.coach.targets.map((t) => t.kind), enabledCategories: [...s.enabledCategories],
          sceneVersion: s.scene.version, phase: "countdown", slideIndex: 0, paused: false, pausedMs: 0, startedAt: now,
        };
        s.phase = "running";
        s.introDone = true;
        this.clearWake();
        this.countdownTimer = this.o.clock.setTimeout(() => {
          this.countdownTimer = null;
          if (s.run?.phase !== "countdown") return;
          s.run.phase = "presentation";
          s.run.presentationStartedAt = this.o.clock.now();
          this.emit({ type: "countdown_elapsed" });
        }, this.o.countdownMs ?? 3000);
        return done();
      }

      case "slide":
        if (!running) return wrong();
        s.run!.slideIndex = Math.max(0, Math.min(a.index as number, (s.context.deck?.slides.length ?? 1) - 1));
        return done();

      case "presentation_done":
        if (!running || s.run!.phase !== "presentation") return wrong();
        s.run!.presentationEndedAt = now;
        s.run!.phase = "qa";
        if (s.scene.qa.questions === 0) return this.finish(a);
        return done();

      case "qa_done":
        if (!running || s.run!.phase !== "qa") return wrong();
        return this.finish(a);

      case "end_run":
        if (!running) return wrong("no run in progress");
        return this.finish(a);

      case "abort_run":
        if (!running) return wrong();
        this.cancelCountdown();
        this.clearWake();
        s.run!.phase = "aborted";
        s.phase = s.completedRuns.length ? "debrief" : "intro";
        return done();

      case "wake":
        if (!running) return { ok: true };                     // no-op outside runs
        if (s.run!.paused) return { ok: true };
        s.run!.paused = true;
        s.wake = { active: true, via: a.via as "phrase" | "ptt" | "operator", since: now };
        this.pauseStartedAt = now;
        return done();

      case "resume":
        if (!running || !s.run!.paused) return wrong("the run is not paused");
        this.clearWake();
        return done();

      case "set_targets": {
        const targets = a.targets as BehaviorKind[];
        s.coach.targets = targets.map((kind) => ({ kind, status: "learning", cleanStreak: 0, lastSeverity: 0.6 }));
        if (s.coach.stage === "baseline" && s.completedRuns.length) {
          s.coach.stage = "training"; s.coach.level = "strong";
          s.coach.recommendation = { mode: "training", level: "strong", reason: "We start with strong feedback on your targets.", done: false };
        }
        return done();
      }
      case "set_level": s.coach.level = a.level as FeedbackLevel; if (s.coach.recommendation) s.coach.recommendation.level = s.coach.level; return done();
      case "set_categories": s.enabledCategories = a.enabled as SessionState["enabledCategories"]; return done();
      case "start_calibration": if (!["intro", "debrief"].includes(s.phase)) return wrong(); s.phase = "calibrating"; return done();

      case "show_final":
        if (s.phase !== "debrief") return wrong("show_final works from the debrief");
        s.phase = "final"; s.coach.stage = "done";
        return done();

      case "reset":
        this.cancelCountdown();
        this.clearWake();
        { const keep = { context: s.context, scene: s.scene }; this.s = { ...initialSimState(), ...keep }; }
        return done();

      default:
        return { ok: false, reason: "invalid_args", hint: `sim does not know action ${a.type}` };
    }
  }

  private finish(a: SessionActionLike): Result {
    const s = this.s;
    this.cancelCountdown();
    this.clearWake();
    s.run!.phase = "ended";
    s.run!.endedAt = this.o.clock.now();
    s.completedRuns.push(s.run!.runId);
    if (s.run!.mode === "training") s.coach.trainingRuns++;
    this.o.onRunFinished?.(s);
    s.phase = "debrief";
    this.emit(a);
    return { ok: true };
  }

  private clearWake(): void {
    const s = this.s;
    if (s.run?.paused && this.pauseStartedAt !== null) s.run.pausedMs += this.o.clock.now() - this.pauseStartedAt;
    if (s.run) s.run.paused = false;
    this.pauseStartedAt = null;
    s.wake = { active: false, via: null, since: null };
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) { this.o.clock.clearTimeout(this.countdownTimer); this.countdownTimer = null; }
  }

  async applyScene(ops: SceneOp[]): Promise<Result<{ version: number }>> {
    const s = this.s;
    if (ops.some((o) => o.op === "judges.set") && s.run?.phase === "qa" && s.phase === "running") return { ok: false, reason: "wrong_phase", hint: "the panel cannot change during Q&A" };
    const next = structuredClone(s.scene);
    for (const op of ops) {
      switch (op.op) {
        case "judges.set":
          if (op.judges.length < 1 || op.judges.length > 5) return { ok: false, reason: "invalid_args", hint: "1-5 judges" };
          next.judges = op.judges; break;
        case "judge.update": {
          const j = next.judges.find((x) => x.id === op.id);
          if (!j) return { ok: false, reason: "invalid_args", hint: `no ${op.id}` };
          Object.assign(j, op.patch); break;
        }
        case "audience.set": next.audience.count = op.count; break;
        case "lighting.set": next.lighting = op.preset; break;
        case "qa.set": next.qa = op.qa; break;
        case "venue.set": next.venueId = op.venueId; break;
      }
    }
    await new Promise((r) => setTimeout(r, this.o.ackMs ?? 80));   // the main app's ack
    next.version = s.scene.version + 1;
    this.s.scene = next;
    this.emit(ops);
    return { ok: true, version: next.version };
  }
}

function viewOf(s: SessionState): SessionState["view"] {
  switch (s.phase) {
    case "setup": return "setup";
    case "intro": case "calibrating": return "jj";
    case "running": return s.run?.phase === "qa" ? "room" : s.run?.phase === "ended" ? "report" : "slides";
    case "debrief": return "report";
    case "final": return "final";
  }
}

/** Spec mic routing table + a 3 s ring buffer for the wake pre-roll. */
export class SimMic implements MicPort {
  private frames: { t: number; pcm: Int16Array }[] = [];
  constructor(private readonly session: SessionPort, private readonly clock: JJClock, private readonly bufferMs = 3000) {}

  sinks(): ("stt" | "jj")[] {
    const s = this.session.get();
    if (s.phase === "setup") return [];
    if (s.phase !== "running") return ["jj"];
    if (s.run?.phase === "countdown") return [];
    return s.wake.active ? ["jj", "stt"] : ["stt"];
  }

  /** Store a frame; returns true when it should go to JJ. */
  write(pcm: Int16Array): boolean {
    const t = this.clock.now();
    this.frames.push({ t, pcm });
    while (this.frames.length && this.frames[0]!.t < t - this.bufferMs) this.frames.shift();
    return this.sinks().includes("jj");
  }

  replaySince(t: number): Int16Array {
    const picked = this.frames.filter((f) => f.t >= t);
    const out = new Int16Array(picked.reduce((n, f) => n + f.pcm.length, 0));
    let o = 0;
    for (const f of picked) { out.set(f.pcm, o); o += f.pcm.length; }
    return out;
  }
}

/** Canned personas (no LLM); the instruction is reflected in the titles so changes are visible. */
export class SimContext implements ContextPort {
  constructor(private readonly session: SimSession) {}
  async setBrief(b: PresentationBrief): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    this.session.s.context.digest = `${b.setting} "${b.title}" for ${b.audience}. Goal: ${b.goal}. Key points: ${b.keyPoints.join("; ")}.`;
  }
  async generatePersonas(n: number, instruction?: string) {
    await new Promise((r) => setTimeout(r, 1200));    // feels like an LLM call
    const brief = this.session.s.context.brief;
    const base = ["Seed investor", "Technical founder", "Domain expert", "Product lead", "Customer"];
    const suffix = instruction ? ` (${instruction.slice(0, 20)})` : "";
    return {
      judges: Array.from({ length: n }, (_, i) => ({
        title: `${base[i % base.length]}${suffix}`.slice(0, 60),
        background: `Listens to ${brief?.title ?? "the talk"} as ${base[i % base.length]!.toLowerCase()}.`,
        style: (["warm", "neutral", "skeptical"] as const)[i % 3]!,
        toughness: [0.3, 0.5, 0.8, 0.6, 0.4][i] ?? 0.5,
        priorities: ["traction", "pricing"],
      })),
      audienceCount: 15,
    };
  }
}

/** Plausible compact run reports so the debrief has something to talk about. */
export class SimReports implements ReportsPort {
  private reports = new Map<RunId, unknown>();
  compactRunReport(id: RunId): unknown | null { return this.reports.get(id) ?? null; }

  produce(s: SessionState): void {
    const run = s.run!;
    const n = s.completedRuns.length;
    const better = Math.max(0, n - 1);
    const report = {
      run_id: run.runId, mode: run.mode, level: run.feedbackLevel,
      duration_s: Math.round(((run.endedAt ?? 0) - (run.startedAt ?? 0) - run.pausedMs) / 1000),
      patterns: [
        { kind: "arms_crossed", severity: Math.max(0.1, 0.7 - 0.25 * better), episodes: Math.max(0, 4 - 2 * better), total_s: Math.max(0, 48 - 20 * better), moment: "on slide 5, while you explained pricing" },
        { kind: "filler_burst", severity: 0.5, episodes: 3, fillers_per_min: 6.5, moment: "on slide 2, describing the problem" },
        { kind: "pace_fast", severity: 0.3, episodes: 1, peak_wpm: 188, moment: "on slide 4, the traction numbers" },
      ],
      strengths: ["You faced the panel for most of the Q&A."],
      targets: s.coach.targets.map((t) => ({ kind: t.kind, status: better >= 2 ? "fixed" : "learning", clean: better >= 2 })),
      score: s.coach.score,
      recommendation: s.coach.recommendation ?? { mode: "training", level: "strong", reason: "Pick one or two patterns and we will train them with strong feedback.", done: false },
      qa: [{ judge: "judge_3", question: "How do you keep churn low against free tools?", answer_s: 22 }],
    };
    if (n >= 2) s.coach.score = Math.min(1, s.coach.score + 0.05);
    this.reports.set(run.runId, report);
  }
}
