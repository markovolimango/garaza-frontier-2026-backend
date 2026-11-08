/**
 * DirectorAgent: the swarm's judges' director. It is the Director's strategy (director.ts) and an
 * agent on the swarm board (swarm/board.ts). Every LLM step has a deterministic fallback.
 *
 *  - Plans while the presenter presents: at the presentation start, every `planEveryMs` and after a
 *    slide change or a `director.brief` (debounced, one call at a time), the LLM writes the Q&A
 *    questions per judge (persona + tone) from the board transcript, deck, brief, panel and the
 *    latest `director.brief`. The template plan (questions.ts) is ready from the start, so the Q&A
 *    never waits.
 *  - Live reactions to the presenter's phrases (heuristics, at most one per `reactionGapMs`):
 *    numbers → a judge takes a note; a long phrase with fillers → the toughest judge checks the
 *    watch; a big claim → the skeptic leans in; now and then a warm judge nods. → `judge.line reaction`.
 *  - Q&A: the answer's words are the board's qa phrases since the judge stopped asking (waits up to
 *    `transcriptWaitMs` for the listener's last one). The LLM decides follow-up / next / close and a
 *    verdict within `decideTimeoutMs`; on timeout or error → next question, heuristic verdict.
 *    Optional cut-ins (`interrupts: true`): a tough judge stops a rambling answer past half the cap.
 *  - Board: `judge.line` for questions, follow-ups (and cut-ins), the closing line (with `verdicts`)
 *    and reactions; a one-line `agent.note` to JJ at the end; `status` all the time.
 *  - Reset (a new session): the brief, plans, verdicts and cut-ins are forgotten, and an LLM answer
 *    still on its way for the old session is dropped (run ids restart at run_1).
 */
import type { Downlink, Gesture, JudgeDef, JudgeId, RunId, SessionState } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import type { SessionCause } from "../session.ts";
import type { AgentState, Phrase, QaVerdict, Strictness, SwarmBoard, SwarmCommand } from "../swarm/board.ts";
import type { AskedTurn, CutIn, DirectorState, DirectorStrategy, LineKind, NextStep } from "./director.ts";
import {
  DECIDE_SCHEMA, DECIDE_SYSTEM, PLAN_SYSTEM, decidePrompt, heuristicVerdict, planPrompt, planSchema, readDecision, readPlan,
  type DirectorWishes, type PanelJudge,
} from "./prompts.ts";
import { CLOSING_LINE, planQuestions, snippet, type PlannedQuestion } from "./questions.ts";

export type DirectorBrief = Extract<SwarmCommand, { type: "director.brief" }>;
export interface LlmCall { task: "plan" | "decide"; system: string; prompt: string; schema: Record<string, unknown>; timeoutMs: number }
/** One structured LLM call (llmJson in production; injected in tests). Resolves with the parsed JSON. */
export type DirectorLlm = (c: LlmCall) => Promise<unknown>;

export interface DirectorAgentOptions {
  board: SwarmBoard;
  session: { get(): Readonly<SessionState>; subscribe(fn: (s: Readonly<SessionState>, cause: SessionCause) => void): unknown };
  hub: { send(role: "stage", msg: Downlink<"actor.gesture" | "actor.lookAt">): boolean };
  clock: Clock;
  log?: Logger;
  /** null: no LLM (no key), templates and heuristics only. */
  llm: DirectorLlm | null;
  planEveryMs?: number;       // 25 s
  slideDebounceMs?: number;   // 3 s
  planTimeoutMs?: number;     // 8 s
  decideTimeoutMs?: number;   // 4 s
  transcriptWaitMs?: number;  // 1.5 s
  reactionGapMs?: number;     // 8 s
  /** Live reactions during the presentation. Default true. */
  reactions?: boolean;
}

interface Plan { runId: RunId; questions: PlannedQuestion[]; source: "llm" | "template"; consumed: boolean }

