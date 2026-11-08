import type { ClientRole, JudgeDef, Result, RunId, SceneOp, SessionState } from "@coach/protocol";
import type { Clock } from "../src/clock.ts";
import type { ContextPort, HubPort, JJDownlink, MicPort, ReportsPort, SessionActionLike, SessionPort } from "../src/jj/ports.ts";

export const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

export { VirtualClock } from "../src/clock.ts";

export const judge = (n: number, over: Partial<JudgeDef> = {}): JudgeDef => ({
  id: `judge_${n}` as JudgeDef["id"], title: `Judge ${n}`, background: "b", seat: `judge_seat_${n}`,
  voiceId: `v${n}`, toughness: 0.5, style: "neutral", priorities: [], ...over,
});

export function initialState(): SessionState {
  return {
    sessionId: "s1", phase: "setup", view: "setup",
    context: { deck: { deckId: "d1", name: "deck", slides: [0, 1, 2, 3, 4].map((i) => ({ index: i, url: `/x/${i}.png`, text: `slide ${i}` })) }, docs: [], brief: null, digest: "A pitch." },
    scene: { version: 1, venueId: "v", qa: { questions: 2, answerCapMs: 45000 }, judges: [judge(1), judge(2), judge(3)], audience: { count: 10 }, lighting: "default" },
    run: null, completedRuns: [],
    coach: { stage: "baseline", level: "off", targets: [], score: 0.8, recommendation: null, trainingRuns: 0 },
    enabledCategories: ["posture", "disfluencies", "pace"], calibration: null, introDone: false,
    wake: { active: false, via: null, since: null },
  };
}

/** Minimal session store covering the transitions the JJ engine reacts to. */
export class FakeSession implements SessionPort {
  s: SessionState = initialState();
  actions: SessionActionLike[] = [];
  sceneOps: SceneOp[][] = [];
  sceneResult: Result<{ version: number }> | null = null;   // force an applyScene outcome
  private subs: ((s: SessionState, c: SessionActionLike | SceneOp[]) => void)[] = [];
  constructor(private clock: Clock) {}

  get() { return this.s; }
  subscribe(fn: (s: SessionState, c: SessionActionLike | SceneOp[]) => void) { this.subs.push(fn); return () => {}; }
  private emit(c: SessionActionLike | SceneOp[]) { for (const f of this.subs) f(this.s, c); }

  dispatch(a: SessionActionLike): Result {
    this.actions.push(a);
    const s = this.s;
    const ok = (): Result => { this.emit(a); return { ok: true }; };
    const wrong = (): Result => ({ ok: false, reason: "wrong_phase" });
    switch (a.type) {
      case "session_start": if (s.phase !== "setup") return wrong(); s.phase = s.introDone ? "debrief" : "intro"; return ok();
      case "save_brief": if (s.phase !== "intro") return wrong(); s.context.brief = a.brief as SessionState["context"]["brief"]; return ok();
      case "start_run": case "run_it_back": {
        if (!["intro", "debrief", "final"].includes(s.phase)) return wrong();
        const index = s.completedRuns.length + 1;
        s.phase = "running"; s.introDone = true;
        s.run = { runId: `run_${index}` as RunId, index, mode: (a.mode as "baseline") ?? "baseline", feedbackLevel: (a.level as "off") ?? "off", targets: [], enabledCategories: [], sceneVersion: s.scene.version, phase: "countdown", slideIndex: 0, paused: false, pausedMs: 0 };
        return ok();
      }
      case "slide": if (s.phase !== "running" || !s.run) return wrong(); s.run.slideIndex = a.index as number; return ok();
      case "wake":
        if (s.phase !== "running" || !s.run || s.run.paused) return ok();
        s.run.paused = true; s.wake = { active: true, via: a.via as "phrase", since: this.clock.now() }; return ok();
      case "resume":
        if (!s.run?.paused) return wrong();
        s.run.paused = false; s.wake = { active: false, via: null, since: null }; return ok();
      case "end_run": case "qa_done":
        if (s.phase !== "running" || !s.run) return wrong();
        s.run.phase = "ended"; s.run.paused = false; s.wake = { active: false, via: null, since: null };
        s.completedRuns.push(s.run.runId); s.phase = "debrief"; return ok();
      case "abort_run":
        if (s.phase !== "running" || !s.run) return wrong();
        s.run.phase = "aborted"; s.phase = "debrief"; return ok();
      case "reset": s.phase = "setup"; return ok();
      case "show_final": if (s.phase !== "debrief") return wrong(); s.phase = "final"; return ok();
      default: return ok();
    }
  }

