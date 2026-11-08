/**
 * The frontend's BrainSource against a real brain (hub, session, tools, fake JJ) over real
 * sockets: handshake, deck upload, session start, view/score/feedback/slide mapping, acks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrain } from "../../../brain/src/brain";
import { FakeVoiceAgent } from "../../../brain/src/jj/fake-agent";
import { readJJConfig } from "../../../brain/src/jj/config";
import { BrainSource } from "./BrainSource";
import { getLast, publish, subscribe } from "../signals/bus";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); }
};
// smallest valid PNG header bytes the brain checks for
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: "image/png" });

let cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "coach-fe-"));
  const agent = new FakeVoiceAgent();
  const brain = createBrain({ jj: readJJConfig({ GEMINI_API_KEY: "fake" }), agent, sessionDir: dir });
  const port = await brain.listen(0);
  const src = new BrainSource({ httpBase: `http://127.0.0.1:${port}`, audio: false });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => brain.close(), () => src.stop());
  src.start();
  await until(() => src.getSnapshot().status === "open" && src.getSnapshot().ui !== null);
  return { brain, src, agent, port };
}

describe("BrainSource ⇄ brain", () => {
  it("connects as the stage and receives the initial state", async () => {
    const { brain, src } = await setup();
    expect(brain.hub.isConnected("stage")).toBe(true);
    expect(src.getSnapshot()).toMatchObject({ ui: { view: "setup" }, sessionPhase: "setup" });
    expect(getLast("jjMood")).toBe(0.8);
  });

  it("deck upload → session.start → intro: JJ connects, view becomes jj, slides served", async () => {
    const { brain, src, agent, port } = await setup();
    const deck = await src.uploadSlides({ name: "Pitch", slides: [0, 1, 2].map((index) => ({ index, text: `slide ${index}`, width: 1920, height: 1080 })) }, [png(), png(), png()]);
    expect(deck.slides).toHaveLength(3);
    expect(brain.session.get().context.deck?.deckId).toBe(deck.deckId);
    await until(() => src.getSnapshot().ui?.view === "jj");
    expect(brain.session.get().phase).toBe("intro");
    await until(() => agent.connected);
    const img = await fetch(`http://127.0.0.1:${port}${deck.slides[1]!.url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });

  it("a run: slide.show drives the presenter, presenter slides reach the brain, feedback reaches the vignette", async () => {
    const { brain, src } = await setup();
    await src.uploadSlides({ name: "P", slides: [0, 1, 2, 3].map((index) => ({ index, text: "", width: 10, height: 10 })) }, [png(), png(), png(), png()]);
    await until(() => brain.session.get().phase === "intro");
    const commands: number[] = [];
    cleanup.push(subscribe("slideCommand", (n) => commands.push(n)));
    expect(await src.invoke("start_run")).toMatchObject({ ok: true, run_id: "run_1", mode: "baseline" });
    await until(() => src.getSnapshot().ui?.view === "slides" && commands.includes(0));
    await until(() => src.getSnapshot().run?.phase === "presentation", 5000);

    publish("slide", 0);                 // echo of the commanded slide: not re-sent
    publish("slide", 2);                 // user pressed → twice
    await until(() => brain.session.get().run?.slideIndex === 2);

    brain.sync.setFeedback({ kind: "warn", intensity: 0.65, rampMs: 2000, reason: "arms_crossed" });
    await until(() => getLast("feedback")?.color === "red");
    expect(getLast("feedback")).toEqual({ color: "red", intensity: 0.65 });

    expect(await src.invoke("go_to_slide", { index: 3 })).toMatchObject({ ok: true });
    await until(() => commands.includes(3));

    expect(src.send("presentation.done", {})).toBe(true);
    await until(() => src.getSnapshot().ui?.view === "room");
    await until(() => getLast("feedback")?.color !== "red" || brain.session.get().run?.phase === "qa");
  }, 15_000);

  it("acks scene.apply so scene tools succeed", async () => {
    const { brain, src } = await setup();
    expect(await src.invoke("set_audience", { count: 20 })).toMatchObject({ ok: true, version: 2 });
    expect(brain.session.get().scene.audience.count).toBe(20);
  });

  it("push-to-talk pauses a run; refused actions come back as toasts", async () => {
    const { brain, src } = await setup();
    await src.uploadSlides({ name: "P", slides: [{ index: 0, text: "", width: 10, height: 10 }] }, [png()]);
    await until(() => brain.session.get().phase === "intro");
    src.send("presentation.done", {});      // wrong phase → error → toast
    await until(() => src.getSnapshot().toasts.length > 0);
    await src.invoke("start_run");
    await until(() => brain.session.get().run?.phase === "presentation", 5000);
    src.ptt(true);
    await until(() => src.getSnapshot().run?.paused === true);
    expect(src.getSnapshot().ui?.orb).toMatchObject({ visible: true, placement: "corner" });
  }, 15_000);

  it("rejects bad uploads with a reason", async () => {
    const { src } = await setup();
    await expect(src.uploadSlides({ name: "P", slides: [{ index: 0, text: "", width: 1, height: 1 }] }, [new Blob(["not a png"])])).rejects.toThrow(/not a PNG/);
    await expect(src.uploadSlides({ name: "P", slides: [{ index: 1, text: "", width: 1, height: 1 }] }, [png()])).rejects.toThrow(/0\.\.n-1/);
  });
});
