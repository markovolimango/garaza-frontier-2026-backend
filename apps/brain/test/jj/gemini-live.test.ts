import { describe, expect, it } from "vitest";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import { GeminiLiveAgent, type LiveSessionLike } from "../../src/jj/gemini-live.ts";
import { pcm16ToBase64 } from "../../src/jj/pcm.ts";
import type { ToolDeclaration } from "../../src/jj/voice-agent.ts";
import { VirtualClock, flush } from "../helpers.ts";

class FakeLive implements LiveSessionLike {
  client: unknown[] = []; realtime: unknown[] = []; toolResponses: unknown[] = []; closed = false;
  constructor(readonly params: LiveConnectParameters) {}
  sendClientContent(p: unknown) { this.client.push(p); }
  sendRealtimeInput(p: unknown) { this.realtime.push(p); }
  sendToolResponse(p: unknown) { this.toolResponses.push(p); }
  close() { this.closed = true; }
  msg(m: Partial<LiveServerMessage>) { this.params.callbacks.onmessage(m as LiveServerMessage); }
  setup() { this.msg({ setupComplete: {} }); }
  serverClose(code = 1011) { this.params.callbacks.onclose?.({ code, reason: "x" } as never); }
  audio(samples: number[]) { this.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16ToBase64(Int16Array.from(samples)) } }] } } }); }
}

const TOOLS: ToolDeclaration[] = [
  { name: "start_run", description: "d", parameters: { type: "object", properties: {} }, behavior: "BLOCKING" },
  { name: "save_brief", description: "d", parameters: { type: "object", properties: {} }, behavior: "NON_BLOCKING", scheduling: "WHEN_IDLE" },
];
const CTX = { systemPrompt: "SYS", tools: TOOLS, contextText: "[SESSION CONTEXT] x", voice: "Puck" };

function setup() {
  const clock = new VirtualClock();
  const sessions: FakeLive[] = [];
  let failNext = false;
  const agent = new GeminiLiveAgent({
    apiKey: "k", model: "gemini-3.8-live", clock,
    connectFn: async (p) => {
      if (failNext) { failNext = false; throw new Error("refused"); }
      const s = new FakeLive(p); sessions.push(s); return s;
    },
  });
  const states: { connected: boolean; speaking: boolean }[] = [];
  agent.onState((s) => states.push(s));
  return { clock, sessions, agent, states, failNextConnect: () => { failNext = true; } };
}

async function connected() {
  const t = setup();
  const p = t.agent.connect(CTX);
  await flush();
  t.sessions[0]!.setup();
  await p;
  return t;
}