  /** Advance the run's phase directly (countdown → presentation → qa). */
  setRunPhase(p: NonNullable<SessionState["run"]>["phase"]) { this.s.run!.phase = p; this.emit({ type: "tick" }); }

  async applyScene(ops: SceneOp[]): Promise<Result<{ version: number }>> {
    this.sceneOps.push(ops);
    if (this.sceneResult) return this.sceneResult;
    for (const op of ops) {
      if (op.op === "judges.set") this.s.scene.judges = op.judges;
      if (op.op === "judge.update") this.s.scene.judges = this.s.scene.judges.map((j) => (j.id === op.id ? { ...j, ...op.patch } : j));
      if (op.op === "audience.set") this.s.scene.audience.count = op.count;
      if (op.op === "qa.set") this.s.scene.qa = op.qa;
      if (op.op === "lighting.set") this.s.scene.lighting = op.preset;
    }
    this.s.scene.version++;
    this.emit(ops);
    return { ok: true, version: this.s.scene.version };
  }
}

export class FakeHub implements HubPort {
  sent: { role: ClientRole; msg: JJDownlink }[] = [];
  audio: { source: number; flags: number; seq: number; samples: number }[] = [];
  connected = new Set<ClientRole>(["stage", "operator"]);
  send(role: ClientRole, msg: JJDownlink) { if (!this.connected.has(role)) return false; this.sent.push({ role, msg }); return true; }
  broadcast(roles: ClientRole[], msg: JJDownlink) { for (const r of roles) this.send(r, msg); }
  sendAudio(source: number, flags: number, seq: number, pcm: Int16Array) { this.audio.push({ source, flags, seq, samples: pcm.length }); }
  ofType<T extends JJDownlink["type"]>(t: T) { return this.sent.filter((x) => x.msg.type === t).map((x) => x.msg as Extract<JJDownlink, { type: T }>); }
}

export class FakeMic implements MicPort {
  jj = false;
  replayed: number[] = [];
  buffer = new Int16Array(16000);    // 1 s
  sinks(): ("stt" | "jj")[] { return this.jj ? ["jj"] : ["stt"]; }
  replaySince(t: number) { this.replayed.push(t); return this.buffer; }
}

export class FakeContext implements ContextPort {
  briefs: unknown[] = [];
  personaCalls: { n: number; instruction?: string }[] = [];
  async setBrief(b: unknown) { this.briefs.push(b); }
  async generatePersonas(n: number, instruction?: string) {
    this.personaCalls.push({ n, ...(instruction ? { instruction } : {}) });
    return {
      judges: Array.from({ length: n }, (_, i) => ({ title: `Persona ${i + 1}`, background: "bg", style: "skeptical" as const, toughness: 0.9, priorities: ["a", "b", "c", "d"] })),
      audienceCount: 12,
    };
  }
}

export class FakeReports implements ReportsPort {
  reports = new Map<string, unknown>();
  compactRunReport(id: RunId) { return this.reports.get(id) ?? null; }
  preRunCheck?: () => { ready: boolean; hints: string[] };
}

export const voiced = (n = 320, amp = 3000) => new Int16Array(n).map((_, i) => (i % 2 ? amp : -amp));
export const silent = (n = 320) => new Int16Array(n);
