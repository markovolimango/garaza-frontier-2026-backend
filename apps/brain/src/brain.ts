/**
 * createBrain(): composes the brain from its components. This file is the single place
 * where lanes plug in: every collaborator is an option with a placeholder default, so a
 * lane merges by passing its real implementation here (see docs/integration.md).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GREYBOX_VENUE, type ClientRole, type FeedbackCategory, type SceneDef, type SessionState, type ToolResult, type VenueDef,
} from "@coach/protocol";
import { RealClock, type Clock } from "./clock.ts";
import { WsHub } from "./hub.ts";
import { createJJ, type JJConfig } from "./jj/index.ts";
import type { ContextPort, ReportsPort } from "./jj/ports.ts";
import type { ToolCaller, ToolRegistry } from "./jj/tools.ts";
import type { VoiceAgent } from "./jj/voice-agent.ts";
import type { Logger } from "./log.ts";
import { MicRouter } from "./mic.ts";
import { placeholderCoach, placeholderContext, placeholderReports } from "./placeholders.ts";
import { SessionStore, type CoachPolicy } from "./session.ts";
import type { SttStream } from "./speech.ts";
import { StateSync } from "./sync.ts";
import { Uploads } from "./context/uploads.ts";

export interface BrainOptions {
  jj: JJConfig;
  clock?: Clock;
  log?: Logger;
  venue?: VenueDef;
  initialScene?: SceneDef;
  enabledCategories?: FeedbackCategory[];
  // ---- extension points (placeholders until the owning lane merges) ----
  coach?: CoachPolicy;                 // packages/rules: coach policy + summarizeRun
  context?: ContextPort;               // agents: digest + personas (LLM)
  reports?: ReportsPort;               // rules/report: compact RunReport for JJ
  agent?: VoiceAgent;                  // FakeVoiceAgent for tests / voice-less demos
  stt?: () => SttStream | null;        // sensing: the current run's STT stream
  /** Extra HTTP routes (reports …). Return true when handled. */
  http?: (req: IncomingMessage, res: ServerResponse, brain: Brain) => boolean | Promise<boolean>;
  /** Where uploads and session logs go (SESSION_DIR). Default ./data/sessions. */
  sessionDir?: string;
  /** Extra allowed CORS origins; localhost / 127.0.0.1 on any port are always allowed. */
  corsOrigins?: string[];
  /** A session saved before a restart (persist.ts `loadLatest`): the brain continues it. */
  restore?: SessionState;
}

