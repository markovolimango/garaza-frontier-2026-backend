import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { DownlinkEnvelope } from "@coach/protocol";
import { ControlClient } from "@coach/web/net";
import { createBrain, type Brain } from "../src/brain.ts";
import { VirtualClock } from "../src/clock.ts";
import { FakeVoiceAgent } from "../src/jj/fake-agent.ts";
import { readJJConfig } from "../src/jj/config.ts";

const until = async (pred: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); }
};
const deck = { deckId: "d1", name: "Deck", slides: [0, 1, 2, 3].map((i) => ({ index: i, url: `/api/decks/d1/${i}.png`, text: `slide ${i}` })) };

let cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function setup() {
  const clock = new VirtualClock(1_762_540_000_000);
  const agent = new FakeVoiceAgent();
  const brain: Brain = createBrain({ jj: readJJConfig({ GEMINI_API_KEY: "fake", JUDGE_VOICES: "va,vb,vc" }), clock, agent });
  const port = await brain.listen(0);
  cleanup.push(() => brain.close());
  const url = `ws://127.0.0.1:${port}/ws/control`;

  /** A fake main app: records everything, acks scene.apply unless told not to. */
  const stage = (opts: { ack?: boolean } = {}) => {
    const c = new ControlClient({ role: "stage", url, backoffMs: [20] });
    const got: DownlinkEnvelope[] = [];
    const types = ["welcome", "ui.state", "scene.sync", "scene.apply", "run.state", "feedback.set", "slide.show", "countdown", "jj.state", "actor.say", "audio.stop", "error", "hud.toast", "report.focus"] as const;
    for (const t of types) c.on(t, (_p, env) => got.push(env as DownlinkEnvelope));
    c.on("scene.apply", (p) => { if (opts.ack !== false) c.send("ack", { batchId: p.batchId, version: p.version, ok: true }); });
    cleanup.push(() => c.close());
    c.connect();
    const of = <T extends DownlinkEnvelope["type"]>(t: T) => got.filter((e) => e.type === t) as Extract<DownlinkEnvelope, { type: T }>[];
    return { c, got, of };
  };
  const operator = () => {
    const c = new ControlClient({ role: "operator", url });
    const snaps: Extract<DownlinkEnvelope, { type: "state.snapshot" }>[] = [];
    c.on("state.snapshot", (_p, e) => snaps.push(e as never));
    cleanup.push(() => c.close());
    c.connect();
    return { c, snaps };
  };
  return { clock, agent, brain, port, url, stage, operator };
}

