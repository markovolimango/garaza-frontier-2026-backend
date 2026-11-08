/**
 * Feedback agent, filler part: turns the listener's board `filler` events into the red edge vignette
 * (sync.forceVignette). Policy = board `feedback.policy` (JJ's command), default fillers "burst":
 *
 *   burst  ≥ 2 fillers within 10 s (fillers after the last vignette only, so one burst = one flash)
 *   every  each phrase with fillers
 *   off    nothing
 *
 * Fires only while the run is live (presentation / qa), not paused, `run.feedbackLevel !== "off"`, and
 * for this run's focus: with targets only if `filler_burst` is one; without targets only if
 * `disfluencies` is in `run.enabledCategories` (as services/coach brain_bridge.py `vignette_for`).
 * Intensity 0.7 strong / 0.4 gentle, held 2.5 s. Body vignettes are not the swarm's: the camera coach's
 * bridge (services/coach) sends them.
 */
import type { RunState, SessionState } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import type { SwarmBoard, SwarmCommand } from "./board.ts";

export type FeedbackPolicy = Extract<SwarmCommand, { type: "feedback.policy" }>;
export const DEFAULT_FEEDBACK_POLICY: FeedbackPolicy = { type: "feedback.policy", fillers: "burst" };

export interface FillerFeedbackOptions {
  board: SwarmBoard;
  session: { get(): Readonly<SessionState>; subscribe(fn: (s: SessionState, cause: unknown) => void): unknown };
  sync: { forceVignette(kind: "warn" | "reward", intensity: number, holdMs: number): void };
  clock: Clock;
  log?: Logger;
  windowMs?: number;   // 10 000
  burstMin?: number;   // 2
  holdMs?: number;     // 2500
}

export const fillerPolicy = (board: SwarmBoard): FeedbackPolicy["fillers"] => (board.latest("feedback.policy") ?? DEFAULT_FEEDBACK_POLICY).fillers;

/** Why fillers may not turn the vignette on in this run now (null = they may). */
export function fillerVignetteBlocked(s: Readonly<SessionState>, runId: string): string | null {
  const run: RunState | null = s.run;
  if (s.phase !== "running" || !run || run.runId !== runId || (run.phase !== "presentation" && run.phase !== "qa")) return "no live run";
  if (run.paused) return "paused";
  if (run.feedbackLevel === "off") return "this run has no live feedback";
  if (run.targets.length) return run.targets.includes("filler_burst") ? null : "fillers are not a target";
  return run.enabledCategories.includes("disfluencies") ? null : "disfluencies are off";
}

export class FillerFeedback {
  private readonly log: Logger;
  private runId: string | null = null;
  private times: number[] = [];           // filler times since the last vignette (this run)
  private fired = 0;
  private resetTimer: unknown = null;

  constructor(private readonly o: FillerFeedbackOptions) {
    this.log = o.log ?? (() => {});
    o.board.on("filler", (e) => this.onFiller(e.runId, e.words, e.at));
    o.board.onCommand("feedback.policy", () => this.idle());
    o.session.subscribe(() => { if (!this.resetTimer) this.idle(); });
    this.idle();
  }

  private onFiller(runId: string, words: string[], at: number): void {
    if (runId !== this.runId) { this.runId = runId; this.times = []; this.fired = 0; }
    for (let i = 0; i < words.length; i++) this.times.push(at);
    const windowMs = this.o.windowMs ?? 10_000;
    this.times = this.times.filter((t) => t > at - windowMs);
    const policy = fillerPolicy(this.o.board);
    if (policy === "off") return;
    const s = this.o.session.get();
    const blocked = fillerVignetteBlocked(s, runId);
    if (blocked) { this.log("info", "feedback.filler_skipped", { runId, why: blocked }); return; }
    const n = this.times.length;
    if (policy === "burst" && n < (this.o.burstMin ?? 2)) return;
    const spanS = Math.max(1, Math.round((at - this.times[0]!) / 1000));
    const strong = s.run!.feedbackLevel === "strong";
    const holdMs = this.o.holdMs ?? 2500;
    this.o.sync.forceVignette("warn", strong ? 0.7 : 0.4, holdMs);
    this.times = [];
    this.fired++;
    const detail = policy === "every" ? `red: ${words.length} filler${words.length === 1 ? "" : "s"} (${words.join(", ")})` : `red: ${n} fillers in ${spanS} s`;
    this.log("info", "feedback.filler_vignette", { runId, policy, fillers: n, strong });
    this.o.board.status("feedback", "working", detail);
    if (this.resetTimer) this.o.clock.clearTimeout(this.resetTimer);
    this.resetTimer = this.o.clock.setTimeout(() => { this.resetTimer = null; this.idle(); }, holdMs);
  }

  /** Resting status: what fillers would do in the current run. */
  private idle(): void {
    const policy = fillerPolicy(this.o.board);
    const s = this.o.session.get();
    const run = s.run;
    const live = s.phase === "running" && run && (run.phase === "presentation" || run.phase === "qa");
    if (!live) { this.o.board.status("feedback", "idle", `ready · fillers: ${policy}`); return; }
    if (policy === "off") { this.o.board.status("feedback", "idle", "fillers: off"); return; }
    const blocked = fillerVignetteBlocked(s, run.runId);
    const fired = this.runId === run.runId && this.fired ? ` · ${this.fired} shown` : "";
    if (blocked) this.o.board.status("feedback", "idle", `fillers: ${blocked}${fired}`);
    else this.o.board.status("feedback", "watching", `fillers: ${policy}${fired}`);
  }
}
