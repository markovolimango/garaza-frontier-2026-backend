/**
 * RunLog: what happened in each run, from what the brain observes today (no STT, no gaze):
 * slide changes, coach observations (`coach.observation` from the sensor role, i.e. the
 * services/coach bridge), vignette commands, wakes and Q&A turns. Feeds the run digest
 * (digest.ts, `GET /api/runs/:runId/report`) and the observed coach policy (observedCoach.ts).
 *
 * Not the spec's full event store (events.ts): that one also holds word tokens and gaze.
 */
import type { BehaviorKind, ClientRole, DownlinkMessage, FeedbackCategory, JudgeId, RunId, RunState, Uplink } from "@coach/protocol";
import type { Clock } from "./clock.ts";
import type { SessionCause, SessionStore } from "./session.ts";

export type Segment = "presentation" | "qa";
export type EndedBy = "qa_done" | "end_run" | "presentation_done" | "aborted";

export interface Observation {
  rule: string; kind: BehaviorKind | null; category: FeedbackCategory | null; text: string;
  at: number; slideIndex: number; segment: Segment;
}
export interface QaTurnRecord { judgeId: JudgeId; judgeTitle: string; question: string; askedAt: number; answerMs: number }

export interface RunRecord {
  runId: RunId;
  run: RunState;                                   // latest snapshot
  slides: { index: number; at: number }[];         // from the presentation start
  observations: Observation[];
  feedback: { kind: "warn" | "reward"; at: number }[];
  wakes: number;
  qa: QaTurnRecord[];
  coachConnected: boolean;                         // the sensor role (coach bridge) was connected during the run
  qaStartedAt: number | null;
  endedAt: number | null;
  endedBy: EndedBy | null;
}

export interface RunLogHub {
  on(type: "coach.observation", handler: (msg: Uplink<"coach.observation">, role: ClientRole) => void): void;
  onOutbound(fn: (msg: DownlinkMessage, roles: ClientRole[]) => void): void;
  connections(): Record<ClientRole, boolean>;
}

const ENDED_BY: Partial<Record<string, EndedBy>> = { qa_done: "qa_done", end_run: "end_run", presentation_done: "presentation_done", abort_run: "aborted" };

export class RunLog {
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly endedFns: ((rec: RunRecord) => void)[] = [];

  constructor(private readonly o: { session: SessionStore; hub: RunLogHub; clock: Clock }) {
    o.session.subscribe((s, cause) => this.onChange(s.run, cause));
    o.hub.on("coach.observation", (m) => {
      const rec = this.live();
      if (!rec) return;
      const p = m.payload;
      rec.observations.push({ rule: p.rule, kind: p.kind, category: p.category, text: p.text, at: o.clock.now(),
        slideIndex: rec.run.slideIndex, segment: rec.run.phase === "qa" ? "qa" : "presentation" });
    });
    o.hub.onOutbound((msg) => {
      if (msg.type !== "feedback.set" || msg.payload.kind === "none") return;
      this.live()?.feedback.push({ kind: msg.payload.kind, at: o.clock.now() });
    });
  }

  /** Called once per run, right after it ends (not aborted runs' coach update, but they are logged too). */
  onRunEnded(fn: (rec: RunRecord) => void): void { this.endedFns.push(fn); }

  get(runId: string): RunRecord | null { return this.runs.get(runId as RunId) ?? null; }
  list(): RunRecord[] { return [...this.runs.values()]; }
  latest(): RunRecord | null { return this.list().at(-1) ?? null; }

  /** The run whose presentation or Q&A is under way. */
  live(): RunRecord | null {
    const rec = this.latest();
    return rec && (rec.run.phase === "presentation" || rec.run.phase === "qa") ? rec : null;
  }

  recordQa(runId: RunId, turn: QaTurnRecord): void { this.runs.get(runId)?.qa.push(turn); }

  private onChange(run: RunState | null, cause: SessionCause): void {
    if (!run) return;
    const now = this.o.clock.now();
    let rec = this.runs.get(run.runId);
    if (!rec) {
      rec = { runId: run.runId, run: structuredClone(run), slides: [], observations: [], feedback: [], wakes: 0, qa: [],
        coachConnected: false, qaStartedAt: null, endedAt: null, endedBy: null };
      this.runs.set(run.runId, rec);
    }
    const before = rec.run;
    rec.run = structuredClone(run);
    if (this.o.hub.connections().sensor) rec.coachConnected = true;
    if (Array.isArray(cause)) return;
    if (run.phase === "presentation" && before.phase !== "presentation" && rec.slides.length === 0) rec.slides.push({ index: run.slideIndex, at: now });
    if (cause.type === "slide" && run.phase === "presentation") rec.slides.push({ index: cause.index, at: now });
    if (run.phase === "qa" && rec.qaStartedAt === null) rec.qaStartedAt = now;
    if (cause.type === "wake" && run.paused && !before.paused) rec.wakes++;
    if ((run.phase === "ended" || run.phase === "aborted") && rec.endedAt === null) {
      rec.endedAt = run.endedAt ?? now;
      rec.endedBy = ENDED_BY[cause.type] ?? (run.phase === "aborted" ? "aborted" : null);
      for (const fn of this.endedFns) fn(rec);
    }
  }
}