describe("brain end to end", () => {
  it("a stage gets welcome, ui.state, scene.sync, run.state and feedback.set on connect", async () => {
    const t = await setup();
    const s = t.stage();
    await until(() => s.got.length >= 5);
    expect(s.got.slice(0, 5).map((e) => e.type)).toEqual(["welcome", "ui.state", "scene.sync", "run.state", "feedback.set"]);
    expect(s.of("ui.state")[0]!.payload).toMatchObject({ view: "setup", orb: { visible: false } });
    expect(s.of("scene.sync")[0]!.payload).toMatchObject({ scene: { version: 1 }, venue: { id: "greybox" }, deck: null });
  });

  it("session.start before the deck: JJ connects and talks; the deck arrives as a note; runs need it", async () => {
    const t = await setup();
    const s = t.stage();
    await until(() => s.c.status === "open");
    s.c.send("session.start", {});
    await until(() => s.of("ui.state").some((e) => e.payload.view === "jj"));
    await until(() => t.agent.connected);
    expect(t.agent.textsMatching(/^\[SESSION START] first session, phase intro, deck: none yet/)).toHaveLength(1);
    expect(t.brain.session.dispatch({ type: "start_run" })).toMatchObject({ ok: false, reason: "no_deck" });
    t.brain.session.setContext({ deck });
    await until(() => t.agent.textsMatching(/^\[DECK UPLOADED] 4 slides/).length === 1);
    await until(() => s.of("jj.state").some((e) => e.payload.connected && e.payload.listening));
  });

  it("operator tool.invoke → scene.apply → stage ack → tool.result, and the snapshot follows", async () => {
    const t = await setup();
    const s = t.stage();
    const op = t.operator();
    await until(() => s.c.status === "open" && op.c.status === "open");
    const r = await op.c.request("tool.invoke", { tool: "set_audience", args: { count: 25 } });
    expect(r).toMatchObject({ type: "tool.result", payload: { ok: true, version: 2 } });
    expect(s.of("scene.apply")[0]!.payload).toMatchObject({ version: 2, ops: [{ op: "audience.set", count: 25 }] });
    t.clock.advance(200);
    await until(() => op.snaps.some((x) => x.payload.session.scene.audience.count === 25));
    expect(op.snaps.at(-1)!.payload.connections).toEqual({ stage: true, sensor: false, operator: true });
  });

  it("a stage that never acks: stage_timeout to the caller and a scene.sync rollback", async () => {
    const t = await setup();
    const s = t.stage({ ack: false });
    const op = t.operator();
    await until(() => s.c.status === "open" && op.c.status === "open");
    const pending = op.c.request("tool.invoke", { tool: "set_lighting", args: { preset: "dim" } });
    await until(() => s.of("scene.apply").length === 1);
    t.clock.advance(2000);
    expect((await pending).payload).toMatchObject({ ok: false, reason: "stage_timeout" });
    await until(() => s.of("scene.sync").length === 2);
    expect(s.of("scene.sync")[1]!.payload.scene).toMatchObject({ version: 1, lighting: "default" });
  });

  it("a run: countdown, slides from the stage are not echoed, slides from tools are; reload restores", async () => {
    const t = await setup();
    t.brain.session.setContext({ deck });
    const s = t.stage();
    const op = t.operator();
    await until(() => s.c.status === "open" && op.c.status === "open");
    t.brain.session.dispatch({ type: "session_start" });
    expect((await op.c.request("tool.invoke", { tool: "start_run", args: {} })).payload).toMatchObject({ ok: true, run_id: "run_1", mode: "baseline" });
    await until(() => s.of("slide.show").length === 1 && s.of("countdown").length === 1);
    for (let i = 0; i < 3; i++) t.clock.advance(1000);
    await until(() => s.of("countdown").length === 4);
    expect(s.of("countdown").map((e) => e.payload.secondsLeft)).toEqual([3, 2, 1, 0]);
    await until(() => s.of("run.state").some((e) => e.payload.run?.phase === "presentation"));

    s.c.send("slide.changed", { index: 2, clientTs: 0 });
    await until(() => t.brain.session.get().run?.slideIndex === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of("slide.show")).toHaveLength(1);
    await op.c.request("tool.invoke", { tool: "go_to_slide", args: { index: 3 } });
    await until(() => s.of("slide.show").length === 2);
    expect(s.of("slide.show")[1]!.payload.index).toBe(3);

    const reloaded = t.stage();
    await until(() => reloaded.of("run.state").length >= 1);
    expect(reloaded.of("ui.state")[0]!.payload.view).toBe("slides");
    expect(reloaded.of("run.state")[0]!.payload.run).toMatchObject({ runId: "run_1", phase: "presentation", slideIndex: 3 });
  });

  it("push-to-talk pauses the run and routes the mic to JJ", async () => {
    const t = await setup();
    t.brain.session.setContext({ deck });
    const s = t.stage();
    await until(() => s.c.status === "open");
    t.brain.session.dispatch({ type: "session_start" });
    t.brain.session.dispatch({ type: "start_run" });
    t.clock.advance(3000);
    await until(() => t.agent.connected);
    const mic = new WsClient(t.url.replace("control", "mic"));
    cleanup.push(() => mic.close());
    await new Promise((r) => mic.on("open", r));
    mic.send(JSON.stringify({ type: "mic.hello", sampleRate: 16000 }));
    mic.send(Buffer.alloc(640));
    await until(() => t.brain.mic.framesIn === 1);
    expect(t.agent.sentAudio).toHaveLength(0);                     // presentation: mic goes to STT only
    s.c.send("ptt", { down: true });
    await until(() => t.brain.session.get().run?.paused === true);
    expect(t.brain.mic.sinks()).toEqual(["jj", "stt"]);
    mic.send(Buffer.alloc(640));
    await until(() => t.agent.sentAudio.length >= 1);
    await until(() => s.of("ui.state").some((e) => e.payload.orb.placement === "corner" && e.payload.orb.visible));
  });

  it("operator overrides: vignette is forced then released; replay is not available yet", async () => {
    const t = await setup();
    const s = t.stage();
    const op = t.operator();
    await until(() => s.c.status === "open" && op.c.status === "open");
    op.c.send("operator.override", { action: "vignette", kind: "warn", intensity: 0.65, holdMs: 3000 });
    await until(() => s.of("feedback.set").some((e) => e.payload.kind === "warn"));
    t.clock.advance(3000);
    await until(() => s.of("feedback.set").at(-1)!.payload.kind === "none");
    const r = await op.c.request("operator.override", { action: "replay", file: "x.jsonl", speed: 1 });
    expect(r).toMatchObject({ type: "error", payload: { code: "not_available" } });
  });

  it("serves /health and /api/tools", async () => {
    const t = await setup();
    const h = await (await fetch(`http://127.0.0.1:${t.port}/health`)).json();
    expect(h).toMatchObject({ ok: true, connected: [], jj: "down", phase: "setup" });
    const cat = (await (await fetch(`http://127.0.0.1:${t.port}/api/tools`)).json()) as { tools: unknown[] };
    expect(cat.tools).toHaveLength(21);
    expect(cat.tools[0]).toHaveProperty("argsSchema");
    expect((await fetch(`http://127.0.0.1:${t.port}/api/runs/run_1/report`)).status).toBe(501);
  });
});
