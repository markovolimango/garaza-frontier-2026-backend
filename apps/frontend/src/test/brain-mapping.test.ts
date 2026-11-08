import { describe, expect, it } from "vitest";
import { feedbackToBus, intentFor, orbTarget, reportsSlides, runClockChanges, viewToRoute } from "../brain/mapping";

describe("brain mapping", () => {
  it("maps feedback.set onto the vignette bus", () => {
    expect(feedbackToBus({ kind: "warn", intensity: 0.65, rampMs: 2000, reason: "arms_crossed" })).toEqual({ color: "red", intensity: 0.65 });
    expect(feedbackToBus({ kind: "reward", intensity: 0.25, rampMs: 1500 })).toEqual({ color: "green", intensity: 0.25 });
    expect(feedbackToBus({ kind: "none", intensity: 0, rampMs: 1000 })).toEqual({ color: "neutral", intensity: 0 });
  });

  it("maps every brain view to a screen", () => {
    expect((["setup", "jj", "slides", "room", "report", "final"] as const).map(viewToRoute)).toEqual(["/presenter", "/", "/presenter", "/judges", "/report", "/report"]);
  });

  it("turns forward navigation into loop actions", () => {
    expect(intentFor("jj", null, "/presenter")).toMatchObject({ kind: "tool", tool: "start_run" });
    expect(intentFor("report", "ended", "/presenter")).toMatchObject({ kind: "tool", tool: "start_run" });
    expect(intentFor("slides", "presentation", "/judges")).toMatchObject({ kind: "send", type: "presentation.done" });
    expect(intentFor("room", "qa", "/report")).toMatchObject({ kind: "tool", tool: "end_run" });
  });

  it("refuses moves that mean nothing in the loop, saying what to do instead", () => {
    expect(intentFor("setup", null, "/")).toEqual({ kind: "hint", text: "Upload your deck (PDF) first" });
    expect(intentFor("slides", "countdown", "/judges")).toMatchObject({ kind: "hint", text: "The run is starting…" });
    expect(intentFor("slides", "presentation", "/")).toMatchObject({ kind: "hint", text: expect.stringContaining("Judges →") });
    expect(intentFor("room", "qa", "/presenter")).toMatchObject({ kind: "hint", text: expect.stringContaining("Report →") });
    expect(intentFor("jj", null, "/report")).toMatchObject({ kind: "hint", text: expect.stringContaining("Start run") });
    expect(intentFor("report", "ended", "/judges")).toMatchObject({ kind: "hint" });
  });

  it("allows JJ's screen after a run (JJ debriefs there)", () => {
    expect(intentFor("report", "ended", "/")).toEqual({ kind: "allow" });
    expect(intentFor("final", null, "/")).toEqual({ kind: "allow" });
  });

  it("runs the presenter timer with the presentation", () => {
    const run = (phase: "countdown" | "presentation" | "qa", paused = false, runId = "run_1") => ({ runId, phase, paused });
    expect(runClockChanges(null, run("countdown"))).toEqual([]);
    expect(runClockChanges(run("countdown"), run("presentation"))).toEqual(["start"]);
    expect(runClockChanges(run("presentation"), run("presentation", true))).toEqual(["pause"]);
    expect(runClockChanges(run("presentation", true), run("presentation"))).toEqual(["resume"]);
    expect(runClockChanges(run("presentation"), run("presentation"))).toEqual([]);
    expect(runClockChanges(run("presentation"), run("qa"))).toEqual(["stop"]);
    expect(runClockChanges(null, run("presentation", true))).toEqual(["start", "pause"]);   // reload while woken
    expect(runClockChanges(run("presentation"), run("presentation", false, "run_2"))).toEqual(["start"]);
  });

  it("orb follows JJ's voice, then the mic, then idles", () => {
    expect(orbTarget({ speaking: true, listening: true }, 0.2, 0.9)).toBeCloseTo(0.85);
    expect(orbTarget({ speaking: false, listening: true }, 0, 0.1)).toBeCloseTo(0.35);
    expect(orbTarget(null, 1, 1)).toBe(0.15);
    expect(reportsSlides("presentation")).toBe(true);
    expect(reportsSlides("qa")).toBe(false);
  });
});
