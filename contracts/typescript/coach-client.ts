// Minimal client for the coaching backend (REST + /v1/stream). Browser or Node 22+ (fetch, WebSocket).
// Types come from ./coach-types.ts (generated). This file has no dependencies.
import type {
  ErrorEnvelope,
  HistoryExpiredMessage,
  SessionCreate,
  StreamServerMessage,
  TypedEvent,
} from "./coach-types";

export class CoachApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface CoachClientOptions {
  /** e.g. "http://127.0.0.1:8765" (or https://<mac>.local:8765 in LAN/TLS mode) */
  baseUrl: string;
  /** Operator token. A future product UI should use a narrower token; never put it in URLs. */
  token: string;
}

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SubscribeOptions {
  /** Session id or "latest". */
  sessionId?: string;
  /** Exact event types or prefix wildcards, e.g. ["coaching.*", "speech.metrics"]. */
  eventTypes?: string[];
  /** Aggregated state at `cursor`. Replace your UI state with it. */
  onSnapshot?: (snapshot: Record<string, unknown>, cursor: number) => void;
  /** Ordered by server cursor. `replay` is true for history sent after a reconnect. */
  onEvent?: (event: TypedEvent, replay: boolean) => void;
  /** Everything after `cursor` is live. */
  onSynced?: (cursor: number) => void;
  /** The resume cursor left the ring buffer: reset your event timeline; a fresh snapshot follows. */
  onHistoryExpired?: (info: HistoryExpiredMessage) => void;
  onStatus?: (status: StreamStatus, detail?: string) => void;
}

export class CoachClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: CoachClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  wsUrl(path: string): string {
    return this.baseUrl.replace(/^http/, "ws") + path;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const isJson = (response.headers.get("content-type") ?? "").includes("json");
    const data: unknown = isJson ? await response.json() : null;
    if (!response.ok) {
      const error = (data as Partial<ErrorEnvelope> | null)?.error;
      throw new CoachApiError(response.status, error?.code ?? "http_error", error?.message ?? response.statusText,
        error?.details);
    }
    return data as T;
  }

  createSession(body: SessionCreate = {}) {
    return this.request<Record<string, unknown>>("POST", "/v1/sessions", body);
  }
  start(sessionId: string) {
    return this.request<Record<string, unknown>>("POST", `/v1/sessions/${sessionId}/start`);
  }
  pause(sessionId: string) {
    return this.request<Record<string, unknown>>("POST", `/v1/sessions/${sessionId}/pause`);
  }
  resume(sessionId: string) {
    return this.request<Record<string, unknown>>("POST", `/v1/sessions/${sessionId}/resume`);
  }
  stop(sessionId: string) {
    return this.request<Record<string, unknown>>("POST", `/v1/sessions/${sessionId}/stop`);
  }
  snapshot(sessionId: string) {
    return this.request<Record<string, unknown>>("GET", `/v1/sessions/${sessionId}/snapshot`);
  }
  summary(sessionId: string, narrative = false) {
    return this.request<Record<string, unknown>>("GET", `/v1/sessions/${sessionId}/summary?narrative=${narrative}`);
  }
  events(sessionId: string, afterCursor = 0, limit = 500, types?: string[]) {
    const query = new URLSearchParams({ after_cursor: String(afterCursor), limit: String(limit) });
    if (types && types.length) query.set("types", types.join(","));
    return this.request<{ events: TypedEvent[]; next_cursor: number; head_cursor: number; has_more: boolean }>(
      "GET", `/v1/sessions/${sessionId}/events?${query.toString()}`);
  }
  async streamTicket(): Promise<string> {
    const result = await this.request<{ ticket: string }>("POST", "/v1/stream-tickets");
    return result.ticket;
  }

  subscribe(options: SubscribeOptions): StreamSubscription {
    return new StreamSubscription(this, options);
  }
}

/** Reconnecting subscription. Browsers cannot set Authorization on WebSockets, so it sends a
 *  short-lived single-use ticket as the first message, then resumes from the last cursor. */
export class StreamSubscription {
  private ws: WebSocket | null = null;
  private lastCursor: number | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly client: CoachClient, private readonly options: SubscribeOptions) {
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
    this.options.onStatus?.("closed");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.options.onStatus?.("connecting");
    let ticket: string;
    try {
      ticket = await this.client.streamTicket();
    } catch (error) {
      this.retry(String(error));
      return;
    }
    const ws = new WebSocket(this.client.wsUrl("/v1/stream"));
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", ticket }));
    ws.onmessage = (message: MessageEvent) => this.handle(JSON.parse(String(message.data)) as StreamServerMessage);
    ws.onclose = (event: CloseEvent) => {
      if (!this.stopped) this.retry(`closed (${event.code})`);
    };
  }

  private handle(message: StreamServerMessage): void {
    switch (message.type) {
      case "auth.ok":
        this.attempt = 0;
        this.options.onStatus?.("open");
        this.ws?.send(JSON.stringify({
          type: "subscribe",
          session_id: this.options.sessionId ?? "latest",
          event_types: this.options.eventTypes ?? null,
          after_cursor: this.lastCursor,
        }));
        break;
      case "history_expired":
        this.lastCursor = null;
        this.options.onHistoryExpired?.(message);
        break;
      case "snapshot":
        if (this.lastCursor === null) this.lastCursor = message.cursor;
        this.options.onSnapshot?.(message.snapshot, message.cursor);
        break;
      case "event":
        this.lastCursor = message.event.cursor;
        this.options.onEvent?.(message.event as unknown as TypedEvent, message.replay === true);
        break;
      case "synced":
        this.lastCursor = Math.max(this.lastCursor ?? 0, message.cursor);
        this.options.onSynced?.(message.cursor);
        break;
      case "error":
        this.options.onStatus?.("reconnecting", String(message.error["code"] ?? "error"));
        break;
      default:
        break;
    }
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    this.options.onStatus?.("reconnecting", reason);
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    setTimeout(() => void this.connect(), delay);
  }
}
