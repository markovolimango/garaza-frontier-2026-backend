/**
 * The stage's copy of the brain's scene (Brain integration layer, pure, unit tested).
 *
 * BrainSource keeps the SceneDef from `scene.sync` and applies each `scene.apply` batch here
 * before it acks, so the judges screen always seats the panel the brain committed.
 *
 *   seat judge_seat_K (K = 1..4) → 3D seat K-1 (left to right); other seats (judge_seat_5, a
 *   venue's custom anchors) have no chair in the room, so those judges are not shown.
 */
import type { JudgeDef, JudgeId, LookTarget, SceneDef, SceneOp } from "@coach/protocol";
import type { JudgeGaze, JudgeIndex } from "../judges/types";
import type { JudgeSeat } from "../signals/judges";

/** Applies a scene.apply batch; returns the new scene (the input is not mutated). */
export function applySceneOps(scene: SceneDef, ops: readonly SceneOp[], version: number): SceneDef {
  let next: SceneDef = { ...scene, version };
  for (const op of ops) {
    switch (op.op) {
      case "judges.set": next = { ...next, judges: op.judges }; break;
      case "judge.update": {
        const patch = Object.fromEntries(Object.entries(op.patch).filter(([, v]) => v !== undefined)) as Partial<JudgeDef>;
        next = { ...next, judges: next.judges.map((j) => (j.id === op.id ? { ...j, ...patch } : j)) };
        break;
      }
      case "audience.set": next = { ...next, audience: { count: op.count } }; break;
      case "lighting.set": next = { ...next, lighting: op.preset }; break;
      case "qa.set": next = { ...next, qa: op.qa }; break;
      case "venue.set": next = { ...next, venueId: op.venueId }; break;
    }
  }
  return next;
}

/** judge_seat_K → seat index K-1 for the room's four chairs; null for any other anchor. */
export function seatIndex(seat: string): JudgeIndex | null {
  const m = /^judge_seat_([1-4])$/.exec(seat);
  return m ? ((Number(m[1]) - 1) as JudgeIndex) : null;
}

/** The judges the room can seat, left to right. */
export function panelFromScene(scene: SceneDef): JudgeSeat[] {
  const out: JudgeSeat[] = [];
  for (const j of scene.judges) {
    const seat = seatIndex(j.seat);
    if (seat !== null && !out.some((s) => s.seat === seat)) out.push({ seat, actorId: j.id, title: j.title });
  }
  return out.sort((a, b) => a.seat - b.seat);
}

/** A brain look target → the scene's gaze target; null when it names a judge who has no seat. */
export function gazeFor(target: LookTarget, seatOf: (id: JudgeId) => JudgeIndex | null): JudgeGaze | null {
  if (target === "presenter" || target === "notes" || target === "audience") return target;
  return seatOf(target);
}
