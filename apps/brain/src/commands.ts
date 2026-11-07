/**
 * Scene commands (spec: "Brain core" → applyScene). A scene change is committed only after
 * the main app acknowledges it, so JJ never says "done" for something that isn't on screen.
 *
 * 1. zod + semantic validation (seats in the venue, 1–5 judges, unique ids and seats).
 * 2. stage offline → stage_offline.
 * 3. candidate = committed + ops with version + 1; logged "pending"; scene.apply sent.
 * 4. ack ok within 2000 ms → commit, "acked", subscribers notified.
 * 5. timeout / ack not ok → "failed", scene.sync with the last committed scene (rollback).
 * 6. one batch in flight; the rest queue.
 */
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  SceneOp, type DownlinkMessage, type JudgeDef, type Result, type SceneDef, type SceneOp as SceneOpT, type UplinkPayload, type VenueDef,
} from "@coach/protocol";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";

export interface StageLink {
  isConnected(): boolean;
  send(msg: DownlinkMessage): boolean;
}

export interface CommandLogEntry {
  batchId: string; version: number; ops: SceneOpT[];
  status: "pending" | "acked" | "failed";
  t: number; error?: string;
}

export interface SceneCommanderOptions {
  clock: Clock;
  venue: () => VenueDef;
  stage: StageLink;
  /** Committed scene and a setter that commits + notifies (owned by the session store). */
  getScene: () => SceneDef;
  commit: (scene: SceneDef, ops: SceneOpT[]) => void;
  /** Extra phase rule, e.g. judges.set refused during Q&A. Return an error to refuse. */
  guard?: (ops: SceneOpT[]) => Result | null;
  /** Full scene.sync payload builder (scene + venue + deck) for rollbacks. */
  syncMessage: (scene: SceneDef) => DownlinkMessage;
  ackTimeoutMs?: number;
  log?: Logger;
  newBatchId?: () => string;
}

const OpsSchema = z.array(SceneOp).min(1);

interface Job { ops: SceneOpT[]; resolve: (r: Result<{ version: number }>) => void }

export class SceneCommander {
  private readonly queue: Job[] = [];
  private inFlight: { entry: CommandLogEntry; candidate: SceneDef; job: Job; timer: unknown } | null = null;
  readonly log: CommandLogEntry[] = [];
  private readonly logger: Logger;

  constructor(private readonly o: SceneCommanderOptions) {
    this.logger = o.log ?? (() => {});
  }

  apply(ops: SceneOpT[]): Promise<Result<{ version: number }>> {
    return new Promise((resolve) => {
      this.queue.push({ ops, resolve });
      this.pump();
    });
  }

  /** Hub "ack" from the main app. */
  onAck(a: UplinkPayload<"ack">): void {
    const f = this.inFlight;
    if (!f || a.batchId !== f.entry.batchId) { this.logger("warn", "scene.ack_unmatched", { batchId: a.batchId }); return; }
    if (a.ok && a.version !== f.entry.version) { this.logger("warn", "scene.ack_wrong_version", { got: a.version, want: f.entry.version }); return; }
    this.o.clock.clearTimeout(f.timer);
    this.inFlight = null;
    if (a.ok) {
      f.entry.status = "acked";
      this.o.commit(f.candidate, f.entry.ops);
      f.job.resolve({ ok: true, version: f.entry.version });
    } else {
      this.fail(f.entry, a.error);
      f.job.resolve({ ok: false, reason: "invalid_args", hint: `the main screen rejected it: ${a.error}` });
    }
    this.pump();
  }

  pendingCount(): number { return this.queue.length + (this.inFlight ? 1 : 0); }

