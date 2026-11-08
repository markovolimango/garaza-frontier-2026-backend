/**
 * RunLog: what happened in each run, from what the brain observes today (no STT, no gaze):
 * slide changes, coach observations (`coach.observation` from the sensor role, i.e. the
 * services/coach bridge), behaviour episodes (`behavior` start/end from the same bridge: every
 * occurrence with its own times), vignette commands, wakes and Q&A turns. Feeds the run digest
 * (digest.ts, `GET /api/runs/:runId/report`), the session progress (progress.ts) and the observed
 * coach policy (observedCoach.ts).
 *
 * Not the spec's full event store (events.ts): that one also holds word tokens and gaze.
 */
import type { BehaviorKind, ClientRole, CoachState, DownlinkMessage, FeedbackCategory, JudgeId, RunId, RunState, Uplink } from "@coach/protocol";
import type { Clock } from "./clock.ts";
import type { SessionCause, SessionStore } from "./session.ts";

export type Segment = "presentation" | "qa";
export type EndedBy = "qa_done" | "end_run" | "presentation_done" | "aborted";

export interface Observation {
  rule: string; kind: BehaviorKind | null; category: FeedbackCategory | null; text: string;
  at: number; slideIndex: number; segment: Segment;
}
/** One occurrence of a camera behaviour (coach `behavior.episode` via the bridge). endAt null = still open. */
export interface EpisodeRecord {
  kind: BehaviorKind; startAt: number; endAt: number | null; slideIndex: number; segment: Segment; conf: number;
}
/** `answer`: the answer's words from the swarm listener (director agent), when known. */
export interface QaTurnRecord { judgeId: JudgeId; judgeTitle: string; question: string; askedAt: number; answerMs: number; answer?: string }

export interface RunRecord {
  runId: RunId;
  run: RunState;                                   // latest snapshot
  slides: { index: number; at: number }[];         // from the presentation start
  observations: Observation[];
  episodes: EpisodeRecord[];
  feedback: { kind: "warn" | "reward"; at: number }[];
  wakes: number;
  qa: QaTurnRecord[];
  coachConnected: boolean;                         // the sensor role (coach bridge) was connected during the run
  qaStartedAt: number | null;
  endedAt: number | null;
  endedBy: EndedBy | null;
  /** The coach right after the run ended (afterRun already applied): progress report. */
  coachAfter?: { score: number; stage: CoachState["stage"] } | null;
}

export interface RunLogHub {
  on<T extends "coach.observation" | "behavior">(type: T, handler: (msg: Uplink<T>, role: ClientRole) => void): void;
  onOutbound(fn: (msg: DownlinkMessage, roles: ClientRole[]) => void): void;
  connections(): Record<ClientRole, boolean>;
}

/** The coach rule that measures each camera behaviour (services/coach coaching.py / episodes.py). */
export const RULE_OF_KIND: Partial<Record<BehaviorKind, string>> = {
  arms_crossed: "body.arms_crossed", face_touch: "body.face_touch", looking_down: "body.looking_down",
  sway: "body.torso_movement_high", fast_hands: "body.hand_movement_high",
};

/** How often each behaviour showed in a run: episodes (every occurrence) or, for behaviours without
 *  episodes (speech, or an older coach), the throttled rule observations; the larger of the two. */
export function behaviorCounts(rec: Pick<RunRecord, "observations" | "episodes">): Map<BehaviorKind, number> {
  const obs = new Map<BehaviorKind, number>();
  for (const o of rec.observations) if (o.kind) obs.set(o.kind, (obs.get(o.kind) ?? 0) + 1);
  const eps = new Map<BehaviorKind, number>();
  for (const e of rec.episodes ?? []) eps.set(e.kind, (eps.get(e.kind) ?? 0) + 1);
  const out = new Map<BehaviorKind, number>();
  for (const kind of new Set([...obs.keys(), ...eps.keys()])) out.set(kind, Math.max(obs.get(kind) ?? 0, eps.get(kind) ?? 0));
  return out;
}

/** Total and longest episode time of one behaviour, in ms (open episodes up to `until`). */
export function episodeTime(rec: Pick<RunRecord, "episodes">, kind: BehaviorKind, until: number): { count: number; totalMs: number; longestMs: number } {
  let count = 0, totalMs = 0, longestMs = 0;
  for (const e of rec.episodes ?? []) {
    if (e.kind !== kind) continue;
    const ms = Math.max(0, (e.endAt ?? until) - e.startAt);
    count++; totalMs += ms; longestMs = Math.max(longestMs, ms);
  }
  return { count, totalMs, longestMs };
}

const ENDED_BY: Partial<Record<string, EndedBy>> = { qa_done: "qa_done", end_run: "end_run", presentation_done: "presentation_done", abort_run: "aborted" };

export class RunLog {
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly endedFns: ((rec: RunRecord) => void)[] = [];
  private readonly changedFns: (() => void)[] = [];

