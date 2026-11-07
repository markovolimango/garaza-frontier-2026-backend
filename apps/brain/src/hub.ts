/**
 * Hub: the brain's three WebSocket endpoints (spec: "Transport").
 *
 *   /ws/control  JSON envelopes, all roles. hello → welcome → role's initial state.
 *   /ws/mic      stage → brain: text {"type":"mic.hello","sampleRate":16000}, then 20 ms Int16 frames.
 *   /ws/audio    brain → stage: 4-byte header + 24 kHz Int16 PCM.
 *
 * One connection per role: a second one replaces the first (old socket closed with 4001).
 * Brain pings every 5 s; 15 s without any frame marks the client dead. Every inbound
 * message is validated (schema + allowed sender) and re-stamped with the brain clock;
 * nothing invalid reaches a handler.
 */
import type { IncomingMessage, Server } from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  CLOSE_CODES, DEAD_AFTER_MS, MicHello, PING_INTERVAL_MS, PROTOCOL_VERSION, UPLINK_SENDERS, WS_PATHS,
  encodeAudioFrame, envelope, micFrameToPcm, parseUplink,
  type ClientRole, type DownlinkMessage, type ErrorCode, type Uplink, type UplinkMessage, type UplinkType,
} from "@coach/protocol";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";

export interface Hub {
  send(role: ClientRole, msg: DownlinkMessage): boolean;
  broadcast(roles: ClientRole[], msg: DownlinkMessage): void;
  sendAudio(source: number, flags: number, seq: number, pcm24k: Int16Array): void;
  on<T extends UplinkType>(type: T, handler: (msg: Uplink<T>, role: ClientRole) => void): void;
  isConnected(role: ClientRole): boolean;
  onConnect(role: ClientRole, fn: () => void): void;
}

export interface HubOptions {
  clock: Clock;
  sessionId: () => string;
  log?: Logger;
  helloTimeoutMs?: number;     // default 5000
  newId?: () => string;
}

interface Conn { ws: WebSocket; role: ClientRole; clientId: string; lastSeen: number }
const ROLES: ClientRole[] = ["stage", "sensor", "operator"];

export class WsHub implements Hub {
  private readonly conns = new Map<ClientRole, Conn>();
  private readonly handlers = new Map<UplinkType, ((msg: never, role: ClientRole) => void)[]>();
  private readonly connectFns = new Map<ClientRole, (() => void)[]>();
  private readonly disconnectFns: ((role: ClientRole) => void)[] = [];
  private readonly micFns: ((pcm: Int16Array) => void)[] = [];
  private readonly inboundFns: ((msg: UplinkMessage, role: ClientRole) => void)[] = [];
  private readonly outboundFns: ((msg: DownlinkMessage, roles: ClientRole[]) => void)[] = [];
  private mic: WebSocket | null = null;
  private audio: WebSocket | null = null;
  private pingTimer: unknown = null;
  private readonly wss = { control: new WebSocketServer({ noServer: true }), mic: new WebSocketServer({ noServer: true }), audio: new WebSocketServer({ noServer: true }) };
  private readonly log: Logger;
  private readonly newId: () => string;

  constructor(private readonly o: HubOptions) {
    this.log = o.log ?? (() => {});
    this.newId = o.newId ?? (() => nanoid());
    this.wss.control.on("connection", (ws) => this.onControl(ws));
    this.wss.mic.on("connection", (ws) => this.onMicSocket(ws));
    this.wss.audio.on("connection", (ws) => this.onAudioSocket(ws));
    this.schedulePing();
  }

