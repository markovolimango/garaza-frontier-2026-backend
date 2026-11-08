/**
 * ToolRegistry: the single registry used by JJ (voice), the main app (card clicks) and the
 * operator panel. Every invocation is validated against the tool's zod schema; nothing
 * invalid reaches a handler. Spec: "JJ adapter and tools".
 */
import { z } from "zod";
import {
  ToolArgs, ToolName,
  type JudgeDef, type ToolCatalogue, type JudgeId, type Result, type RunId, type SceneOp, type ToolArgsOf, type ToolResult,
} from "@coach/protocol";
import type { ToolDeclaration } from "./voice-agent.ts";
import type {
  CalibrationPort, ContextPort, HubPort, Logger, ReportsPort, SessionActionLike, SessionPort,
} from "./ports.ts";

export type ToolCaller = "jj" | "stage" | "operator" | "replay";

export interface ToolSpec<A> {
  name: ToolName;
  description: string;
  args: z.ZodType<A>;
  behavior: "BLOCKING" | "NON_BLOCKING";
  /** NON_BLOCKING only: how the result re-enters the conversation. */
  scheduling?: ToolDeclaration["scheduling"];
  handler(args: A, caller: ToolCaller): Promise<ToolResult>;
}

export interface ToolInvocation { name: string; args: unknown; caller: ToolCaller; result: ToolResult; durationMs: number }

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

export class ToolRegistry {
  private readonly specs = new Map<ToolName, ToolSpec<any>>();
  private readonly listeners: ((i: ToolInvocation) => void)[] = [];

  constructor(private readonly now: () => number = Date.now, private readonly log: Logger = () => {}) {}

  register<A>(spec: ToolSpec<A>): this {
    if (this.specs.has(spec.name)) throw new Error(`tool ${spec.name} registered twice`);
    this.specs.set(spec.name, spec);
    return this;
  }

  has(name: string): boolean { return this.specs.has(name as ToolName); }

  /** For the voice agent's function declarations. */
  declarations(): ToolDeclaration[] {
    return [...this.specs.values()].map((s) => ({
      name: s.name, description: s.description, parameters: jsonSchemaOf(s.args), behavior: s.behavior,
      ...(s.scheduling ? { scheduling: s.scheduling } : {}),
    }));
  }

  /** GET /api/tools; the operator panel builds its forms from argsSchema. */
  catalogue(): ToolCatalogue {
    return { tools: [...this.specs.values()].map((s) => ({ name: s.name, description: s.description, behavior: s.behavior, argsSchema: jsonSchemaOf(s.args) })) };
  }

  onInvoked(fn: (i: ToolInvocation) => void): () => void {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }

  async invoke(name: string, rawArgs: unknown, caller: ToolCaller): Promise<ToolResult> {
    const started = this.now();
    const result = await this.run(name, rawArgs, caller);
    const inv: ToolInvocation = { name, args: rawArgs, caller, result, durationMs: this.now() - started };
    this.log(result.ok ? "info" : "warn", "tool.invoke", { name, caller, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) });
    for (const l of this.listeners) { try { l(inv); } catch (err) { this.log("error", "tool.listener_failed", { err: String(err) }); } }
    return result;
  }

  private async run(name: string, rawArgs: unknown, caller: ToolCaller): Promise<ToolResult> {
    const spec = this.specs.get(name as ToolName);
    if (!spec) return { ok: false, reason: "not_available", hint: `unknown tool "${name}"` };
    const parsed = spec.args.safeParse(rawArgs ?? {});
    if (!parsed.success) return { ok: false, reason: "invalid_args", hint: z.prettifyError(parsed.error) };
    try {
      return await spec.handler(parsed.data, caller);
    } catch (err) {
      this.log("error", "tool.handler_threw", { name, err: String(err) });
      return { ok: false, reason: "internal", hint: "the tool failed unexpectedly" };
    }
  }
}

// ======================================================================================
// Coach tools
// ======================================================================================

export interface CoachToolDeps {
  session: SessionPort;
  context: ContextPort;
  reports: ReportsPort;
  hub: HubPort;
  /** JUDGE_VOICES: judge_N gets judgeVoices[N-1]. */
  judgeVoices: string[];
  calibration?: CalibrationPort;
  /** Seat anchor for judge number n (1-based). Default `judge_seat_${n}`. */
  seatFor?: (n: number) => string;
  lightingTransitionMs?: number;
}