describe("GeminiLiveAgent", () => {
  it("connects with an audio-only, resumable, compressed config and blocking tools", async () => {
    const t = await connected();
    const { model, config } = t.sessions[0]!.params;
    expect(model).toBe("gemini-3.8-live");
    expect(config).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
      systemInstruction: "SYS",
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    });
    const decls = (config!.tools as { functionDeclarations: { name: string; behavior: string; parametersJsonSchema: unknown }[] }[])[0]!.functionDeclarations;
    expect(decls.map((d) => [d.name, d.behavior])).toEqual([["start_run", "BLOCKING"], ["save_brief", "NON_BLOCKING"]]);
    expect(JSON.stringify(config)).not.toMatch(/video/i);
    expect(t.states.at(-1)).toEqual({ connected: true, speaking: false });
  });

  it("sends the context text first on a fresh session", async () => {
    const t = await connected();
    expect(t.sessions[0]!.client).toEqual([{ turns: [{ role: "user", parts: [{ text: "[SESSION CONTEXT] x" }] }], turnComplete: false }]);
  });

  it("rejects connect when setup never completes", async () => {
    const t = setup();
    const p = t.agent.connect(CTX);
    await flush();
    t.clock.advance(10_000);
    await expect(p).rejects.toThrow(/setup timeout/);
    expect(t.sessions[0]!.closed).toBe(true);
  });

  it("streams mic audio up as 16 kHz PCM and text as client content", async () => {
    const t = await connected();
    t.agent.sendAudio(Int16Array.from([1, -2]));
    expect(t.sessions[0]!.realtime).toEqual([{ audio: { data: pcm16ToBase64(Int16Array.from([1, -2])), mimeType: "audio/pcm;rate=16000" } }]);
    t.agent.sendText("[RUN ENDED] {}", { turnComplete: true });
    expect(t.sessions[0]!.client.at(-1)).toEqual({ turns: [{ role: "user", parts: [{ text: "[RUN ENDED] {}" }] }], turnComplete: true });
  });

  it("decodes audio down, tracks speaking, and ends on turnComplete", async () => {
    const t = await connected();
    const got: number[][] = [];
    t.agent.onAudio((p) => got.push([...p]));
    t.sessions[0]!.audio([5, -5, 32767]);
    expect(got).toEqual([[5, -5, 32767]]);
    expect(t.states.at(-1)).toEqual({ connected: true, speaking: true });
    t.sessions[0]!.msg({ serverContent: { turnComplete: true } });
    expect(t.states.at(-1)).toEqual({ connected: true, speaking: false });
  });

  it("reports server barge-in via onInterrupted", async () => {
    const t = await connected();
    let n = 0;
    t.agent.onInterrupted(() => n++);
    t.sessions[0]!.audio([1]);
    t.sessions[0]!.msg({ serverContent: { interrupted: true } });
    expect(n).toBe(1);
    expect(t.states.at(-1)!.speaking).toBe(false);
  });

  it("interrupt() drops the rest of the current turn but not the next one", async () => {
    const t = await connected();
    const got: number[] = [];
    t.agent.onAudio((p) => got.push(p[0]!));
    const s = t.sessions[0]!;
    s.audio([1]);
    t.agent.interrupt();
    s.audio([2]);
    s.msg({ serverContent: { turnComplete: true } });
    s.audio([3]);
    expect(got).toEqual([1, 3]);
  });

  it("answers tool calls by id; non-blocking ones carry the scheduling hint", async () => {
    const t = await connected();
    t.agent.onToolCall(async (c) => ({ ok: true, echo: c.name }));
    const s = t.sessions[0]!;
    s.msg({ toolCall: { functionCalls: [{ id: "c1", name: "start_run", args: {} }, { id: "c2", name: "save_brief", args: { title: "x" } }] } });
    await flush();
    expect(s.toolResponses).toEqual([
      { functionResponses: [{ id: "c1", name: "start_run", response: { ok: true, echo: "start_run" } }] },
      { functionResponses: [{ id: "c2", name: "save_brief", response: { ok: true, echo: "save_brief" }, scheduling: "WHEN_IDLE" }] },
    ]);
  });

  it("does not answer cancelled tool calls, and maps handler errors to internal", async () => {
    const t = await connected();
    let release!: () => void;
    t.agent.onToolCall((c) => c.id === "slow" ? new Promise((r) => { release = () => r({ ok: true }); }) : Promise.reject(new Error("bad")));
    const s = t.sessions[0]!;
    s.msg({ toolCall: { functionCalls: [{ id: "slow", name: "start_run", args: {} }] } });
    s.msg({ toolCallCancellation: { ids: ["slow"] } });
    release();
    s.msg({ toolCall: { functionCalls: [{ id: "err", name: "start_run", args: {} }] } });
    await flush();
    expect(s.toolResponses).toEqual([{ functionResponses: [{ id: "err", name: "start_run", response: { ok: false, reason: "internal", hint: "Error: bad" } }] }]);
  });

  it("emits input and output transcripts", async () => {
    const t = await connected();
    const tr: unknown[] = [];
    t.agent.onTranscript((x) => tr.push(x));
    t.sessions[0]!.msg({ serverContent: { inputTranscription: { text: "hi", finished: true }, outputTranscription: { text: "hello" } } });
    expect(tr).toEqual([{ who: "user", text: "hi", final: true }, { who: "jj", text: "hello", final: false }]);
  });

  it("on goAway, opens a resumed session with the latest handle, keeps the old one live until setup, and does not resend context", async () => {
    const t = await connected();
    const got: number[] = [];
    t.agent.onAudio((p) => got.push(p[0]!));
    const old = t.sessions[0]!;
    old.msg({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    old.msg({ sessionResumptionUpdate: { newHandle: "ignored", resumable: false } });
    old.msg({ goAway: { timeLeft: "10s" } });
    await flush();
    const next = t.sessions[1]!;
    expect(next.params.config!.sessionResumption).toEqual({ handle: "h1" });
    old.audio([7]);                       // old session still delivers until the swap
    expect(old.closed).toBe(false);
    next.setup();
    await flush();
    expect(old.closed).toBe(true);
    old.audio([8]);                       // ignored after the swap
    old.serverClose();                    // does not trigger another reconnect
    next.audio([9]);
    expect(got).toEqual([7, 9]);
    expect(next.client).toEqual([]);
    expect(t.sessions).toHaveLength(2);
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const t = await connected();
    t.sessions[0]!.msg({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    t.sessions[0]!.serverClose();
    expect(t.states.at(-1)).toEqual({ connected: false, speaking: false });
    t.agent.sendAudio(Int16Array.from([1]));           // dropped while down
    t.clock.advance(249);
    await flush();
    expect(t.sessions).toHaveLength(1);
    t.clock.advance(1);
    await flush();
    expect(t.sessions[1]!.params.config!.sessionResumption).toEqual({ handle: "h1" });
    t.sessions[1]!.setup();
    await flush();
    expect(t.states.at(-1)).toEqual({ connected: true, speaking: false });
  });

  it("falls back to a fresh session with up-to-date context when resumption fails", async () => {
    const t = await connected();
    t.agent.setContextProvider(() => "[SESSION CONTEXT] fresh");
    t.sessions[0]!.msg({ sessionResumptionUpdate: { newHandle: "stale", resumable: true } });
    t.sessions[0]!.serverClose();
    t.clock.advance(250);
    await flush();
    t.sessions[1]!.serverClose(1008);                  // server rejects the handle during setup
    await flush();
    const fresh = t.sessions[2]!;
    expect(fresh.params.config!.sessionResumption).toEqual({});
    fresh.setup();
    await flush();
    expect(fresh.client).toEqual([{ turns: [{ role: "user", parts: [{ text: "[SESSION CONTEXT] fresh" }] }], turnComplete: false }]);
    expect(t.agent.resumptionHandle).toBeNull();
  });

  it("keeps retrying with capped backoff while the provider is unreachable", async () => {
    const t = await connected();
    t.sessions[0]!.serverClose();
    t.failNextConnect();
    t.clock.advance(250);
    await flush();
    expect(t.sessions).toHaveLength(1);
    t.clock.advance(500);
    await flush();
    expect(t.sessions).toHaveLength(2);
  });

  it("close() stops everything and never reconnects", async () => {
    const t = await connected();
    await t.agent.close();
    expect(t.sessions[0]!.closed).toBe(true);
    t.sessions[0]!.serverClose();
    t.clock.advance(5000);
    await flush();
    expect(t.sessions).toHaveLength(1);
  });
});
