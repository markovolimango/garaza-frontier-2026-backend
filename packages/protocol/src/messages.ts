/**
 * Message catalogue (spec: "Message catalogue"). This is the complete list: nothing else
 * crosses /ws/control. Every control frame is one JSON envelope.
 */
import { z } from "zod";
import {
  BehaviorKind, ClientRole, Deck, ErrorCode, FeedbackCategory, FeedbackCommand, Gesture, JJState, JudgeId,
  LookTarget, OrbState, PROTOCOL_VERSION, RunId, RunState, SceneDef, SceneOp, SessionId, SessionPhase,
  SessionState, StageView, ToolResult,
} from "./domain.ts";
import { ToolName } from "./tools.ts";
import { VenueDef } from "./venue.ts";

// ---------------- envelope ----------------
export const EnvelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.string().min(1),
  id: z.string().min(1),
  ts: z.number(),
  replyTo: z.string().optional(),
  payload: z.unknown(),
});
export type Envelope<T extends string = string, P = unknown> = { v: 1; type: T; id: string; ts: number; replyTo?: string; payload: P };

// ---------------- downlink payloads (brain → clients) ----------------
export const DOWNLINK = {
  welcome: z.object({ sessionId: SessionId, serverTime: z.number(), protocol: z.literal(PROTOCOL_VERSION) }),
  error: z.object({ code: ErrorCode, message: z.string(), refId: z.string().optional() }),
  ping: z.object({}),
  "state.snapshot": z.object({
    session: SessionState,
    connections: z.record(ClientRole, z.boolean()),
    jj: JJState,
    feedback: FeedbackCommand,
  }),
  "ui.state": z.object({ view: StageView, orb: OrbState, introDone: z.boolean() }),
  "scene.sync": z.object({ scene: SceneDef, venue: VenueDef, deck: Deck.nullable() }),
  "scene.apply": z.object({ batchId: z.string().min(1), version: z.number().int(), ops: z.array(SceneOp).min(1) }),
  "run.state": z.object({ run: RunState.nullable(), sessionPhase: SessionPhase }),
  "feedback.set": FeedbackCommand,
  "slide.show": z.object({ index: z.number().int().min(0) }),
  countdown: z.object({ secondsLeft: z.union([z.literal(3), z.literal(2), z.literal(1), z.literal(0)]) }),
  "actor.say": z.object({ actorId: z.union([JudgeId, z.literal("jj")]), utteranceId: z.string().min(1), source: z.number().int().min(0).max(9), text: z.string() }),
  "actor.gesture": z.object({ actorId: z.union([JudgeId, z.literal("audience")]), gesture: Gesture, durationMs: z.number().int().positive().optional() }),
  "actor.lookAt": z.object({ actorId: JudgeId, target: LookTarget }),
  "audio.stop": z.object({ source: z.number().int().min(0).max(9), utteranceId: z.string().optional() }),
  "jj.state": JJState,
  "report.ready": z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run"), runId: RunId }),
    z.object({ kind: z.literal("final"), sessionId: SessionId }),
  ]),
  "report.focus": z.object({ kind: BehaviorKind.nullable() }),
  "calibrate.prompt": z.object({ judgeId: JudgeId.nullable() }),
  "sensor.config": z.object({ enabledCategories: z.array(FeedbackCategory), neutralPitchDeg: z.number().nullable(), debug: z.boolean() }),
  "hud.toast": z.object({ text: z.string().min(1).max(120), level: z.enum(["info", "warn"]) }),
  "tool.result": ToolResult,
} as const;

// ---------------- uplink payloads (clients → brain) ----------------
export const SENSOR_BEHAVIORS = ["arms_crossed", "sway", "face_touch", "looking_down"] as const;

export const UPLINK = {
  hello: z.object({ role: ClientRole, clientId: z.string().min(1), protocol: z.literal(PROTOCOL_VERSION) }),
  pong: z.object({}),
  ack: z.union([
    z.object({ batchId: z.string().min(1), version: z.number().int(), ok: z.literal(true) }),
    z.object({ batchId: z.string().min(1), ok: z.literal(false), error: z.string() }),
  ]),
  "session.start": z.object({}),
  "slide.changed": z.object({ index: z.number().int().min(0), clientTs: z.number() }),
  "presentation.done": z.object({}),
  ptt: z.object({ down: z.boolean() }),
  "audio.playback": z.object({ source: z.number().int().min(0).max(9), utteranceId: z.string().min(1), state: z.enum(["started", "ended", "stopped"]) }),
  "tool.invoke": z.object({ tool: ToolName, args: z.unknown() }),
  "operator.override": z.discriminatedUnion("action", [
    z.object({ action: z.literal("vignette"), kind: z.enum(["warn", "reward"]), intensity: z.number().min(0).max(1), holdMs: z.number().int().positive() }),
    z.object({ action: z.literal("wake") }),
    z.object({ action: z.literal("jj_reconnect") }),
    z.object({ action: z.literal("replay"), file: z.string().min(1), speed: z.number().positive() }),
  ]),
  behavior: z.object({ kind: z.enum(SENSOR_BEHAVIORS), phase: z.enum(["start", "end"]), clientTs: z.number(), conf: z.number().min(0).max(1) }),
  "gaze.sample": z.object({ yawDeg: z.number(), pitchDeg: z.number(), clientTs: z.number(), facePresent: z.boolean() }),
  "sensor.status": z.object({ camera: z.enum(["ok", "no_person", "error"]), fps: z.number().min(0), posePresent: z.boolean(), message: z.string().optional() }),
  "sensor.debug": z.object({ clientTs: z.number(), landmarks: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])), aspect: z.number().positive() }),
} as const;

