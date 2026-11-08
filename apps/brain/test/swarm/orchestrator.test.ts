import { afterEach, describe, expect, it } from "vitest";
import { ToolName, type RunId } from "@coach/protocol";
import { createBrain, type Brain } from "../../src/brain.ts";
import { VirtualClock } from "../../src/clock.ts";
import { FakeVoiceAgent } from "../../src/jj/fake-agent.ts";
import { readJJConfig } from "../../src/jj/config.ts";
import { RunLog } from "../../src/runlog.ts";
import { SwarmBoard } from "../../src/swarm/board.ts";
import type { SwarmContext } from "../../src/swarm/context.ts";
import { installOrchestrator } from "../../src/swarm/orchestrator.ts";
import { flush } from "../helpers.ts";

const deck = { deckId: "d1", name: "Deck", slides: [0, 1, 2].map((i) => ({ index: i, url: `/x/${i}.png`, text: `slide ${i}` })) };
let brains: Brain[] = [];
afterEach(async () => { for (const b of brains) await b.close(); brains = []; });

function setup() {
  const clock = new VirtualClock(1_762_540_000_000);
  const agent = new FakeVoiceAgent();
  const brain = createBrain({ jj: readJJConfig({ GEMINI_API_KEY: "fake", JUDGE_VOICES: "va,vb,vc" }), clock, agent });
  brains.push(brain);
  const board = new SwarmBoard({ clock });
  const runLog = new RunLog({ session: brain.session, hub: brain.hub, clock });
  installOrchestrator({ board, brain, runLog, clock, log: () => {} } as unknown as SwarmContext);
  const jjRow = () => board.allStatuses().find((a) => a.id === "jj")!;
  return { clock, agent, brain, board, runLog, jjRow };
}

async function inRun(t: ReturnType<typeof setup>) {
  t.brain.session.setContext({ deck });
  t.brain.session.dispatch({ type: "session_start" });
  await flush();
  expect(t.brain.session.dispatch({ type: "start_run" })).toMatchObject({ ok: true });
  return t.brain.session.get().run!.runId as RunId;
}

describe("swarm orchestrator", () => {
  it("registers JJ's swarm tools on the brain's registry: the catalogue has every tool", () => {
    const t = setup();
    expect(t.brain.tools.catalogue().tools.map((x) => x.name).sort()).toEqual([...ToolName.options].sort());
  });

  it("direct_judges → board director.brief; JJ's row shows the order", async () => {
    const t = setup();
    expect(await t.brain.tools.invoke("direct_judges", { strictness: "tough", focus: ["pricing"] }, "jj")).toMatchObject({ ok: true });
    expect(t.board.latest("director.brief")).toEqual({ type: "director.brief", strictness: "tough", focus: ["pricing"] });
    expect(t.jjRow()).toMatchObject({ state: "working", detail: "→ director: tough judges · focus pricing" });
    t.clock.advance(9000);
    expect(t.jjRow().state).toBe("off");   // back to JJ's own state (not connected before the session)
  });

  it("ask_agent reads the board: fillers of the current run, the judges' brief and lines, video notes", async () => {
    const t = setup();
    expect(await t.brain.tools.invoke("ask_agent", { agent: "listener" }, "jj")).toMatchObject({ ok: true, note: "no run yet" });
    const runId = await inRun(t);
    const phrase = (text: string, fillers: string[], at: number) =>
      t.board.emit({ type: "phrase", phrase: { runId, segment: "presentation", text, fillers, startAt: at, endAt: at + 3000, slideIndex: 0 } });
    phrase("Um so this is, um, our product", ["um", "um"], 0);
    phrase("Like, it saves time", ["like"], 40_000);
    phrase("Uh, and um it is cheap", ["Uh", "um"], 57_000);
    const r = await t.brain.tools.invoke("ask_agent", { agent: "listener", question: "how many times did I say um?" }, "jj");
    expect(r).toMatchObject({
      ok: true, agent: "listener", run: 1, filler_count: 5, phrases: 3, fillers_per_min: 5,
      top_fillers: [{ word: "um", count: 3 }, { word: "like", count: 1 }, { word: "uh", count: 1 }],
      fillers_by_segment: { presentation: 5, qa: 0 },
      last_phrases: ["Um so this is, um, our product", "Like, it saves time", "Uh, and um it is cheap"],
    });

    await t.brain.tools.invoke("direct_judges", { strictness: "kind" }, "jj");
    t.board.emit({ type: "judge.line", line: { runId, judgeId: "judge_3", kind: "question", text: "Why now?", at: 1 } });
    expect(await t.brain.tools.invoke("ask_agent", { agent: "director" }, "jj")).toMatchObject({
      brief: "kind judges", questions_asked: 1, judge_lines: [{ judge: "VC investor", kind: "question", text: "Why now?" }],
    });

    t.board.emit({ type: "video.note", note: { runId, kind: "arms_crossed", atMs: 83_000, text: "Arms crossed while showing pricing" } });
    expect(await t.brain.tools.invoke("ask_agent", { agent: "body" }, "jj")).toMatchObject({
      video_notes: [{ at: "1:23", kind: "arms_crossed", text: "Arms crossed while showing pricing" }],
    });
    expect(await t.brain.tools.invoke("ask_agent", { agent: "reporter" }, "jj")).toMatchObject({ run_report: "not yet", headline: null });
    t.board.setRunReport(runId, { headline: "Clearer than run 1" });
    expect(await t.brain.tools.invoke("ask_agent", { agent: "reporter" }, "jj")).toMatchObject({ run_report: "ready", headline: "Clearer than run 1" });
  });

  it("agent.note → JJ hears '[DIRECTOR] …' outside runs; during a run it waits for the debrief", async () => {
    const t = setup();
    t.brain.session.setContext({ deck });
    t.brain.session.dispatch({ type: "session_start" });
    await flush();
    expect(t.jjRow().state).toBe("listening");
    t.board.note("director", "the panel is set to tough", true);
    await flush();
    expect(t.agent.sentText.at(-1)).toEqual({ text: "[DIRECTOR] the panel is set to tough", turnComplete: true });

    t.brain.session.dispatch({ type: "start_run" });
    await flush();
    t.board.note("body", "arms crossed twice");
    await flush();
    expect(t.agent.textsMatching(/^\[BODY]/)).toEqual([]);
    expect(t.brain.jj.pendingNotes()).toBe(1);
    expect(t.jjRow().detail).toMatch(/1 note for the debrief/);
  });
});
