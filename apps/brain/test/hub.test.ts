import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import { decodeAudioFrame, type DownlinkEnvelope } from "@coach/protocol";
import { ControlClient } from "@coach/web/net";
import { VirtualClock } from "../src/clock.ts";
import { WsHub } from "../src/hub.ts";

const until = async (pred: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); }
};

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.reverse()) c(); cleanup = []; });

async function setup() {
  const clock = new VirtualClock(1_762_540_000_000);
  const hub = new WsHub({ clock, sessionId: () => "sess_1" });
  const server: Server = createServer();
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(() => { hub.close(); server.close(); });
  const client = (role: "stage" | "sensor" | "operator", extra: Partial<ConstructorParameters<typeof ControlClient>[0]> = {}) => {
    const c = new ControlClient({ role, url: `ws://127.0.0.1:${port}/ws/control`, ...extra });
    const got: DownlinkEnvelope[] = [];
    for (const t of ["welcome", "error", "ping", "hud.toast", "tool.result", "jj.state"] as const) c.on(t, (_p, env) => got.push(env as DownlinkEnvelope));
    cleanup.push(() => c.close());
    return { c, got };
  };
  /** A raw socket that speaks the protocol by hand (never answers pings). */
  const raw = async () => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/ws/control`);
    const got: DownlinkEnvelope[] = [];
    let closed: number | null = null;
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    ws.on("close", (code) => { closed = code; });
    await new Promise((r) => ws.on("open", r));
    cleanup.push(() => ws.close());
    const send = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ws.send(JSON.stringify({ v: 1, type, id: `m_${Math.random()}`, ts: 1, payload, ...extra }));
    return { ws, got, send, closed: () => closed };
  };
  return { clock, hub, port, client, raw };
}

describe("hub handshake", () => {
  it("hello → welcome, then the role's initial state", async () => {
    const t = await setup();
    t.hub.onConnect("stage", () => t.hub.send("stage", { type: "hud.toast", payload: { text: "initial", level: "info" } }));
    const { c, got } = t.client("stage");
    c.connect();
    await until(() => got.length >= 2);
    expect(got[0]).toMatchObject({ v: 1, type: "welcome", payload: { sessionId: "sess_1", serverTime: 1_762_540_000_000, protocol: 1 } });
    expect(got[1]).toMatchObject({ type: "hud.toast", payload: { text: "initial" } });
    expect(c.status).toBe("open");
    expect(c.sessionId).toBe("sess_1");
    expect(t.hub.connections()).toEqual({ stage: true, sensor: false, operator: false });
  });

  it("refuses another protocol version at hello and closes with 4002", async () => {
    const t = await setup();
    const r = await t.raw();
    r.ws.send(JSON.stringify({ v: 2, type: "hello", id: "h", ts: 1, payload: { role: "stage", clientId: "x", protocol: 2 } }));
    await until(() => r.closed() !== null);
    expect(r.got[0]).toMatchObject({ type: "error", payload: { code: "protocol_mismatch", refId: "h" } });
    expect(r.closed()).toBe(4002);
    expect(t.hub.isConnected("stage")).toBe(false);
  });

  it("requires hello first and closes silent sockets after the hello timeout", async () => {
    const t = await setup();
    const r = await t.raw();
    r.send("ptt", { down: true }, { id: "p1" });
    await until(() => r.got.length > 0);
    expect(r.got[0]).toMatchObject({ type: "error", payload: { code: "invalid_message", refId: "p1" } });
    t.clock.advance(5000);
    await until(() => r.closed() !== null);
    expect(r.closed()).toBe(4003);
  });
});

describe("hub validation", () => {
  it("answers invalid, unknown and wrong-role messages with error and never calls handlers", async () => {
    const t = await setup();
    const calls: string[] = [];
    t.hub.on("ptt", () => calls.push("ptt"));
    t.hub.on("behavior", () => calls.push("behavior"));
    const r = await t.raw();
    r.send("hello", { role: "stage", clientId: "s1", protocol: 1 });
    await until(() => r.got.length === 1);
    r.send("ptt", { down: "yes" }, { id: "bad" });
    r.send("dance", {}, { id: "unknown" });
    r.send("behavior", { kind: "arms_crossed", phase: "start", clientTs: 1, conf: 1 }, { id: "role" });
    r.ws.send("not json");
    await until(() => r.got.length === 5);
    expect(r.got.slice(1).map((e) => [e.type, (e.payload as { refId?: string }).refId])).toEqual([["error", "bad"], ["error", "unknown"], ["error", "role"], ["error", undefined]]);
    expect(calls).toEqual([]);
    r.send("ptt", { down: true });
    await until(() => calls.length === 1);
  });

  it("re-stamps ts with the brain clock and passes the sender role", async () => {
    const t = await setup();
    let seen: { ts: number; role: string } | null = null;
    t.hub.on("tool.invoke", (m, role) => { seen = { ts: m.ts, role }; });
    const { c } = t.client("operator", { now: () => 42 });
    c.connect();
    await until(() => c.status === "open");
    c.send("tool.invoke", { tool: "end_run", args: {} });
    await until(() => seen !== null);
    expect(seen).toEqual({ ts: 1_762_540_000_000, role: "operator" });
  });

  it("request() resolves with the envelope that replies to it", async () => {
    const t = await setup();
    t.hub.on("tool.invoke", (m) => t.hub.send("operator", { type: "tool.result", replyTo: m.id, payload: { ok: true, version: 7 } }));
    const { c } = t.client("operator");
    c.connect();
    await until(() => c.status === "open");
    const env = await c.request("tool.invoke", { tool: "set_qa", args: { questions: 1 } });
    expect(env).toMatchObject({ type: "tool.result", payload: { ok: true, version: 7 } });
  });
});

describe("hub liveness and replacement", () => {
  it("pings every 5 s; the client pongs and stays connected", async () => {
    const t = await setup();
    const { c, got } = t.client("sensor");
    c.connect();
    await until(() => c.status === "open");
    for (let i = 0; i < 4; i++) {
      t.clock.advance(5000);
      await until(() => got.filter((e) => e.type === "ping").length === i + 1);
      await new Promise((r) => setTimeout(r, 20));   // let the pong arrive
    }
    expect(t.hub.isConnected("sensor")).toBe(true);
  });

  it("marks a client dead after 15 s of silence", async () => {
    const t = await setup();
    const gone: string[] = [];
    t.hub.onDisconnect((r) => gone.push(r));
    const r = await t.raw();
    r.send("hello", { role: "operator", clientId: "o", protocol: 1 });
    await until(() => t.hub.isConnected("operator"));
    t.clock.advance(15_000);
    await until(() => r.closed() !== null);
    expect(r.closed()).toBe(4004);
    expect(gone).toEqual(["operator"]);
    expect(t.hub.isConnected("operator")).toBe(false);
  });

  it("a second client of the same role replaces the first (4001); the first does not reconnect", async () => {
    const t = await setup();
    const connects: number[] = [];
    t.hub.onConnect("stage", () => connects.push(1));
    const a = t.client("stage", { clientId: "tab_a" });
    a.c.connect();
    await until(() => a.c.status === "open");
    const b = t.client("stage", { clientId: "tab_b" });
    b.c.connect();
    await until(() => b.c.status === "open" && a.c.status === "replaced");
    await new Promise((r) => setTimeout(r, 400));
    expect(a.c.status).toBe("replaced");
    expect(t.hub.isConnected("stage")).toBe(true);
    expect(connects).toHaveLength(2);
    expect(t.hub.send("stage", { type: "hud.toast", payload: { text: "to b", level: "info" } })).toBe(true);
    await until(() => b.got.some((e) => e.type === "hud.toast"));
    expect(a.got.some((e) => e.type === "hud.toast")).toBe(false);
  });

  it("the client reconnects after a drop and repeats the handshake", async () => {
    const t = await setup();
    let initial = 0;
    t.hub.onConnect("stage", () => { initial++; });
    const { c, got } = t.client("stage", { backoffMs: [50] });
    c.connect();
    await until(() => initial === 1);
    t.clock.advance(15_000);                     // no pong can arrive in virtual time → dead → closed
    await until(() => c.status !== "open");
    await until(() => initial === 2 && c.status === "open", 3000);
    expect(got.filter((e) => e.type === "welcome")).toHaveLength(2);
  });
});

describe("binary endpoints", () => {
  it("/ws/mic delivers Int16 frames after mic.hello; rejects a wrong sample rate", async () => {
    const t = await setup();
    const frames: number[][] = [];
    t.hub.onMic((pcm) => frames.push([...pcm.slice(0, 2)]));
    const mic = new WsClient(`ws://127.0.0.1:${t.port}/ws/mic`);
    cleanup.push(() => mic.close());
    await new Promise((r) => mic.on("open", r));
    mic.send(Buffer.alloc(640));                    // before hello: ignored
    mic.send(JSON.stringify({ type: "mic.hello", sampleRate: 16000 }));
    const f = Buffer.alloc(640); f.writeInt16LE(1234, 0); f.writeInt16LE(-5, 2);
    mic.send(f);
    await until(() => frames.length === 1);
    expect(frames).toEqual([[1234, -5]]);
    expect(t.hub.micConnected()).toBe(true);

    const bad = new WsClient(`ws://127.0.0.1:${t.port}/ws/mic`);
    let code = 0; bad.on("close", (c) => { code = c; });
    await new Promise((r) => bad.on("open", r));
    bad.send(JSON.stringify({ type: "mic.hello", sampleRate: 48000 }));
    await until(() => code !== 0);
    expect(code).toBe(4002);
  });

  it("/ws/audio receives framed PCM from sendAudio", async () => {
    const t = await setup();
    const audio = new WsClient(`ws://127.0.0.1:${t.port}/ws/audio`);
    cleanup.push(() => audio.close());
    const got: Buffer[] = [];
    audio.on("message", (d) => got.push(d as Buffer));
    await new Promise((r) => audio.on("open", r));
    await new Promise((r) => setTimeout(r, 20));
    t.hub.sendAudio(2, 1, 9, Int16Array.from([7, -7]));
    await until(() => got.length === 1);
    expect(decodeAudioFrame(new Uint8Array(got[0]!))).toMatchObject({ source: 2, flags: 1, seq: 9 });
  });
});
