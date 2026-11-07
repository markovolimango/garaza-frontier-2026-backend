/**
 * Shared /ws/control client for every page (main app, sensor, operator).
 * Spec "Transport": sends hello on open, answers ping with pong, reconnects with backoff
 * 250 ms → 2 s (cap) and repeats the handshake, so a reload or brain restart always
 * restores full state. Downlink messages are validated in dev mode.
 */
import { type ClientRole, type DownlinkEnvelope, type DownlinkPayload, type DownlinkType, type UplinkPayload, type UplinkType } from "@coach/protocol";
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
type Handler<T extends DownlinkType> = (payload: DownlinkPayload<T>, env: Extract<DownlinkEnvelope, {
    type: T;
}>) => void;
export declare class ControlClient {
    private readonly o;
    private ws;
    private attempt;
    private timer;
    private stopped;
    private readonly handlers;
    private readonly statusFns;
    private readonly pending;
    readonly clientId: string;
    status: ConnectionStatus;
    sessionId: string | null;
    constructor(o: ControlClientOptions);
    private get url();
    connect(): this;
    close(): void;
    on<T extends DownlinkType>(type: T, fn: Handler<T>): () => void;
    onStatus(fn: (s: ConnectionStatus) => void): void;
    /** Sends an uplink; returns its id, or null when not connected (nothing is queued). */
    send<T extends UplinkType>(type: T, payload: UplinkPayload<T>, replyTo?: string): string | null;
    /** Sends and resolves with the reply envelope (replyTo = id), e.g. tool.invoke → tool.result or error. */
    request<T extends UplinkType>(type: T, payload: UplinkPayload<T>, timeoutMs?: number): Promise<DownlinkEnvelope>;
    private open;
    private scheduleReconnect;
    private onText;
    private setStatus;
}
export {};
