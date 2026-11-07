/**
 * Narrow ports the JJ engine and the coach tools depend on. Each is a subset of a
 * brain-lane / sensing-lane interface from the spec, so the real implementations
 * satisfy them structurally and tests can fake them.
 */
import type {
  ClientRole, JudgeDef, PresentationBrief, Result, RunId, SceneOp, SessionState,
} from "@coach/protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

/** Spec `Clock` (brain core). */
export interface JJClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** The SessionAction union lives in the brain lane; we only need its `type` tag here. */
export type SessionActionLike = { type: string; [k: string]: unknown };

/** Spec `SessionStore` (brain core). */
export interface SessionPort {
  get(): Readonly<SessionState>;
  dispatch(a: SessionActionLike): Result;
  applyScene(ops: SceneOp[]): Promise<Result<{ version: number }>>;
  subscribe(fn: (s: SessionState, cause: SessionActionLike | SceneOp[]) => void): () => void;
}

/** Downlink messages the JJ engine emits. Matches the spec's message catalogue payloads. */
export type JJDownlink =
  | { type: "jj.state"; payload: { connected: boolean; listening: boolean; speaking: boolean } }
  | { type: "actor.say"; payload: { actorId: "jj"; utteranceId: string; source: 0; text: string } }
  | { type: "audio.stop"; payload: { source: number; utteranceId?: string } }
  | { type: "report.focus"; payload: { kind: string | null } }
  | { type: "hud.toast"; payload: { text: string; level: "info" | "warn" } };

/** Spec `Hub` (brain core). The hub wraps payloads in the envelope. */
export interface HubPort {
  send(role: ClientRole, msg: JJDownlink): boolean;
  broadcast(roles: ClientRole[], msg: JJDownlink): void;
  sendAudio(source: number, flags: number, seq: number, pcm24k: Int16Array): void;
}

/** Spec `MicRouter` (sensing). The router calls `JJEngine.acceptMic` for frames routed to jj. */
export interface MicPort {
  sinks(): ("stt" | "jj")[];
  replaySince(t: number): Int16Array;
}

/** Spec `ContextService` (agents). */
export interface ContextPort {
  setBrief(b: PresentationBrief): Promise<void>;
  generatePersonas(n: number, instruction?: string): Promise<{
    judges: Pick<JudgeDef, "title" | "background" | "style" | "toughness" | "priorities">[];
    audienceCount: number;
  }>;
}

/** Reports lane: compact RunReport (patterns, target progress, recommendation, score). */
export interface ReportsPort {
  compactRunReport(runId: RunId): unknown | null;
}

/** P1 gaze calibration flow; optional. */
export interface CalibrationPort {
  run(): Promise<Result>;
}
