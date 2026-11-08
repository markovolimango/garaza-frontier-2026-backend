import { describe, expect, it } from "vitest";
import { SWARM_TOOLS, ToolName } from "@coach/protocol";
import { ToolRegistry, briefSummary, createCoachTools, createSwarmTools, resolveJudge, toughnessSpread, type SwarmToolPort } from "../../src/jj/tools.ts";
import type { SwarmCommand } from "../../src/swarm/board.ts";
import { FakeContext, FakeHub, FakeReports, FakeSession, VirtualClock, judge } from "../helpers.ts";

/** The board side of the swarm tools: records commands, keeps the latest per kind. */
class FakeSwarm implements SwarmToolPort {
  commands: SwarmCommand[] = [];
  asked: { agent: string; question?: string | undefined }[] = [];
  command(c: SwarmCommand) { this.commands.push(c); }
  latest<T extends SwarmCommand["type"]>(type: T) {
    return (this.commands.filter((c) => c.type === type).at(-1) as Extract<SwarmCommand, { type: T }> | undefined) ?? null;
  }
  facts(agent: string, question?: string) { this.asked.push({ agent, question }); return { filler_count: 7, top_fillers: [{ word: "um", count: 5 }] }; }
}

function swarmSetup() {
  const clock = new VirtualClock();
  const session = new FakeSession(clock);
  const swarm = new FakeSwarm();
  const told: string[] = [];
  const tools = createSwarmTools({ session, swarm, onCommand: (a, s) => told.push(`${a}: ${s}`) }, new ToolRegistry(() => clock.now()));
  return { session, swarm, tools, told };
}

function setup() {
  const clock = new VirtualClock();
  const session = new FakeSession(clock);
  const context = new FakeContext();
  const reports = new FakeReports();
  const hub = new FakeHub();
  const tools = createCoachTools({ session, context, reports, hub, judgeVoices: ["va", "vb", "vc"] }, new ToolRegistry(() => clock.now()));
  return { clock, session, context, reports, hub, tools };
}