export interface Brain {
  server: Server;
  hub: WsHub;
  session: SessionStore;
  sync: StateSync;
  tools: ToolRegistry;
  jj: ReturnType<typeof createJJ>["engine"];
  mic: MicRouter;
  uploads: Uploads;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function defaultScene(voices: string[]): SceneDef {
  const seat = (n: 1 | 2 | 3 | 4, title: string, toughness: number, style: "warm" | "neutral" | "skeptical") => ({
    id: `judge_${n}` as const, title, background: "Default panel until the brief is given.", seat: `judge_seat_${n}`,
    voiceId: voices[n - 1] ?? voices[0] ?? "default", toughness, style, priorities: [] as string[],
  });
  return {
    version: 1, venueId: "greybox", qa: { questions: 3, answerCapMs: 45_000 },
    // A startup pitch panel (Garaža Frontier is judged on startup potential) until the brief is given.
    judges: [seat(1, "Customer advocate", 0.3, "warm"), seat(2, "Startup mentor", 0.5, "neutral"), seat(3, "VC investor", 0.8, "skeptical"), seat(4, "Technical expert", 0.6, "neutral")],
    audience: { count: 12 }, lighting: "default",
  };
}

export function createBrain(o: BrainOptions): Brain {
  const clock = o.clock ?? new RealClock();
  const log = o.log ?? (() => {});
  const venue = o.venue ?? GREYBOX_VENUE;

  // Session and hub reference each other only through closures.
  let session!: SessionStore;
  const hub = new WsHub({ clock, log, sessionId: () => session.get().sessionId });
  session = new SessionStore({
    clock, log, venue, coach: o.coach ?? placeholderCoach,
    initialScene: o.initialScene ?? defaultScene(o.jj.JUDGE_VOICES),
    ...(o.enabledCategories ? { enabledCategories: o.enabledCategories } : {}),
    ...(o.restore ? { restore: o.restore } : {}),
    stage: { isConnected: () => hub.isConnected("stage"), send: (m) => hub.send("stage", m) },
  });

  let micRef: MicRouter | null = null;
  const jjParts = createJJ({
    config: o.jj, session, hub, clock, log,
    context: o.context ?? placeholderContext(),
    reports: o.reports ?? placeholderReports,
    mic: { sinks: () => micRef!.sinks(), replaySince: (t) => micRef!.replaySince(t) },
    ...(o.agent ? { agent: o.agent } : {}),
  });
  const mic = new MicRouter({ clock, session, jj: jjParts.engine, ...(o.stt ? { stt: o.stt } : {}) });
  micRef = mic;
  const { engine: jj, tools } = jjParts;
  const sync = new StateSync({ hub, session, clock, jjStatus: () => jj.status() });
  hub.onOutbound((m) => { if (m.type === "jj.state") sync.jjChanged(); });

  // ---------------- uplinks ----------------
  const refuse = (role: ClientRole, refId: string, r: { ok: false; reason: string; hint?: string }) =>
    hub.send(role, { type: "error", replyTo: refId, payload: { code: r.reason as never, message: r.hint ?? r.reason, refId } });
  const act = (role: ClientRole, refId: string, a: Parameters<SessionStore["dispatch"]>[0]) => {
    const r = session.dispatch(a);
    if (!r.ok) refuse(role, refId, r);
  };

  hub.on("ack", (m) => session.commands.onAck(m.payload));
  hub.on("session.start", (m, role) => act(role, m.id, { type: "session_start" }));
  hub.on("slide.changed", (m, role) => act(role, m.id, { type: "slide", index: m.payload.index, from: "stage" }));
  hub.on("presentation.done", (m, role) => act(role, m.id, { type: "presentation_done" }));
  hub.on("ptt", (m, role) => { if (m.payload.down) act(role, m.id, { type: "wake", via: "ptt" }); });
  hub.on("tool.invoke", (m, role) => {
    void tools.invoke(m.payload.tool, m.payload.args, role as ToolCaller).then((result: ToolResult) => {
      hub.send(role, { type: "tool.result", replyTo: m.id, payload: result });
    });
  });
  hub.on("operator.override", (m, role) => {
    const p = m.payload;
    switch (p.action) {
      case "wake": act(role, m.id, { type: "wake", via: "operator" }); break;
      case "jj_reconnect": void jj.reconnect(); break;
      case "vignette": sync.forceVignette(p.kind, p.intensity, p.holdMs); break;
      case "replay": refuse(role, m.id, { ok: false, reason: "not_available", hint: "replay lands with build step 11" }); break;
    }
  });
  hub.onMic((pcm) => mic.write(pcm));

  // ---------------- http ----------------
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const uploads = new Uploads({ session, sessionDir: o.sessionDir ?? "./data/sessions", log });
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const allowOrigin = (origin: string | undefined) => !!origin && (localOrigin.test(origin) || (o.corsOrigins ?? []).includes(origin));
  const brain: Brain = {
    server: createServer(), hub, session, sync, tools, jj, mic, uploads,
    listen: (port, host = "127.0.0.1") => new Promise((resolve) => brain.server.listen(port, host, () => resolve((brain.server.address() as AddressInfo).port))),
    close: async () => { await jj.stop().catch(() => {}); hub.close(); await new Promise<void>((r) => brain.server.close(() => r())); },
  };
  brain.server.on("request", async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const origin = req.headers.origin;
    if (allowOrigin(origin)) {
      res.setHeader("access-control-allow-origin", origin!);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
    }
    if (req.method === "OPTIONS") { res.writeHead(allowOrigin(origin) ? 204 : 403); res.end(); return; }
    try {
      if (o.http && (await o.http(req, res, brain))) return;
      if (await uploads.handle(req, res)) return;
      if (path === "/health") {
        const c = hub.connections();
        json(res, 200, { ok: true, connected: (Object.keys(c) as ClientRole[]).filter((r) => c[r]), mic: hub.micConnected(), jj: jj.status().connected ? "connected" : "down", phase: session.get().phase });
        return;
      }
      if (path === "/api/tools") { json(res, 200, tools.catalogue()); return; }
      if (path.startsWith("/api/")) { json(res, 501, { ok: false, reason: "not_available", hint: `${path} is not implemented yet` }); return; }
      json(res, 404, { ok: false, reason: "not_available" });
    } catch (err) {
      log("error", "http.failed", { path, err: String(err) });
      json(res, 500, { ok: false, reason: "internal" });
    }
  });
  hub.attach(brain.server);
  jj.start();
  return brain;
}