const toTool = (r: Result, extra: Record<string, unknown> = {}): ToolResult =>
  r.ok ? { ok: true, ...extra } : { ok: false, reason: r.reason, ...(r.hint ? { hint: r.hint } : {}) };

/** Default toughness spread: 0.3, 0.5, 0.8 for three judges; interpolated otherwise. */
export function toughnessSpread(n: number): number[] {
  if (n === 3) return [0.3, 0.5, 0.8];
  if (n === 1) return [0.5];
  return Array.from({ length: n }, (_, i) => Math.round((0.3 + (0.5 * i) / (n - 1)) * 100) / 100);
}

/** Resolves "left" / "center" / "right" against the panel ordered by seat. */
export function resolveJudge(judges: readonly JudgeDef[], ref: string): { id: JudgeId } | { error: string } {
  if (ref.startsWith("judge_")) {
    return judges.some((j) => j.id === ref) ? { id: ref as JudgeId } : { error: `no ${ref}; the panel is ${judges.map((j) => j.id).join(", ")}` };
  }
  const bySeat = [...judges].sort((a, b) => a.seat.localeCompare(b.seat, "en", { numeric: true }));
  const n = bySeat.length;
  if (n === 0) return { error: "the panel is empty" };
  let idx: number | null;
  if (ref === "left") idx = 0;
  else if (ref === "right") idx = n - 1;
  else idx = n % 2 === 1 ? (n - 1) / 2 : null;
  if (idx === null) return { error: `no single centre judge with ${n} judges; use a judge id (${bySeat.map((j) => j.id).join(", ")})` };
  return { id: bySeat[idx]!.id };
}