describe("ToolRegistry", () => {
  it("registers every tool in the spec table exactly once (the swarm's tools with createSwarmTools)", () => {
    const { tools } = setup();
    const swarm: readonly string[] = SWARM_TOOLS;
    expect(tools.declarations().map((d) => d.name).sort()).toEqual(ToolName.options.filter((n) => !swarm.includes(n)).sort());
    createSwarmTools({ session: new FakeSession(new VirtualClock()), swarm: new FakeSwarm() }, tools);
    expect(tools.declarations().map((d) => d.name).sort()).toEqual([...ToolName.options].sort());
  });

  it("declares only save_brief and regenerate_personas as non-blocking, scheduled when idle", () => {
    const { tools } = setup();
    const nb = tools.declarations().filter((d) => d.behavior === "NON_BLOCKING");
    expect(nb.map((d) => d.name).sort()).toEqual(["regenerate_personas", "save_brief"]);
    expect(nb.every((d) => d.scheduling === "WHEN_IDLE")).toBe(true);
  });

  it("emits flat JSON schemas without $schema, unions or refs", () => {
    const { tools } = setup();
    for (const d of tools.declarations()) {
      expect(d.parameters.type).toBe("object");
      const json = JSON.stringify(d.parameters);
      expect(json).not.toMatch(/"\$schema"|"anyOf"|"oneOf"|"allOf"|"\$ref"/);
    }
  });

  it("rejects unknown tools and invalid args without calling the handler", async () => {
    const { tools, session } = setup();
    expect(await tools.invoke("nope", {}, "jj")).toMatchObject({ ok: false, reason: "not_available" });
    expect(await tools.invoke("set_qa", { questions: 9 }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("set_targets", { behaviors: ["long_pause"] }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(session.sceneOps).toHaveLength(0);
  });

  it("maps a throwing handler to internal and notifies listeners", async () => {
    const reg = new ToolRegistry();
    const seen: string[] = [];
    reg.onInvoked((i) => seen.push(`${i.name}:${i.caller}:${i.result.ok}`));
    const { z } = await import("zod");
    reg.register({ name: "end_run", description: "", args: z.object({}), behavior: "BLOCKING", handler: async () => { throw new Error("x"); } });
    expect(await reg.invoke("end_run", {}, "operator")).toMatchObject({ ok: false, reason: "internal" });
    expect(seen).toEqual(["end_run:operator:false"]);
  });
});

describe("coach tools", () => {
  it("save_brief stores the brief, rebuilds context and commits a 3-judge panel with seats, voices and toughness spread", async () => {
    const { tools, session, context } = setup();
    session.dispatch({ type: "session_start" });
    const r = await tools.invoke("save_brief", {
      title: "Acme seed", audience: "seed investors", goal: "raise 1M", key_points: ["traction"], setting: "investor pitch", duration_min: 5,
    }, "jj");
    expect(r).toMatchObject({ ok: true, judges: [{ id: "judge_1", title: "Persona 1" }, { id: "judge_2" }, { id: "judge_3" }] });
    expect(context.briefs[0]).toMatchObject({ keyPoints: ["traction"], durationMin: 5 });
    expect(context.personaCalls).toEqual([{ n: 3 }]);
    const [ops] = session.sceneOps;
    expect(ops![0]).toMatchObject({ op: "judges.set" });
    const judges = (ops![0] as { judges: { seat: string; voiceId: string; toughness: number; priorities: string[] }[] }).judges;
    expect(judges.map((j) => j.seat)).toEqual(["judge_seat_1", "judge_seat_2", "judge_seat_3"]);
    expect(judges.map((j) => j.voiceId)).toEqual(["va", "vb", "vc"]);
    expect(judges.map((j) => j.toughness)).toEqual([0.3, 0.5, 0.8]);
    expect(judges[0]!.priorities).toHaveLength(3);
    expect(ops![1]).toEqual({ op: "audience.set", count: 12 });
  });

  it("save_brief outside the intro is refused with wrong_phase", async () => {
    const { tools, context } = setup();
    const r = await tools.invoke("save_brief", { title: "t", audience: "a", goal: "g", key_points: [], setting: "s" }, "jj");
    expect(r).toMatchObject({ ok: false, reason: "wrong_phase" });
    expect(context.briefs).toHaveLength(0);
  });

  it("start_run passes explicit mode/level and returns the run", async () => {
    const { tools, session } = setup();
    session.dispatch({ type: "session_start" });
    expect(await tools.invoke("start_run", {}, "jj")).toMatchObject({ ok: true, run_id: "run_1" });
    expect(session.actions.at(-1)).toEqual({ type: "start_run" });
    session.dispatch({ type: "end_run" });
    await tools.invoke("start_run", { mode: "training", level: "gentle" }, "jj");
    expect(session.actions.at(-1)).toEqual({ type: "start_run", mode: "training", level: "gentle" });
  });

  it("start_run tells JJ what the run won't measure (the pre-run check), and starts anyway", async () => {
    const { tools, session, reports } = setup();
    session.dispatch({ type: "session_start" });
    reports.preRunCheck = () => ({ ready: false, hints: ["The camera doesn't see you: step into the frame."] });
    expect(await tools.invoke("start_run", {}, "jj")).toMatchObject({ ok: true, run_id: "run_1", not_measured: ["The camera doesn't see you: step into the frame."] });
    session.dispatch({ type: "end_run" });
    reports.preRunCheck = () => ({ ready: true, hints: [] });
    expect(await tools.invoke("start_run", {}, "jj")).not.toHaveProperty("not_measured");
  });

  it("set_judge resolves left/center/right by seat and patches one judge", async () => {
    const { tools, session } = setup();
    expect(await tools.invoke("set_judge", { judge: "right", toughness: 1 }, "jj")).toMatchObject({ ok: true, version: 2 });
    expect(session.sceneOps[0]).toEqual([{ op: "judge.update", id: "judge_3", patch: { toughness: 1 } }]);
    expect(await tools.invoke("set_judge", { judge: "center" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
  });

  it("resolveJudge handles odd/even panels and unknown ids", () => {
    const two = [judge(2, { seat: "judge_seat_10" }), judge(1, { seat: "judge_seat_2" })];
    expect(resolveJudge(two, "left")).toEqual({ id: "judge_1" });   // numeric seat order, not lexical
    expect(resolveJudge(two, "right")).toEqual({ id: "judge_2" });
    expect(resolveJudge(two, "center")).toHaveProperty("error");
    expect(resolveJudge([judge(1), judge(2), judge(3)], "center")).toEqual({ id: "judge_2" });
    expect(resolveJudge(two, "judge_5")).toHaveProperty("error");
  });

  it("set_judges patches every judge, or regenerates when the count changes", async () => {
    const { tools, session, context } = setup();
    await tools.invoke("set_judges", { toughness: 0.9 }, "jj");
    expect(session.sceneOps[0]).toHaveLength(3);
    expect(session.s.scene.judges.every((j) => j.toughness === 0.9)).toBe(true);
    const r = await tools.invoke("set_judges", { count: 5, style: "warm" }, "jj");
    expect(r).toMatchObject({ ok: true });
    expect(context.personaCalls.at(-1)).toEqual({ n: 5 });
    expect(session.s.scene.judges).toHaveLength(5);
    expect(session.s.scene.judges.every((j) => j.style === "warm")).toBe(true);
    expect(session.s.scene.judges[4]!.voiceId).toBe("va");   // fewer voices than judges: falls back
  });

  it("surfaces scene failures from the stage (timeout, offline)", async () => {
    const { tools, session } = setup();
    session.sceneResult = { ok: false, reason: "stage_timeout" };
    expect(await tools.invoke("set_audience", { count: 3 }, "jj")).toEqual({ ok: false, reason: "stage_timeout" });
  });

  it("set_qa keeps the answer cap; set_lighting uses a transition", async () => {
    const { tools, session } = setup();
    await tools.invoke("set_qa", { questions: 4 }, "operator");
    await tools.invoke("set_lighting", { preset: "dim" }, "operator");
    expect(session.sceneOps).toEqual([
      [{ op: "qa.set", qa: { questions: 4, answerCapMs: 45000 } }],
      [{ op: "lighting.set", preset: "dim", transitionMs: 1500 }],
    ]);
  });

  it("highlight_pattern sends report.focus, or stage_offline", async () => {
    const { tools, hub } = setup();
    expect(await tools.invoke("highlight_pattern", { kind: "arms_crossed" }, "jj")).toEqual({ ok: true });
    expect(await tools.invoke("highlight_pattern", { kind: "none" }, "jj")).toEqual({ ok: true });
    expect(hub.ofType("report.focus").map((m) => m.payload.kind)).toEqual(["arms_crossed", null]);
    hub.connected.delete("stage");
    expect(await tools.invoke("highlight_pattern", { kind: "sway" }, "jj")).toMatchObject({ ok: false, reason: "stage_offline" });
  });

  it("get_last_run_report returns the latest finished run's report", async () => {
    const { tools, session, reports } = setup();
    expect(await tools.invoke("get_last_run_report", {}, "jj")).toMatchObject({ ok: false, reason: "not_available" });
    session.dispatch({ type: "session_start" });
    session.dispatch({ type: "start_run" });
    session.dispatch({ type: "end_run" });
    reports.reports.set("run_1", { patterns: [] });
    expect(await tools.invoke("get_last_run_report", {}, "jj")).toEqual({ ok: true, report: { patterns: [] } });
  });

  it("go_to_slide rejects out-of-range indexes", async () => {
    const { tools, session } = setup();
    session.dispatch({ type: "session_start" });
    session.dispatch({ type: "start_run" });
    expect(await tools.invoke("go_to_slide", { index: 5 }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("go_to_slide", { index: 4 }, "jj")).toEqual({ ok: true, index: 4 });
  });

  it("set_targets de-duplicates; calibrate_gaze is not_available without the P1 flow", async () => {
    const { tools, session } = setup();
    expect(await tools.invoke("set_targets", { behaviors: ["sway", "sway"] }, "jj")).toEqual({ ok: true, targets: ["sway"] });
    expect(session.actions.at(-1)).toEqual({ type: "set_targets", targets: ["sway"] });
    expect(await tools.invoke("calibrate_gaze", {}, "jj")).toMatchObject({ ok: false, reason: "not_available" });
  });

  it("toughnessSpread", () => {
    expect(toughnessSpread(3)).toEqual([0.3, 0.5, 0.8]);
    expect(toughnessSpread(1)).toEqual([0.5]);
    expect(toughnessSpread(5)).toEqual([0.3, 0.43, 0.55, 0.68, 0.8]);
  });
});

describe("swarm tools (JJ leads the agents)", () => {
  it("direct_judges briefs the director and merges with the latest brief", async () => {
    const { tools, swarm, told } = swarmSetup();
    expect(await tools.invoke("direct_judges", { strictness: "tough", focus: ["pricing"] }, "jj"))
      .toEqual({ ok: true, brief: { strictness: "tough", focus: ["pricing"] }, applies_to: "the next Q&A" });
    const r = await tools.invoke("direct_judges", { follow_ups: true, note: "press on the market size" }, "jj");
    expect(r).toMatchObject({ ok: true, brief: { strictness: "tough", focus: ["pricing"], follow_ups: true, note: "press on the market size" } });
    expect(swarm.commands.at(-1)).toEqual({ type: "director.brief", strictness: "tough", focus: ["pricing"], followUps: true, note: "press on the market size" });
    expect(told.at(-1)).toBe("director: tough judges · focus pricing · follow-ups · press on the market size");
    // [] clears the focus; interrupts can be switched off
    await tools.invoke("direct_judges", { focus: [], interrupts: false }, "jj");
    expect(swarm.commands.at(-1)).toEqual({ type: "director.brief", strictness: "tough", followUps: true, interrupts: false, note: "press on the market size" });
  });

  it("direct_judges has no question count: set_qa is the one way to set it", async () => {
    const { tools, swarm } = swarmSetup();
    expect(JSON.stringify(tools.catalogue().tools.find((x) => x.name === "direct_judges")!.argsSchema)).not.toContain("questions");
    expect(await tools.invoke("direct_judges", { questions: 2 }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(swarm.commands).toEqual([]);
  });

  it("direct_judges per judge: left/center/right resolve by seat; a panel-wide strictness replaces them", async () => {
    const { tools, swarm, session } = swarmSetup();
    session.s.scene.judges = [judge(1), judge(2), judge(3)];
    expect(await tools.invoke("direct_judges", { judge: "right", strictness: "kind" }, "jj")).toMatchObject({ ok: true, brief: { per_judge: { judge_3: "kind" } } });
    await tools.invoke("direct_judges", { judge: "judge_1", strictness: "tough" }, "jj");
    expect(swarm.latest("director.brief")!.perJudge).toEqual({ judge_3: "kind", judge_1: "tough" });
    await tools.invoke("direct_judges", { strictness: "neutral" }, "jj");
    expect(swarm.latest("director.brief")).toEqual({ type: "director.brief", strictness: "neutral" });
    expect(await tools.invoke("direct_judges", { judge: "left" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("direct_judges", { judge: "judge_5", strictness: "kind" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("direct_judges", {}, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("direct_judges", { strictness: "brutal" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
  });

  it("direct_judges during the Q&A applies to the rest of it", async () => {
    const { tools, session } = swarmSetup();
    session.dispatch({ type: "session_start" });
    session.dispatch({ type: "start_run" });
    session.s.run!.phase = "qa";
    expect(await tools.invoke("direct_judges", { strictness: "kind" }, "jj")).toMatchObject({ ok: true, applies_to: "the rest of this Q&A" });
  });

  it("set_feedback_policy sets what filler words do; it has no body option", async () => {
    const { tools, swarm } = swarmSetup();
    expect(await tools.invoke("set_feedback_policy", { fillers: "every" }, "jj")).toEqual({ ok: true, fillers: "every" });
    expect(swarm.commands.at(-1)).toEqual({ type: "feedback.policy", fillers: "every" });
    expect(await tools.invoke("set_feedback_policy", {}, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(await tools.invoke("set_feedback_policy", { body: "off" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(JSON.stringify(tools.catalogue().tools.find((x) => x.name === "set_feedback_policy")!.argsSchema)).not.toContain("body");
  });

  it("make_report orders a run or session report; needs a run first", async () => {
    const { tools, swarm, session } = swarmSetup();
    expect(await tools.invoke("make_report", { scope: "run" }, "jj")).toMatchObject({ ok: false, reason: "not_available" });
    session.dispatch({ type: "session_start" });
    session.dispatch({ type: "start_run" });
    session.dispatch({ type: "end_run" });
    expect(await tools.invoke("make_report", { scope: "run", focus: "the Q&A" }, "jj")).toMatchObject({ ok: true, scope: "run", run_id: "run_1" });
    expect(swarm.commands.at(-1)).toEqual({ type: "report.make", scope: "run", runId: "run_1", focus: "the Q&A" });
    await tools.invoke("make_report", { scope: "session" }, "jj");
    expect(swarm.commands.at(-1)).toEqual({ type: "report.make", scope: "session" });
  });

  it("ask_agent answers from the board at once", async () => {
    const { tools, swarm } = swarmSetup();
    expect(await tools.invoke("ask_agent", { agent: "listener", question: "how many times did I say um?" }, "jj"))
      .toEqual({ ok: true, agent: "listener", filler_count: 7, top_fillers: [{ word: "um", count: 5 }] });
    expect(swarm.asked).toEqual([{ agent: "listener", question: "how many times did I say um?" }]);
    expect(await tools.invoke("ask_agent", { agent: "jj" }, "jj")).toMatchObject({ ok: false, reason: "invalid_args" });
  });

  it("all swarm tools are blocking with flat schemas; briefSummary of no brief", () => {
    const { tools } = swarmSetup();
    expect(tools.declarations().every((d) => d.behavior === "BLOCKING")).toBe(true);
    expect(JSON.stringify(tools.declarations())).not.toMatch(/anyOf|oneOf|\$ref/);
    expect(briefSummary(null)).toBe("default panel");
  });
});