const NUMBER = /\d|\b(percent|million|thousand|billion|hundred)\b|[€$%]/i;
const CLAIM = /\b(only|first|unique|best|revolutionary|nobody|no one|10x|disrupt\w*|guarantee\w*|never)\b/i;
const FILLER = /\b(um+|uh+|erm|like|you know|basically|actually|sort of|kind of|i mean)\b/gi;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export class DirectorAgent implements DirectorStrategy {
  private readonly log: Logger;
  private brief: DirectorBrief | null;
  private presenting: RunId | null = null;
  private plan_: Plan | null = null;
  private everyTimer: unknown = null;
  private soonTimer: unknown = null;
  private inFlight = false;
  private dirty = false;
  private lastReactionAt = -Infinity;
  /** Bumped on a session reset: LLM answers for the old session are dropped (run ids restart at run_1). */
  private gen = 0;
  private readonly verdicts = new Map<RunId, QaVerdict[]>();
  private readonly cutIns = new Set<string>();
  private readonly phraseWaiters = new Set<() => void>();

  constructor(private readonly o: DirectorAgentOptions) {
    this.log = o.log ?? (() => {});
    this.brief = o.board.latest("director.brief");
    o.board.onCommand("director.brief", (c) => this.onBrief(c));
    o.board.on("phrase", (e) => this.onPhrase(e.phrase));
    o.session.subscribe((s, cause) => this.onSession(s, cause));
    this.setStatus("idle", this.o.llm ? "waiting for a run" : "waiting for a run · templates (no LLM)");
  }

  // ---------------- the brief and the panel ----------------
  private onBrief(c: DirectorBrief): void {
    this.brief = c;
    this.log("info", "director.brief", { ...c });
    if (this.presenting) {
      this.templatePlanIfNone(this.o.session.get(), true);
      this.schedulePlan(1000);
    }
    this.setStatus(this.presenting ? "listening" : "idle", `brief: ${this.briefLabel()}`);
  }

  private briefLabel(): string {
    const b = this.brief;
    if (!b) return "default";
    return [b.strictness, b.focus?.length ? `focus ${b.focus.join(", ")}` : "",
      b.followUps === false ? "no follow-ups" : "", b.interrupts ? "interrupts" : ""].filter(Boolean).join(" · ") || "default";
  }

  strictnessOf(j: JudgeDef): Strictness {
    return this.brief?.perJudge?.[j.id] ?? this.brief?.strictness ?? (j.toughness >= 0.7 ? "tough" : j.toughness <= 0.35 ? "kind" : "neutral");
  }

  /** The panel with the brief applied (tough → toughness ≥ 0.85, kind → ≤ 0.3), for ordering. */
  private panel(s: Readonly<SessionState>): PanelJudge[] {
    return s.scene.judges.map((j) => {
      const strictness = this.strictnessOf(j);
      const toughness = strictness === "tough" ? Math.max(j.toughness, 0.85) : strictness === "kind" ? Math.min(j.toughness, 0.3) : j.toughness;
      return { judge: { ...j, toughness }, strictness };
    });
  }

  /** How many questions: the scene's (set_qa). 0 = no Q&A. */
  private count(s: Readonly<SessionState>): number {
    return Math.max(0, Math.min(5, Math.round(s.scene.qa.questions)));
  }

  private wishes(): DirectorWishes { return { focus: this.brief?.focus, note: this.brief?.note }; }

  private templates(s: Readonly<SessionState>, count = this.count(s)): PlannedQuestion[] {
    return planQuestions(s.context.deck ?? null, this.panel(s).map((p) => p.judge), count, (s.run?.index ?? 1) - 1)
      .map((q) => ({ ...q, judgeTitle: s.scene.judges.find((j) => j.id === q.judgeId)?.title ?? q.judgeTitle }));
  }

  private templatePlanIfNone(s: Readonly<SessionState>, force = false): void {
    const runId = s.run?.runId;
    if (!runId) return;
    if (!force && this.plan_?.runId === runId) return;
    if (force && this.plan_?.runId === runId && this.plan_.source === "llm") return;   // keep the LLM plan until the next one
    this.plan_ = { runId, questions: this.templates(s), source: "template", consumed: false };
  }

  // ---------------- planning during the presentation ----------------
  private onSession(s: Readonly<SessionState>, cause: SessionCause): void {
    if (!Array.isArray(cause) && cause.type === "reset") { this.reset(); return; }
    const run = s.run;
    // pitch mode: no judges, so nothing to plan or react to
    const presenting = s.phase === "running" && run?.phase === "presentation" && !run.pitch ? run.runId : null;
    if (presenting && presenting !== this.presenting) {
      this.presenting = presenting;
      this.verdicts.delete(presenting);
      this.lastReactionAt = this.o.clock.now();
      this.templatePlanIfNone(s);
      this.setStatus("listening", this.readyLabel());
      this.schedulePlan(0);
      this.everyTick();
    } else if (!presenting && this.presenting) {
      this.presenting = null;
      this.clearTimers();
      if (run?.phase !== "qa") this.setStatus("idle", "waiting for a run");   // ended without a Q&A
    }
    if (presenting && !Array.isArray(cause) && cause.type === "slide") this.schedulePlan(this.o.slideDebounceMs ?? 3000);
    if (presenting && Array.isArray(cause) && cause.some((op) => op.op === "qa.set")) {   // set_qa: another number of questions
      this.templatePlanIfNone(s, true);
      this.schedulePlan(1000);
    }
  }

  /** A new session: nothing of the old one carries over (the board's brief is cleared with it). */
  private reset(): void {
    this.gen++;
    this.clearTimers();
    this.presenting = null;
    this.brief = null;
    this.plan_ = null;
    this.inFlight = this.dirty = false;
    this.lastReactionAt = -Infinity;
    this.verdicts.clear();
    this.cutIns.clear();
    this.setStatus("idle", "waiting for a run");
  }

  private everyTick(): void {
    if (this.everyTimer) this.o.clock.clearTimeout(this.everyTimer);
    this.everyTimer = this.o.clock.setTimeout(() => {
      this.everyTimer = null;
      if (!this.presenting) return;
      void this.planNow();
      this.everyTick();
    }, this.o.planEveryMs ?? 25_000);
  }

  private schedulePlan(ms: number): void {
    if (!this.o.llm) return;
    if (this.soonTimer) this.o.clock.clearTimeout(this.soonTimer);
    this.soonTimer = this.o.clock.setTimeout(() => { this.soonTimer = null; void this.planNow(); }, ms);
  }

  private clearTimers(): void {
    if (this.everyTimer) this.o.clock.clearTimeout(this.everyTimer);
    if (this.soonTimer) this.o.clock.clearTimeout(this.soonTimer);
    this.everyTimer = this.soonTimer = null;
  }

  /** One planning call (single flight; a request meanwhile runs once more after it). */
  async planNow(): Promise<void> {
    const runId = this.presenting;
    if (!runId || !this.o.llm) return;
    if (this.inFlight) { this.dirty = true; return; }
    this.inFlight = true;
    const gen = this.gen;
    const s = this.o.session.get();
    const count = this.count(s);
    const t0 = this.o.clock.now();
    this.setStatus("thinking", `planning ${count} questions…`);
    try {
      const out = await this.call({
        task: "plan", system: PLAN_SYSTEM, schema: planSchema(s.scene.judges.map((j) => j.id)), timeoutMs: this.o.planTimeoutMs ?? 8000,
        prompt: planPrompt({ count, panel: this.panel(s), deck: s.context.deck ?? null, brief: s.context.brief ?? null,
          transcript: this.o.board.transcript(runId, "presentation"), wishes: this.wishes() }),
      });
      if (gen !== this.gen) { this.log("info", "director.plan_dropped", { runId, why: "session reset" }); return; }
      const qs = readPlan(out, s.scene.judges, count, s.context.deck?.slides.length ?? 0);
      if (!qs.length && count > 0) throw new Error("empty plan");
      if (this.plan_?.runId === runId && this.plan_.consumed) { this.log("info", "director.plan_late", { runId }); return; }
      this.plan_ = { runId, questions: qs, source: "llm", consumed: false };
      this.log("info", "director.planned", { runId, ms: this.o.clock.now() - t0, questions: qs.map((q) => `${q.judgeId}: ${q.topic}`) });
    } catch (err) {
      this.log("warn", "director.plan_failed", { runId, ms: this.o.clock.now() - t0, err: String(err) });
    } finally {
      if (gen === this.gen) {   // after a reset the flags belong to the new session
        this.inFlight = false;
        if (this.presenting === runId) this.setStatus("listening", this.readyLabel());
        if (this.dirty && this.presenting === runId) { this.dirty = false; this.schedulePlan(this.o.slideDebounceMs ?? 3000); }
        else this.dirty = false;
      }
    }
  }

  private readyLabel(): string {
    const p = this.plan_;
    const n = p ? Math.min(p.questions.length, this.count(this.o.session.get())) : 0;
    return `planning · ${n} question${n === 1 ? "" : "s"} ready${p?.source === "template" ? " (templates)" : ""}`;
  }

  /** The LLM call raced against the brain clock (also the injected LLM in tests). */
  private call(c: LlmCall): Promise<unknown> {
    const llm = this.o.llm;
    if (!llm) return Promise.reject(new Error("no LLM"));
    return new Promise((resolve, reject) => {
      const timer = this.o.clock.setTimeout(() => reject(new Error(`timeout after ${c.timeoutMs} ms`)), c.timeoutMs);
      llm(c).then((v) => { this.o.clock.clearTimeout(timer); resolve(v); }, (e) => { this.o.clock.clearTimeout(timer); reject(e); });
    });
  }

  // ---------------- DirectorStrategy: the Q&A ----------------
  plan(runId: RunId, s: Readonly<SessionState>): PlannedQuestion[] {
    const count = this.count(s);
    const p = this.plan_?.runId === runId ? this.plan_ : null;
    const qs = (p?.questions ?? []).slice(0, count);
    if (qs.length < count) {   // fill from the templates, other topics first
      for (const t of this.templates(s, count)) {
        if (qs.length >= count) break;
        if (!qs.some((q) => q.topic === t.topic || q.text === t.text)) qs.push(t);
      }
    }
    if (p) p.consumed = true;
    this.verdicts.set(runId, []);
    const source = p?.source === "llm" ? (qs.every((q) => p.questions.includes(q)) ? "llm" : "llm+templates") : "templates";
    this.log("info", "director.qa_plan", { runId, source, questions: qs.map((q) => `${q.judgeId}: ${q.topic}`) });
    this.setStatus("thinking", `Q&A · ${qs.length} questions (${source})`);
    return qs;
  }

  async answer(runId: RunId, turn: AskedTurn): Promise<string> {
    const heard = () => this.o.board.phrases(runId, "qa").filter((p) => p.endAt > turn.listenFrom);
    const covered = () => turn.lastVoiceAt > 0 && heard().some((p) => p.endAt >= turn.lastVoiceAt - 1000);
    if (turn.answerMs > 0 && !covered()) {   // the listener sends a phrase ~2 s after it ends: wait for the last one
      const left = turn.endedAt + (this.o.transcriptWaitMs ?? 1500) - this.o.clock.now();
      if (left > 0) await this.waitFor(covered, left);
    }
    return heard().map((p) => p.text.trim()).filter(Boolean).join(" ");
  }

  private waitFor(ok: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.phraseWaiters.delete(check); this.o.clock.clearTimeout(timer); resolve(); };
      const check = () => { if (ok()) done(); };
      const timer = this.o.clock.setTimeout(done, ms);
      this.phraseWaiters.add(check);
    });
  }

  async decide(runId: RunId, a: { turn: AskedTurn; followUpAllowed: boolean; remaining: PlannedQuestion[]; turns: AskedTurn[] }): Promise<NextStep> {
    const { turn } = a;
    const s = this.o.session.get();
    const judge = s.scene.judges.find((j) => j.id === turn.q.judgeId);
    const followUpAllowed = a.followUpAllowed && this.brief?.followUps !== false;
    const gen = this.gen;
    const fallback = (): NextStep => {
      if (gen === this.gen) this.addVerdict(runId, turn, heuristicVerdict(String(turn.q.topic), turn.answer, turn.answerMs));
      // after a cut-in, ask for the short version instead of leaving the presenter hanging
      if (turn.interrupted && followUpAllowed) return { type: "followup", text: `In one sentence, please. ${turn.q.text}` };
      return { type: "next" };
    };
    if (!this.o.llm || !judge) return fallback();
    const t0 = this.o.clock.now();
    try {
      const out = await this.call({
        task: "decide", system: DECIDE_SYSTEM, schema: DECIDE_SCHEMA, timeoutMs: this.o.decideTimeoutMs ?? 4000,
        prompt: decidePrompt({ judge: { judge, strictness: this.strictnessOf(judge) }, question: turn.q.text, kind: turn.kind, answer: turn.answer,
          answerMs: turn.answerMs, interrupted: turn.interrupted, followUpAllowed, remaining: a.remaining, wishes: this.wishes() }),
      });
      const d = readDecision(out);
      if (gen !== this.gen) return { type: "next" };   // the Q&A was cancelled by a reset meanwhile
      this.addVerdict(runId, turn, { verdict: d.verdict, note: d.note });
      this.log("info", "director.decided", { runId, ms: this.o.clock.now() - t0, action: d.action, verdict: d.verdict, note: d.note });
      if (d.action === "followup" && followUpAllowed && d.text) return { type: "followup", text: d.text };
      if (d.action === "close") return d.text ? { type: "close", text: d.text } : { type: "close" };
      return { type: "next" };
    } catch (err) {
      this.log("warn", "director.decide_failed", { runId, ms: this.o.clock.now() - t0, err: String(err) });
      return fallback();
    }
  }

  private addVerdict(runId: RunId, turn: AskedTurn, v: Pick<QaVerdict, "verdict" | "note">): void {
    const list = this.verdicts.get(runId) ?? [];
    list.push({ judgeId: turn.q.judgeId, kind: turn.kind, topic: String(turn.q.topic), question: turn.q.text, answer: turn.answer,
      answerMs: turn.answerMs, verdict: v.verdict, note: v.note });
    this.verdicts.set(runId, list);
  }

  interrupt(runId: RunId, a: { q: PlannedQuestion; listenFrom: number; elapsedMs: number; capMs: number }): CutIn | null {
    if (this.brief?.interrupts !== true || a.elapsedMs < a.capMs / 2) return null;
    const key = `${runId}|${a.q.judgeId}|${a.q.topic}`;
    if (this.cutIns.has(key)) return null;
    const said = this.o.board.phrases(runId, "qa").filter((p) => p.endAt > a.listenFrom);
    const text = said.map((p) => p.text).join(" ");
    const fillers = said.reduce((n, p) => n + p.fillers.length, 0) || (text.match(FILLER)?.length ?? 0);
    const rambling = words(text) >= 40 && (fillers >= 3 || words(text) >= 90);
    if (!rambling) return null;
    const s = this.o.session.get();
    const asker = s.scene.judges.find((j) => j.id === a.q.judgeId);
    const tough = asker && this.strictnessOf(asker) === "tough" ? asker
      : [...s.scene.judges].filter((j) => this.strictnessOf(j) === "tough").sort((x, y) => y.toughness - x.toughness)[0];
    if (!tough) return null;
    this.cutIns.add(key);
    this.log("info", "director.cut_in", { runId, judgeId: tough.id, words: words(text), fillers });
    return { judgeId: tough.id, text: "Let me stop you there." };
  }

  line(runId: RunId, judgeId: JudgeId, kind: LineKind, text: string): void {
    const at = this.o.clock.now();
    if (kind === "closing") {
      this.o.board.emit({ type: "judge.line", line: { runId, judgeId, kind: "closing", text, at, verdicts: [...(this.verdicts.get(runId) ?? [])] } });
      return;
    }
    this.o.board.emit({ type: "judge.line", line: { runId, judgeId, kind: kind === "interrupt" ? "followup" : kind, text, at } });
  }

  status(state: DirectorState, detail: string): void { this.setStatus(state, detail); }

  closing(_runId: RunId, closer: JudgeId): string {
    const j = this.o.session.get().scene.judges.find((x) => x.id === closer);
    const tone = j ? this.strictnessOf(j) : "neutral";
    return tone === "kind" ? "Thank you, that was a pleasure. That's all from us." : tone === "tough" ? "Thank you. We have what we need." : CLOSING_LINE;
  }

  done(runId: RunId, turns: AskedTurn[]): void {
    const note = this.summary(runId, turns);
    this.o.board.note("director", note);
    this.setStatus("idle", `Q&A done · ${turns.length} turn${turns.length === 1 ? "" : "s"}`);
    this.log("info", "director.summary", { runId, note });
  }

  /** One line for JJ's debrief: "Q&A: 3 questions, 1 follow-up; dodged: pricing (no number given); strong: traction." */
  summary(runId: RunId, turns: AskedTurn[]): string {
    const vs = this.verdicts.get(runId) ?? [];
    const asked = turns.filter((t) => t.kind === "question").length;
    const fu = turns.length - asked;
    const head = `Q&A: ${asked} question${asked === 1 ? "" : "s"}${fu ? `, ${fu} follow-up${fu === 1 ? "" : "s"}` : ""}`;
    const by = (v: QaVerdict["verdict"]) => vs.filter((x) => x.verdict === v);
    const fmt = (list: QaVerdict[]) => [...new Map(list.map((x) => [x.topic, x])).values()].map((x) => (x.note ? `${x.topic} (${x.note})` : x.topic)).join(", ");
    const strong = [...new Set(by("answered").map((x) => x.topic))].filter((t) => !vs.some((x) => x.topic === t && x.verdict !== "answered"));
    const parts = [head,
      by("dodged").length ? `dodged: ${fmt(by("dodged"))}` : "",
      by("no_answer").length ? `no answer: ${fmt(by("no_answer"))}` : "",
      by("partial").length ? `partial: ${fmt(by("partial"))}` : "",
      strong.length ? `strong on: ${strong.join(", ")}` : "",
      turns.some((t) => t.interrupted) ? "a judge cut in on a rambling answer" : ""];
    return `${parts.filter(Boolean).join("; ")}.`;
  }

  // ---------------- live reactions during the presentation ----------------
  private onPhrase(p: Phrase): void {
    for (const w of [...this.phraseWaiters]) w();
    if (this.o.reactions === false || p.segment !== "presentation" || p.runId !== this.presenting) return;
    const now = this.o.clock.now();
    if (now - this.lastReactionAt < (this.o.reactionGapMs ?? 8000)) return;
    const r = this.pickReaction(p, now);
    if (!r) return;
    this.lastReactionAt = now;
    this.o.hub.send("stage", { type: "actor.gesture", payload: { actorId: r.judge.id, gesture: r.gesture } });
    if (r.gesture === "note") {
      this.o.hub.send("stage", { type: "actor.lookAt", payload: { actorId: r.judge.id, target: "notes" } });
      this.o.clock.setTimeout(() => { if (this.presenting === p.runId) this.o.hub.send("stage", { type: "actor.lookAt", payload: { actorId: r.judge.id, target: "presenter" } }); }, 2000);
    } else {
      this.o.hub.send("stage", { type: "actor.lookAt", payload: { actorId: r.judge.id, target: "presenter" } });
    }
    this.o.board.emit({ type: "judge.line", line: { runId: p.runId, judgeId: r.judge.id, kind: "reaction", text: r.text, at: now } });
  }

  /** Cheap heuristics: rambling → check_watch (toughest), numbers → note, big claim → lean_in (skeptic), else a warm nod now and then. */
  pickReaction(p: Phrase, now: number): { judge: JudgeDef; gesture: Gesture; text: string } | null {
    const judges = this.o.session.get().scene.judges;
    if (!judges.length) return null;
    const rank = (j: JudgeDef) => ({ tough: 2, neutral: 1, kind: 0 })[this.strictnessOf(j)] + j.toughness;
    const toughest = [...judges].sort((a, b) => rank(b) - rank(a))[0]!;
    const warmest = [...judges].sort((a, b) => rank(a) - rank(b))[0]!;
    const n = words(p.text);
    const fillers = p.fillers.length || (p.text.match(FILLER)?.length ?? 0);
    if ((n >= 20 && fillers >= 2) || n >= 45) return { judge: toughest, gesture: "check_watch", text: `${toughest.title} checks the watch (${n} words, ${fillers} fillers)` };
    if (NUMBER.test(p.text)) {
      const cares = judges.find((j) => j.priorities.some((x) => /number|metric|traction|revenue|business|market|money|pric/i.test(x)))
        ?? judges.find((j) => j.style === "skeptical") ?? toughest;
      return { judge: cares, gesture: "note", text: `${cares.title} notes: "${snippet(p.text, 60)}"` };
    }
    if (CLAIM.test(p.text)) {
      const skeptic = judges.find((j) => j.style === "skeptical") ?? toughest;
      return { judge: skeptic, gesture: "lean_in", text: `${skeptic.title} leans in at a big claim: "${snippet(p.text, 60)}"` };
    }
    if (fillers === 0 && n >= 8 && now - this.lastReactionAt >= 20_000) return { judge: warmest, gesture: "nod", text: `${warmest.title} nods` };
    return null;
  }

  private setStatus(state: DirectorState | AgentState, detail: string): void { this.o.board.status("director", state, detail); }
}