/** Which roles may send each uplink type (spec table "From → to"). */
export const UPLINK_SENDERS: { [K in UplinkType]: readonly ClientRole[] } = {
  hello: ["stage", "sensor", "operator"],
  pong: ["stage", "sensor", "operator"],
  ack: ["stage"],
  "session.start": ["stage"],
  "slide.changed": ["stage"],
  "presentation.done": ["stage"],
  ptt: ["stage"],
  "audio.playback": ["stage"],
  "tool.invoke": ["stage", "operator"],
  "operator.override": ["operator"],
  behavior: ["sensor"],
  "gaze.sample": ["sensor"],
  "sensor.status": ["sensor"],
  "sensor.debug": ["sensor"],
};

// ---------------- types ----------------
export type DownlinkType = keyof typeof DOWNLINK;
export type UplinkType = keyof typeof UPLINK;
export type DownlinkPayload<T extends DownlinkType> = z.infer<(typeof DOWNLINK)[T]>;
export type UplinkPayload<T extends UplinkType> = z.infer<(typeof UPLINK)[T]>;

/** What brain code hands to Hub.send(); the hub adds v, id and ts. */
export type DownlinkMessage = { [K in DownlinkType]: { type: K; payload: DownlinkPayload<K>; replyTo?: string } }[DownlinkType];
export type Downlink<T extends DownlinkType> = Extract<DownlinkMessage, { type: T }>;
/** A validated inbound envelope; `ts` is re-stamped with the brain clock on receipt. */
export type UplinkMessage = { [K in UplinkType]: Envelope<K, UplinkPayload<K>> }[UplinkType];
export type Uplink<T extends UplinkType> = Extract<UplinkMessage, { type: T }>;
export type DownlinkEnvelope = { [K in DownlinkType]: Envelope<K, DownlinkPayload<K>> }[DownlinkType];

export const ALL_DOWNLINK_TYPES = Object.keys(DOWNLINK) as DownlinkType[];
export const ALL_UPLINK_TYPES = Object.keys(UPLINK) as UplinkType[];

// ---------------- parsing ----------------
export type ParseResult<M> = { ok: true; msg: M } | { ok: false; code: "invalid_message" | "protocol_mismatch"; message: string; refId?: string };

function parseWith<M>(table: Record<string, z.ZodType>, raw: unknown): ParseResult<M> {
  let data = raw;
  if (typeof raw === "string") {
    try { data = JSON.parse(raw); } catch { return { ok: false, code: "invalid_message", message: "not JSON" }; }
  }
  const refId = typeof (data as { id?: unknown })?.id === "string" ? (data as { id: string }).id : undefined;
  const fail = (code: "invalid_message" | "protocol_mismatch", message: string): ParseResult<M> => ({ ok: false, code, message, ...(refId ? { refId } : {}) });
  if (data && typeof data === "object" && "v" in data && (data as { v: unknown }).v !== PROTOCOL_VERSION) {
    return fail("protocol_mismatch", `protocol ${String((data as { v: unknown }).v)} not supported (brain speaks ${PROTOCOL_VERSION})`);
  }
  const env = EnvelopeBase.safeParse(data);
  if (!env.success) return fail("invalid_message", `bad envelope: ${z.prettifyError(env.error)}`);
  const schema = table[env.data.type];
  if (!schema) return fail("invalid_message", `unknown type "${env.data.type}"`);
  const payload = schema.safeParse(env.data.payload);
  if (!payload.success) return fail("invalid_message", `${env.data.type}: ${z.prettifyError(payload.error)}`);
  return { ok: true, msg: { ...env.data, payload: payload.data } as M };
}

export const parseUplink = (raw: unknown): ParseResult<UplinkMessage> => parseWith<UplinkMessage>(UPLINK, raw);
export const parseDownlink = (raw: unknown): ParseResult<DownlinkEnvelope> => parseWith<DownlinkEnvelope>(DOWNLINK, raw);

export function envelope<T extends string, P>(type: T, payload: P, id: string, ts: number, replyTo?: string): Envelope<T, P> {
  return { v: PROTOCOL_VERSION, type, id, ts, ...(replyTo ? { replyTo } : {}), payload };
}

// ---------------- WS endpoints and close codes ----------------
export const WS_PATHS = { control: "/ws/control", mic: "/ws/mic", audio: "/ws/audio" } as const;
export const CLOSE_CODES = { replaced: 4001, protocolMismatch: 4002, helloTimeout: 4003, dead: 4004 } as const;
export const PING_INTERVAL_MS = 5000;
export const DEAD_AFTER_MS = 15_000;
export const MicHello = z.object({ type: z.literal("mic.hello"), sampleRate: z.literal(16000) });