  /** `restore`: the runs of a session saved before a restart (persist.ts), oldest first. */
  constructor(private readonly o: { session: SessionStore; hub: RunLogHub; clock: Clock; restore?: RunRecord[] }) {
    for (const rec of o.restore ?? []) this.runs.set(rec.runId, rec);
    this.syncRestored();
    o.session.subscribe((s, cause) => this.onChange(s.run, cause));
    o.hub.on("coach.observation", (m) => {
      const rec = this.live();
      if (!rec) return;
      const p = m.payload;
      rec.observations.push({ rule: p.rule, kind: p.kind, category: p.category, text: p.text, at: o.clock.now(),
        slideIndex: rec.run.slideIndex, segment: rec.run.phase === "qa" ? "qa" : "presentation" });
      this.changed();
    });
    o.hub.on("behavior", (m) => this.onBehavior(m.payload));
    o.hub.onOutbound((msg) => {
      if (msg.type !== "feedback.set" || msg.payload.kind === "none") return;
      const rec = this.live();
      if (!rec) return;
      rec.feedback.push({ kind: msg.payload.kind, at: o.clock.now() });
      this.changed();
    });
  }

  /** Called once per run, right after it ends (not aborted runs' coach update, but they are logged too). */
  onRunEnded(fn: (rec: RunRecord) => void): void { this.endedFns.push(fn); }
  /** Any change to any record (persistence). */
  onChanged(fn: () => void): void { this.changedFns.push(fn); }

  get(runId: string): RunRecord | null { return this.runs.get(runId as RunId) ?? null; }
  list(): RunRecord[] { return [...this.runs.values()]; }
  latest(): RunRecord | null { return this.list().at(-1) ?? null; }

  /** The run whose presentation or Q&A is under way. */
  live(): RunRecord | null {
    const rec = this.latest();
    return rec && (rec.run.phase === "presentation" || rec.run.phase === "qa") ? rec : null;
  }

  /** An observation made in the brain itself (e.g. the swarm listener's `speech.fillers` bursts), added
   *  to a run's record like a coach.observation. Accepted while the run is live and up to `lateMs` after
   *  it ended (the listener reports a phrase ~2 s after it was said). Returns false when not recorded. */
  addObservation(runId: RunId, o: Observation, lateMs = 10_000): boolean {
    const rec = this.runs.get(runId);
    if (!rec) return false;
    if (rec.endedAt !== null && this.o.clock.now() - rec.endedAt > lateMs) return false;
    rec.observations.push({ ...o });
    this.changed();
    return true;
  }

  recordQa(runId: RunId, turn: QaTurnRecord): void {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.qa.push(turn);
    this.changed();
  }

  private changed(): void { for (const fn of this.changedFns) fn(); }

  /** `behavior` start/end from the sensor role. Starts only during a run's presentation or Q&A; an end
   *  closes the latest open episode of that kind (it may arrive just after the run ended). */
  private onBehavior(p: Uplink<"behavior">["payload"]): void {
    const now = this.o.clock.now();
    if (p.phase === "start") {
      const rec = this.live();
      if (!rec || rec.episodes.some((e) => e.kind === p.kind && e.endAt === null)) return;
      const at = this.plausible(p.clientTs, rec, now);
      rec.episodes.push({ kind: p.kind, startAt: at, endAt: null, slideIndex: slideAt(rec, at),
        segment: rec.qaStartedAt !== null && at >= rec.qaStartedAt ? "qa" : "presentation", conf: p.conf });
    } else {
      const rec = this.latest();
      const open = rec?.episodes.findLast((e) => e.kind === p.kind && e.endAt === null);
      if (!rec || !open) return;
      open.endAt = Math.max(open.startAt, Math.min(this.plausible(p.clientTs, rec, now), rec.endedAt ?? now));
    }
    this.changed();
  }

  /** The sender's time when it fits this run (same machine, synced clocks), else the arrival time. */
  private plausible(ts: number, rec: RunRecord, now: number): number {
    const from = (rec.run.presentationStartedAt ?? rec.run.startedAt ?? now) - 5_000;
    return Number.isFinite(ts) && ts >= from && ts <= now + 2_000 ? Math.min(ts, now) : now;
  }

  /** After a restore the session aborted the run that was under way; close its record the same way. */
  private syncRestored(): void {
    const run = this.o.session.get().run;
    const rec = run ? this.runs.get(run.runId) : undefined;
    if (!run || !rec) return;
    rec.run = structuredClone(run);
    if ((run.phase === "ended" || run.phase === "aborted") && rec.endedAt === null) {
      rec.endedAt = run.endedAt ?? this.o.clock.now();
      rec.endedBy = run.phase === "aborted" ? "aborted" : null;
    }
  }

  private onChange(run: RunState | null, cause: SessionCause): void {
    if (!Array.isArray(cause) && cause.type === "reset") {   // a new session: run ids start again at run_1
      this.runs.clear();
      this.changed();
      return;
    }
    if (!run) return;
    const now = this.o.clock.now();
    let rec = this.runs.get(run.runId);
    if (!rec) {
      rec = { runId: run.runId, run: structuredClone(run), slides: [], observations: [], episodes: [], feedback: [], wakes: 0, qa: [],
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
      for (const e of rec.episodes) if (e.endAt === null) e.endAt = Math.max(e.startAt, rec.endedAt);   // still open at the end
      const coach = this.o.session.get().coach;
      rec.coachAfter = run.phase === "ended" ? { score: coach.score, stage: coach.stage } : null;
      for (const fn of this.endedFns) fn(rec);
    }
    this.changed();
  }
}

/** The slide on screen at `at` (slide changes are logged from the presentation start). */
function slideAt(rec: RunRecord, at: number): number {
  let index = rec.slides[0]?.index ?? rec.run.slideIndex;
  for (const s of rec.slides) if (s.at <= at) index = s.index;
  return index;
}
