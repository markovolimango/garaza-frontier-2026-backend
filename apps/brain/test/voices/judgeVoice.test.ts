import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIO_FLAG, type DownlinkMessage, type Uplink } from "@coach/protocol";
import { RealClock, VirtualClock } from "../../src/clock.ts";
import { DEFAULT_JUDGE_VOICE_IDS, JudgeVoices, judgeVoicesHttp, type JudgeVoiceHub } from "../../src/voices/judgeVoice.ts";

type Ev = { kind: "msg"; msg: DownlinkMessage } | { kind: "audio"; source: number; flags: number; seq: number; samples: number[] };

function fakeHub() {
  const events: Ev[] = [];
  let playback: ((m: Uplink<"audio.playback">) => void) | null = null;
  const hub: JudgeVoiceHub = {
    send: (_r, msg) => { events.push({ kind: "msg", msg }); return true; },
    sendAudio: (source, flags, seq, pcm) => { events.push({ kind: "audio", source, flags, seq, samples: [...pcm] }); },
    on: (_t, h) => { playback = h; },
  };
  const ended = (utteranceId: string, source = 1) =>
    playback!({ type: "audio.playback", id: "x", ts: 0, payload: { source, utteranceId, state: "ended" } } as Uplink<"audio.playback">);
  return { hub, events, ended };
}

/** Fake fetch streaming the given byte chunks; records requests. */
function fakeFetch(chunks: number[][], status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
    return new Response(status === 200 ? body : "nope", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

describe("JudgeVoices", () => {
  it("sends talk, actor.say, framed PCM (odd bytes carried over), end frame, then idle after playback", async () => {
    const { hub, events, ended } = fakeHub();
    const { f, calls } = fakeFetch([[1, 0, 2], [0, 3, 0], []]);
    const v = new JudgeVoices({ hub, clock: new VirtualClock(), apiKey: "k", voiceIds: ["", "voiceB"], fetch: f });
    const u = v.speakJudge("judge_2", "Why now?");
    await settle();

    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voiceB/stream?output_format=pcm_24000");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: "Why now?", model_id: "eleven_flash_v2_5" });

    expect(events[0]).toEqual({ kind: "msg", msg: { type: "actor.gesture", payload: { actorId: "judge_2", gesture: "talk" } } });
    expect(events[1]).toEqual({ kind: "msg", msg: { type: "actor.say", payload: { actorId: "judge_2", utteranceId: u.utteranceId, source: 2, text: "Why now?" } } });
    const audio = events.filter((e) => e.kind === "audio");
    expect(audio).toEqual([
      { kind: "audio", source: 2, flags: AUDIO_FLAG.utteranceStart, seq: 1, samples: [1] },
      { kind: "audio", source: 2, flags: 0, seq: 1, samples: [2, 3] },
      { kind: "audio", source: 2, flags: AUDIO_FLAG.utteranceEnd, seq: 1, samples: [] },
    ]);
    expect(events.some((e) => e.kind === "msg" && e.msg.type === "actor.gesture" && e.msg.payload.gesture === "idle")).toBe(false);

    ended(u.utteranceId, 2);
    await u.done;
    expect(events.at(-1)).toEqual({ kind: "msg", msg: { type: "actor.gesture", payload: { actorId: "judge_2", gesture: "idle" } } });
  });

  it("falls back to the playback timeout when the stage never reports", async () => {
    const clock = new VirtualClock();
    const { hub, events } = fakeHub();
    const v = new JudgeVoices({ hub, clock, apiKey: "k", fetch: fakeFetch([[0, 0, 0, 0]]).f });
    const u = v.speakJudge("judge_1", "hi");
    await settle();
    clock.advance(1600);
    await u.done;
    expect(events.at(-1)).toMatchObject({ kind: "msg", msg: { payload: { gesture: "idle" } } });
  });

  it("serializes: the second judge starts only after the first finishes", async () => {
    const { hub, events, ended } = fakeHub();
    const v = new JudgeVoices({ hub, clock: new VirtualClock(), apiKey: "k", fetch: fakeFetch([[5, 0]]).f });
    const a = v.speakJudge("judge_1", "one");
    const b = v.speakJudge("judge_3", "two");
    await settle();
    expect(events.some((e) => e.kind === "msg" && e.msg.type === "actor.say" && e.msg.payload.actorId === "judge_3")).toBe(false);
    ended(a.utteranceId);
    await a.done; await settle();
    const says = events.filter((e) => e.kind === "msg" && e.msg.type === "actor.say");
    expect(says).toHaveLength(2);
    ended(b.utteranceId, 3);
    await b.done;
  });

  it("without an API key: say + gestures, no audio, no fetch", async () => {
    const { hub, events } = fakeHub();
    const { f, calls } = fakeFetch([[1, 0]]);
    const v = new JudgeVoices({ hub, clock: new VirtualClock(), fetch: f });
    await v.speakJudge("judge_4", "hello").done;
    expect(calls).toHaveLength(0);
    expect(events.map((e) => e.kind === "msg" ? `${e.msg.type}` : "audio")).toEqual(["actor.gesture", "actor.say", "actor.gesture"]);
    expect(v.voiceFor("judge_4")).toBe(DEFAULT_JUDGE_VOICE_IDS[3]);
  });

  it("a TTS error still ends with idle and does not block the queue", async () => {
    const { hub, events } = fakeHub();
    const v = new JudgeVoices({ hub, clock: new VirtualClock(), apiKey: "k", fetch: fakeFetch([], 401).f });
    await v.speakJudge("judge_1", "x").done;
    expect(events.filter((e) => e.kind === "audio")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: "msg", msg: { payload: { gesture: "idle" } } });
  });
});

describe("POST /debug/judge-say", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("queues a line and validates input", async () => {
    const { hub, events } = fakeHub();
    const v = new JudgeVoices({ hub, clock: new RealClock() });
    const route = judgeVoicesHttp(v);
    server = createServer(async (req, res) => { if (!(await route(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/debug/judge-say`;

    const ok = await fetch(base, { method: "POST", body: JSON.stringify({ judge: 3, text: "Who pays?" }) });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ ok: true, actorId: "judge_3", utteranceId: "judge_3_u1" });
    await settle();
    expect(events.some((e) => e.kind === "msg" && e.msg.type === "actor.say" && e.msg.payload.text === "Who pays?")).toBe(true);

    expect((await fetch(base, { method: "POST", body: JSON.stringify({ judge: 5, text: "x" }) })).status).toBe(400);
    expect((await fetch(base, { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(base)).status).toBe(405);
  });
});