  private pump(): void {
    if (this.inFlight) return;
    const job = this.queue.shift();
    if (!job) return;

    const parsed = OpsSchema.safeParse(job.ops);
    if (!parsed.success) { job.resolve({ ok: false, reason: "invalid_args", hint: z.prettifyError(parsed.error) }); this.pump(); return; }
    const ops = parsed.data;
    const guard = this.o.guard?.(ops);
    if (guard && !guard.ok) { job.resolve(guard); this.pump(); return; }

    const current = this.o.getScene();
    const built = buildCandidate(current, ops, this.o.venue());
    if ("error" in built) { job.resolve({ ok: false, reason: built.reason, hint: built.error }); this.pump(); return; }
    if (!this.o.stage.isConnected()) { job.resolve({ ok: false, reason: "stage_offline", hint: "the main screen is not connected" }); this.pump(); return; }

    const version = current.version + 1;
    const candidate = { ...built.scene, version };
    const entry: CommandLogEntry = { batchId: (this.o.newBatchId ?? (() => `b_${nanoid(8)}`))(), version, ops, status: "pending", t: this.o.clock.now() };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    if (!this.o.stage.send({ type: "scene.apply", payload: { batchId: entry.batchId, version, ops } })) {
      entry.status = "failed"; entry.error = "send failed";
      job.resolve({ ok: false, reason: "stage_offline", hint: "the main screen is not connected" });
      this.pump();
      return;
    }
    const timer = this.o.clock.setTimeout(() => {
      if (this.inFlight?.entry !== entry) return;
      this.inFlight = null;
      this.fail(entry, "ack timeout");
      job.resolve({ ok: false, reason: "stage_timeout", hint: "the main screen did not confirm the change in time" });
      this.pump();
    }, this.o.ackTimeoutMs ?? 2000);
    this.inFlight = { entry, candidate, job, timer };
  }

  private fail(entry: CommandLogEntry, error: string): void {
    entry.status = "failed";
    entry.error = error;
    this.logger("warn", "scene.batch_failed", { batchId: entry.batchId, error });
    this.o.stage.send(this.o.syncMessage(this.o.getScene()));   // rollback to the last committed scene
  }
}

/** Pure: applies ops to a copy of the scene and checks semantics against the venue. */
export function buildCandidate(scene: SceneDef, ops: SceneOpT[], venue: VenueDef):
  { scene: SceneDef } | { error: string; reason: "invalid_args" | "not_available" } {
  const next: SceneDef = structuredClone(scene);
  for (const op of ops) {
    switch (op.op) {
      case "judges.set": next.judges = structuredClone(op.judges); break;
      case "judge.update": {
        const j = next.judges.find((x) => x.id === op.id);
        if (!j) return { error: `no ${op.id} on the panel (${next.judges.map((x) => x.id).join(", ")})`, reason: "invalid_args" };
        Object.assign(j, op.patch);
        break;
      }
      case "audience.set": next.audience = { count: op.count }; break;
      case "lighting.set": next.lighting = op.preset; break;
      case "qa.set": next.qa = { ...op.qa }; break;
      case "venue.set":
        if (op.venueId !== venue.id) return { error: `venue ${op.venueId} is not loaded (P2)`, reason: "not_available" };
        next.venueId = op.venueId;
        break;
    }
  }
  const err = checkJudges(next.judges, venue);
  return err ? { error: err, reason: "invalid_args" } : { scene: next };
}

export function checkJudges(judges: JudgeDef[], venue: VenueDef): string | null {
  if (judges.length < 1 || judges.length > 5) return `the panel needs 1-5 judges, got ${judges.length}`;
  const ids = new Set<string>(), seats = new Set<string>();
  for (const j of judges) {
    if (ids.has(j.id)) return `duplicate judge id ${j.id}`;
    if (seats.has(j.seat)) return `two judges on ${j.seat}`;
    const a = venue.anchors[j.seat];
    if (!a || a.kind !== "point") return `venue ${venue.id} has no seat ${j.seat}`;
    if (j.toughness < 0 || j.toughness > 1) return `toughness of ${j.id} must be 0-1`;
    ids.add(j.id); seats.add(j.seat);
  }
  return null;
}