  /** Routes HTTP upgrades for the three WS paths; other paths are left alone (e.g. Vite HMR). */
  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      const target = path === WS_PATHS.control ? this.wss.control : path === WS_PATHS.mic ? this.wss.mic : path === WS_PATHS.audio ? this.wss.audio : null;
      if (!target) return;
      target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    });
  }

  // ---------------- Hub ----------------

  send(role: ClientRole, msg: DownlinkMessage): boolean {
    const c = this.conns.get(role);
    if (!c || c.ws.readyState !== c.ws.OPEN) return false;
    this.write(c.ws, msg);
    for (const fn of this.outboundFns) fn(msg, [role]);
    return true;
  }

  broadcast(roles: ClientRole[], msg: DownlinkMessage): void {
    const sent: ClientRole[] = [];
    for (const r of roles) {
      const c = this.conns.get(r);
      if (c && c.ws.readyState === c.ws.OPEN) { this.write(c.ws, msg); sent.push(r); }
    }
    if (sent.length) for (const fn of this.outboundFns) fn(msg, sent);
  }

  sendAudio(source: number, flags: number, seq: number, pcm24k: Int16Array): void {
    const a = this.audio;
    if (!a || a.readyState !== a.OPEN) return;
    a.send(encodeAudioFrame(source, flags, seq, pcm24k));
  }

  on<T extends UplinkType>(type: T, handler: (msg: Uplink<T>, role: ClientRole) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (msg: never, role: ClientRole) => void);
    this.handlers.set(type, list);
  }

  isConnected(role: ClientRole): boolean { return this.conns.has(role); }
  connections(): Record<ClientRole, boolean> { return { stage: this.conns.has("stage"), sensor: this.conns.has("sensor"), operator: this.conns.has("operator") }; }
  onConnect(role: ClientRole, fn: () => void): void { const l = this.connectFns.get(role) ?? []; l.push(fn); this.connectFns.set(role, l); }
  onDisconnect(fn: (role: ClientRole) => void): void { this.disconnectFns.push(fn); }
  onMic(fn: (pcm16k: Int16Array) => void): void { this.micFns.push(fn); }
  /** Recorder taps: every validated inbound message and every sent downlink. */
  onInbound(fn: (msg: UplinkMessage, role: ClientRole) => void): void { this.inboundFns.push(fn); }
  onOutbound(fn: (msg: DownlinkMessage, roles: ClientRole[]) => void): void { this.outboundFns.push(fn); }
  micConnected(): boolean { return this.mic !== null; }

  close(): void {
    if (this.pingTimer) this.o.clock.clearTimeout(this.pingTimer);
    this.pingTimer = null;
    for (const c of this.conns.values()) c.ws.close(1001, "brain shutting down");
    this.mic?.close(1001); this.audio?.close(1001);
    for (const w of Object.values(this.wss)) w.close();
  }

  // ---------------- control ----------------

  private write(ws: WebSocket, msg: DownlinkMessage): void {
    ws.send(JSON.stringify(envelope(msg.type, msg.payload, this.newId(), this.o.clock.now(), msg.replyTo)));
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string, refId?: string): void {
    this.write(ws, { type: "error", ...(refId ? { replyTo: refId } : {}), payload: { code, message, ...(refId ? { refId } : {}) } });
  }

  private onControl(ws: WebSocket): void {
    let conn: Conn | null = null;
    const helloTimer = this.o.clock.setTimeout(() => { if (!conn) ws.close(CLOSE_CODES.helloTimeout, "no hello"); }, this.o.helloTimeoutMs ?? 5000);

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (conn) conn.lastSeen = this.o.clock.now();
      if (isBinary) { this.sendError(ws, "invalid_message", "control frames are JSON text"); return; }
      const parsed = parseUplink(String(data));
      if (!parsed.ok) {
        this.sendError(ws, parsed.code, parsed.message, parsed.refId);
        if (parsed.code === "protocol_mismatch" && !conn) ws.close(CLOSE_CODES.protocolMismatch, "protocol mismatch");
        return;
      }
      const msg = { ...parsed.msg, ts: this.o.clock.now() } as UplinkMessage;

      if (!conn) {
        if (msg.type !== "hello") { this.sendError(ws, "invalid_message", "first message must be hello", msg.id); return; }
        this.o.clock.clearTimeout(helloTimer);
        conn = this.register(ws, msg.payload.role, msg.payload.clientId);
        this.write(ws, { type: "welcome", replyTo: msg.id, payload: { sessionId: this.o.sessionId(), serverTime: this.o.clock.now(), protocol: PROTOCOL_VERSION } });
        for (const fn of this.inboundFns) fn(msg, conn.role);
        for (const fn of this.connectFns.get(conn.role) ?? []) { try { fn(); } catch (err) { this.log("error", "hub.onConnect_failed", { role: conn.role, err: String(err) }); } }
        return;
      }
      if (msg.type === "hello") { this.sendError(ws, "invalid_message", "already said hello", msg.id); return; }
      if (msg.type === "pong") return;
      if (!UPLINK_SENDERS[msg.type].includes(conn.role)) { this.sendError(ws, "invalid_message", `role ${conn.role} may not send ${msg.type}`, msg.id); return; }
      for (const fn of this.inboundFns) fn(msg, conn.role);
      for (const h of this.handlers.get(msg.type) ?? []) {
        try { (h as (m: UplinkMessage, r: ClientRole) => void)(msg, conn.role); }
        catch (err) { this.log("error", "hub.handler_failed", { type: msg.type, err: String(err) }); this.sendError(ws, "internal", "handler failed", msg.id); }
      }
    });

    ws.on("close", () => {
      this.o.clock.clearTimeout(helloTimer);
      if (conn && this.conns.get(conn.role) === conn) this.drop(conn.role, "closed");
    });
    ws.on("error", (err) => this.log("warn", "hub.socket_error", { err: String(err) }));
  }

  private register(ws: WebSocket, role: ClientRole, clientId: string): Conn {
    const old = this.conns.get(role);
    const conn: Conn = { ws, role, clientId, lastSeen: this.o.clock.now() };
    this.conns.set(role, conn);   // set before closing the old one, so its close event is ignored
    if (old) { this.log("info", "hub.replaced", { role, old: old.clientId, new: clientId }); old.ws.close(CLOSE_CODES.replaced, "replaced by a newer connection"); }
    this.log("info", "hub.connected", { role, clientId });
    return conn;
  }

  private drop(role: ClientRole, why: string): void {
    this.conns.delete(role);
    this.log("info", "hub.disconnected", { role, why });
    for (const fn of this.disconnectFns) fn(role);
  }

  private schedulePing(): void {
    this.pingTimer = this.o.clock.setTimeout(() => {
      const now = this.o.clock.now();
      for (const role of ROLES) {
        const c = this.conns.get(role);
        if (!c) continue;
        if (now - c.lastSeen >= DEAD_AFTER_MS) { this.drop(role, "dead"); c.ws.close(CLOSE_CODES.dead, "no pong for 15 s"); continue; }
        this.write(c.ws, { type: "ping", payload: {} });
      }
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  // ---------------- binary endpoints ----------------

  private onMicSocket(ws: WebSocket): void {
    let ready = false;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        let ok = false;
        try { ok = MicHello.safeParse(JSON.parse(String(data))).success; } catch { /* fallthrough */ }
        if (!ok) { ws.close(CLOSE_CODES.protocolMismatch, "expected mic.hello at 16 kHz"); return; }
        if (this.mic && this.mic !== ws) this.mic.close(CLOSE_CODES.replaced, "replaced");
        this.mic = ws;
        ready = true;
        return;
      }
      if (!ready) return;
      const buf = data as Buffer;
      const pcm = micFrameToPcm(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      for (const fn of this.micFns) fn(pcm);
    });
    ws.on("close", () => { if (this.mic === ws) this.mic = null; });
    ws.on("error", () => {});
  }

  private onAudioSocket(ws: WebSocket): void {
    if (this.audio && this.audio !== ws) this.audio.close(CLOSE_CODES.replaced, "replaced");
    this.audio = ws;
    ws.on("close", () => { if (this.audio === ws) this.audio = null; });
    ws.on("error", () => {});
  }
}