export function createCoachTools(deps: CoachToolDeps, registry: ToolRegistry): ToolRegistry {
  const { session, context, reports, hub } = deps;
  const seatFor = deps.seatFor ?? ((n: number) => `judge_seat_${n}`);
  const dispatch = (a: SessionActionLike) => session.dispatch(a);
  let generating = false;   // save_brief / regenerate_personas / set_judges(count) share one LLM slot

  const buildPanel = (
    personas: Awaited<ReturnType<ContextPort["generatePersonas"]>>["judges"],
    overrides: { toughness?: number | undefined; style?: JudgeDef["style"] | undefined; spread: boolean },
  ): JudgeDef[] => {
    const spread = toughnessSpread(personas.length);
    return personas.map((p, i) => ({
      id: `judge_${i + 1}` as JudgeId,
      title: p.title,
      background: p.background,
      seat: seatFor(i + 1),
      voiceId: deps.judgeVoices[i] ?? deps.judgeVoices[0] ?? "default",
      toughness: overrides.toughness ?? (overrides.spread ? spread[i]! : p.toughness),
      style: overrides.style ?? p.style,
      priorities: p.priorities.slice(0, 3),
    }));
  };

  /** Generates n personas and commits them with judges.set (+ audience.set). */
  const regeneratePanel = async (
    n: number, opts: { instruction?: string; toughness?: number; style?: JudgeDef["style"]; withAudience: boolean },
  ): Promise<ToolResult> => {
    if (generating) return { ok: false, reason: "not_available", hint: "the panel is already being generated" };
    generating = true;
    try {
      const out = await context.generatePersonas(n, opts.instruction);
      const judges = buildPanel(out.judges.slice(0, n), { toughness: opts.toughness, style: opts.style, spread: opts.instruction === undefined });
      const ops: SceneOp[] = [{ op: "judges.set", judges }];
      if (opts.withAudience) ops.push({ op: "audience.set", count: out.audienceCount });
      const r = await session.applyScene(ops);
      return r.ok ? { ok: true, version: r.version, judges: judges.map((j) => ({ id: j.id, title: j.title })) } : toTool(r);
    } finally {
      generating = false;
    }
  };

  const scene = async (ops: SceneOp[]): Promise<ToolResult> => {
    const r = await session.applyScene(ops);
    return r.ok ? { ok: true, version: r.version } : toTool(r);
  };

  const runInfo = (): Record<string, unknown> => {
    const run = session.get().run;
    return run ? { run_id: run.runId, mode: run.mode, level: run.feedbackLevel } : {};
  };

  const reg = <N extends ToolName>(
    name: N, description: string, behavior: ToolSpec<unknown>["behavior"],
    handler: (a: ToolArgsOf<N>, caller: ToolCaller) => Promise<ToolResult>,
    scheduling?: ToolDeclaration["scheduling"],
  ) => registry.register<ToolArgsOf<N>>({
    name, description, behavior, args: ToolArgs[name] as unknown as z.ZodType<ToolArgsOf<N>>, handler,
    ...(scheduling ? { scheduling } : {}),
  });

  reg("save_brief",
    "Save the presenter's spoken summary of the talk. Generates the digest and the judge panel; returns the judge titles when the panel is on screen.",
    "NON_BLOCKING",
    async (a) => {
      const brief = {
        title: a.title, audience: a.audience, goal: a.goal, keyPoints: a.key_points, setting: a.setting,
        ...(a.duration_min !== undefined ? { durationMin: a.duration_min } : {}),
      };
      const r = dispatch({ type: "save_brief", brief });
      if (!r.ok) return toTool(r);
      await context.setBrief(brief);
      const n = session.get().scene.judges.length || 3;
      return regeneratePanel(n === 0 ? 3 : n, { withAudience: true });
    },
    "WHEN_IDLE");

  reg("start_run",
    "Start a run (countdown, slides, then Q&A). Omit mode and level to follow the coach recommendation; pass them only when the user asks to deviate.",
    "BLOCKING",
    async (a) => toTool(dispatch({ type: "start_run", ...(a.mode ? { mode: a.mode } : {}), ...(a.level ? { level: a.level } : {}) }), runInfo()));

  reg("end_run", "End the current run early. The partial run is kept and reported.", "BLOCKING", async () => {
    const id = session.get().run?.runId;
    return toTool(dispatch({ type: "end_run" }), { run_id: id });
  });

  reg("run_it_back", "Repeat the last run with the same mode, feedback level and panel. The coach does not advance.", "BLOCKING",
    async () => toTool(dispatch({ type: "run_it_back" }), runInfo()));

  reg("resume_run", "Resume a run paused by 'Hey JJ'. Call this after answering, unless the user asked to stop or restart.", "BLOCKING",
    async () => toTool(dispatch({ type: "resume" })));

  reg("go_to_slide", "Show a slide during a run. index is 0-based.", "BLOCKING", async (a) => {
    const slides = session.get().context.deck?.slides.length ?? 0;
    if (a.index >= slides) return { ok: false, reason: "invalid_args", hint: `the deck has ${slides} slides (0-${Math.max(0, slides - 1)})` };
    return toTool(dispatch({ type: "slide", index: a.index }), { index: a.index });
  });

  reg("set_targets", "Set the one or two behaviour patterns to train. The screen edges turn red when they persist.", "BLOCKING",
    async (a) => {
      const targets = [...new Set(a.behaviors)];
      return toTool(dispatch({ type: "set_targets", targets }), { targets });
    });

  reg("set_feedback_level", "Override the feedback level (strong, gentle, off) for the next runs, when the user asks.", "BLOCKING",
    async (a) => toTool(dispatch({ type: "set_level", level: a.level }), { level: a.level }));

  reg("set_feedback_categories", "Choose which feedback categories are measured and shown.", "BLOCKING",
    async (a) => {
      const enabled = [...new Set(a.enabled)];
      return toTool(dispatch({ type: "set_categories", enabled }), { enabled });
    });

  reg("highlight_pattern", "Light up the pattern card you are talking about in the run report. Use 'none' to clear.", "BLOCKING",
    async (a) => {
      const sent = hub.send("stage", { type: "report.focus", payload: { kind: a.kind === "none" ? null : a.kind } });
      return sent ? { ok: true } : { ok: false, reason: "stage_offline", hint: "the main screen is not connected" };
    });

  reg("get_last_run_report",
    "Get the compact report of the last finished run: patterns with moments, target progress, the recommendation and its reason.",
    "BLOCKING",
    async () => {
      const last = session.get().completedRuns.at(-1) as RunId | undefined;
      if (!last) return { ok: false, reason: "not_available", hint: "no run has finished yet" };
      const report = reports.compactRunReport(last);
      return report ? { ok: true, report } : { ok: false, reason: "not_available", hint: `no report for ${last} yet` };
    });

  reg("get_session_state", "Get the session phase, coach stage and level, targets and the panel.", "BLOCKING", async () => {
    const s = session.get();
    return {
      ok: true,
      phase: s.phase,
      intro_done: s.introDone,
      run: s.run ? { run_id: s.run.runId, mode: s.run.mode, level: s.run.feedbackLevel, phase: s.run.phase, paused: s.run.paused, slide: s.run.slideIndex } : null,
      completed_runs: s.completedRuns.length,
      coach: {
        stage: s.coach.stage, level: s.coach.level, score: s.coach.score, training_runs: s.coach.trainingRuns,
        targets: s.coach.targets.map((t) => ({ kind: t.kind, status: t.status, clean_streak: t.cleanStreak })),
        recommendation: s.coach.recommendation,
      },
      enabled_categories: s.enabledCategories,
      panel: s.scene.judges.map((j) => ({ id: j.id, title: j.title, toughness: j.toughness, style: j.style })),
      audience: s.scene.audience.count,
      qa_questions: s.scene.qa.questions,
      lighting: s.scene.lighting,
      slides: s.context.deck?.slides.length ?? 0,
    };
  });

  reg("set_judge", "Change one judge: left, center, right or a judge id; toughness 0 (friendly) to 1 (hard but professional), style, title.",
    "BLOCKING",
    async (a) => {
      const patch = {
        ...(a.toughness !== undefined ? { toughness: a.toughness } : {}),
        ...(a.style ? { style: a.style } : {}),
        ...(a.title ? { title: a.title } : {}),
      };
      if (Object.keys(patch).length === 0) return { ok: false, reason: "invalid_args", hint: "give toughness, style or title" };
      const j = resolveJudge(session.get().scene.judges, a.judge);
      if ("error" in j) return { ok: false, reason: "invalid_args", hint: j.error };
      return scene([{ op: "judge.update", id: j.id, patch }]);
    });

  reg("set_judges", "Change the whole panel: count 1-5 (generates new personas), and/or toughness and style for every judge.",
    "BLOCKING",
    async (a) => {
      const s = session.get();
      if (a.count === undefined && a.toughness === undefined && !a.style) return { ok: false, reason: "invalid_args", hint: "give count, toughness or style" };
      if (a.count !== undefined && a.count !== s.scene.judges.length) {
        return regeneratePanel(a.count, { ...(a.toughness !== undefined ? { toughness: a.toughness } : {}), ...(a.style ? { style: a.style } : {}), withAudience: false });
      }
      const patch = { ...(a.toughness !== undefined ? { toughness: a.toughness } : {}), ...(a.style ? { style: a.style } : {}) };
      if (Object.keys(patch).length === 0) return { ok: true, version: s.scene.version };
      return scene(s.scene.judges.map((j) => ({ op: "judge.update" as const, id: j.id, patch })));
    });

  reg("regenerate_personas", "Generate a new panel following one instruction, e.g. 'more technical'. Returns the new judge titles.",
    "NON_BLOCKING",
    async (a) => regeneratePanel(session.get().scene.judges.length || 3, { instruction: a.instruction, withAudience: false }),
    "WHEN_IDLE");

  reg("set_audience", "Set how many audience members sit behind the panel (0-40).", "BLOCKING",
    async (a) => scene([{ op: "audience.set", count: a.count }]));

  reg("set_qa", "Set how many questions the panel asks after the last slide (0-5).", "BLOCKING", async (a) => {
    const qa = session.get().scene.qa;
    return scene([{ op: "qa.set", qa: { ...qa, questions: a.questions } }]);
  });

  reg("set_lighting", "Set the room lighting: default, stage or dim.", "BLOCKING",
    async (a) => scene([{ op: "lighting.set", preset: a.preset, transitionMs: deps.lightingTransitionMs ?? 1500 }]));

  reg("show_final", "End the practice and show the final report: where the presenter started and where they are now. Call it when the user says they are done, or when the recommendation says done.", "BLOCKING", async () => {
    const s = session.get();
    const r = dispatch({ type: "show_final" });
    return toTool(r, { baseline_run_id: s.completedRuns[0] ?? null, final_run_id: s.completedRuns.at(-1) ?? null,
      progress: r.ok ? reports.sessionProgress?.() ?? null : null });
  });

  reg("calibrate_gaze", "Calibrate where each judge sits, by asking the user to look at each one in turn.", "BLOCKING", async () => {
    if (!deps.calibration) return { ok: false, reason: "not_available", hint: "gaze calibration is not enabled" };
    const r = dispatch({ type: "start_calibration" });
    if (!r.ok) return toTool(r);
    return toTool(await deps.calibration.run());
  });

  return registry;
}
