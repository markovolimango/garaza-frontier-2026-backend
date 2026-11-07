/**
 * Shared /ws/control client for every page (main app, sensor, operator).
 * Spec "Transport": sends hello on open, answers ping with pong, reconnects with backoff
 * 250 ms → 2 s (cap) and repeats the handshake, so a reload or brain restart always
 * restores full state. Downlink messages are validated in dev mode.
 */
import {
  CLOSE_CODES, PROTOCOL_VERSION, WS_PATHS, envelope, parseDownlink,
  type ClientRole, type DownlinkEnvelope, type DownlinkPayload, type DownlinkType, type UplinkPayload, type UplinkType,
} from "@coach/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed" | "replaced" | "refused";

export interface ControlClientOptions {
  role: ClientRole;
  /** Full ws:// URL, or derived from location (same origin, /ws/control). */
  url?: string;
  clientId?: string;
  /** Validate every downlink against the protocol (default: on). Invalid ones are dropped. */
  validate?: boolean;
  backoffMs?: number[];
  WebSocketImpl?: typeof WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
  onInvalid?: (raw: string, reason: string) => void;
}

type Handler<T extends DownlinkType> = (payload: DownlinkPayload<T>, env: Extract<DownlinkEnvelope, { type: T }>) => void;

const DEFAULT_BACKOFF = [250, 500, 1000, 2000];
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

export class ControlClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly handlers = new Map<string, ((p: unknown, e: unknown) => void)[]>();
  private readonly statusFns: ((s: ConnectionStatus) => void)[] = [];
  private readonly pending = new Map<string, (env: DownlinkEnvelope) => void>();
  readonly clientId: string;
  status: ConnectionStatus = "closed";
  sessionId: string | null = null;

  constructor(private readonly o: ControlClientOptions) {
    this.clientId = o.clientId ?? `${o.role}_${rid()}`;
  }

  private get url(): string {
    if (this.o.url) return this.o.url;
    const loc = (globalThis as { location?: Location }).location;
    if (!loc) throw new Error("ControlClient needs a url outside the browser");
    return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${WS_PATHS.control}`;
  }

  connect(): this {
    this.stopped = false;
    this.open();
    return this;
  }

  close(): void {
    this.stopped = true;
    if (this.timer) (this.o.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
    this.ws?.close(1000, "client closed");
    this.setStatus("closed");
  }

  on<T extends DownlinkType>(type: T, fn: Handler<T>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn as (p: unknown, e: unknown) => void);
    this.handlers.set(type, list);
    return () => { const l = this.handlers.get(type); if (l) l.splice(l.indexOf(fn as never), 1); };
  }

  onStatus(fn: (s: ConnectionStatus) => void): void { this.statusFns.push(fn); }

  /** Sends an uplink; returns its id, or null when not connected (nothing is queued). */
  send<T extends UplinkType>(type: T, payload: UplinkPayload<T>, replyTo?: string): string | null {
    if (!this.ws || this.ws.readyState !== 1 || this.status !== "open") return null;
    const id = rid();
    this.ws.send(JSON.stringify(envelope(type, payload, id, (this.o.now ?? Date.now)(), replyTo)));
    return id;
  }

  /** Sends and resolves with the reply envelope (replyTo = id), e.g. tool.invoke → tool.result or error. */
  request<T extends UplinkType>(type: T, payload: UplinkPayload<T>, timeoutMs = 10_000): Promise<DownlinkEnvelope> {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);
      if (!id) { reject(new Error("not connected")); return; }
      const t = (this.o.setTimer ?? setTimeout)(() => { this.pending.delete(id); reject(new Error(`${type} timed out`)); }, timeoutMs);
      this.pending.set(id, (env) => { (this.o.clearTimer ?? clearTimeout)(t as never); resolve(env); });
    });
  }

  // ---------------- internals ----------------

  private open(): void {
    const Impl = this.o.WebSocketImpl ?? globalThis.WebSocket;
    this.setStatus("connecting");
    let ws: WebSocket;
    try { ws = new Impl(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify(envelope("hello", { role: this.o.role, clientId: this.clientId, protocol: PROTOCOL_VERSION }, rid(), (this.o.now ?? Date.now)())));
    };
    ws.onmessage = (ev: MessageEvent) => { if (typeof ev.data === "string") this.onText(ev.data); };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === CLOSE_CODES.replaced) { this.setStatus("replaced"); return; }          // another tab took the role
      if (ev.code === CLOSE_CODES.protocolMismatch) { this.setStatus("refused"); return; }
      if (this.stopped) return;
      this.setStatus("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const b = this.o.backoffMs ?? DEFAULT_BACKOFF;
    const delay = b[Math.min(this.attempt, b.length - 1)] ?? 2000;
    this.attempt++;
    this.timer = (this.o.setTimer ?? setTimeout)(() => { this.timer = null; this.open(); }, delay);
  }

  private onText(raw: string): void {
    let env: DownlinkEnvelope;
    if (this.o.validate ?? true) {
      const r = parseDownlink(raw);
      if (!r.ok) { this.o.onInvalid?.(raw, r.message); return; }
      env = r.msg;
    } else {
      try { env = JSON.parse(raw) as DownlinkEnvelope; } catch { return; }
    }
    if (env.type === "ping") this.send("pong", {});
    if (env.type === "welcome") { this.sessionId = env.payload.sessionId; this.attempt = 0; this.setStatus("open"); }
    if (env.replyTo) { const p = this.pending.get(env.replyTo); if (p) { this.pending.delete(env.replyTo); p(env); } }
    for (const h of this.handlers.get(env.type) ?? []) h(env.payload, env);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const f of this.statusFns) f(s);
  }
}
