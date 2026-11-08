import { describe, expect, it } from "vitest";
import { feedbackToBus, intentFor, orbTarget, reportsSlides, viewToRoute } from "../brain/mapping";

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

  it("refuses moves that mean nothing in the loop", () => {
    expect(intentFor("setup", null, "/")).toMatchObject({ kind: "hint" });
    expect(intentFor("slides", "countdown", "/judges")).toMatchObject({ kind: "hint" });
    expect(intentFor("jj", null, "/report")).toMatchObject({ kind: "hint" });
  });

  it("orb follows JJ's voice, then the mic, then idles", () => {
    expect(orbTarget({ speaking: true, listening: true }, 0.2, 0.9)).toBeCloseTo(0.85);
    expect(orbTarget({ speaking: false, listening: true }, 0, 0.1)).toBeCloseTo(0.35);
    expect(orbTarget(null, 1, 1)).toBe(0.15);
    expect(reportsSlides("presentation")).toBe(true);
    expect(reportsSlides("qa")).toBe(false);
  });
});
