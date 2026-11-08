import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunDigest, SessionProgress } from "@coach/protocol";

vi.mock("../components/NextButton", () => ({ NextButton: ({ label }: { label: string }) => <a>{label} →</a> }));
const { ReportView } = await import("../brain/BrainReport");
const { fmtMs } = await import("../brain/format");
const { ProgressView } = await import("../brain/BrainProgress");
const { isWakePhrase } = await import("../brain/wake");

const digest: RunDigest = {
  runId: "run_2", index: 2, mode: "training", level: "strong", targets: ["sway"], endedBy: "qa_done",
  durations: { presentationMs: 185_000, qaMs: 64_000, pausedMs: 0 },
  slides: [{ index: 0, dwellMs: 40_000, visits: 1 }, { index: 1, dwellMs: 145_000, visits: 2 }],
  observations: [
    { rule: "body.torso_movement_high", kind: "sway", category: "movement", label: "Moving around / swaying", count: 3, isTarget: true,
      examples: [{ tRunMs: 83_000, segment: "presentation", slideIndex: 1, text: "You have been moving around continuously." }] },
    { rule: "body.hand_movement_high", kind: null, category: "movement", label: "Fast hand movement", count: 1, isTarget: false, examples: [] },
  ],
  feedback: { warnings: 2, rewards: 0 }, wakes: 1,
  qa: [{ judgeId: "judge_3", judgeTitle: "VC investor", question: "How did you arrive at that price?", answerMs: 21_000 },
       { judgeId: "judge_4", judgeTitle: "Technical expert", question: "What is hard here?", answerMs: 0 }],
  strengths: ["No long pauses"],
  next: { mode: "training", level: "gentle", reason: "Next run with gentle live feedback on swaying.", done: false },
  sources: { coach: true },
};

describe("brain report screen", () => {
  it("shows the run, what the coach noticed, slides, the judges' questions and the next run", () => {
    render(<ReportView d={digest} />);
    expect(screen.getByText("Training run · strong feedback")).toBeTruthy();
    expect(screen.getByText("4:09")).toBeTruthy();                         // total
    expect(screen.getByText("Moving around / swaying")).toBeTruthy();
    expect(screen.getByText("3×")).toBeTruthy();
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText(/1:23, slide 2: You have been moving/)).toBeTruthy();
    expect(screen.getByText("Slide 2")).toBeTruthy();
    expect(screen.getByText("How did you arrive at that price?")).toBeTruthy();
    expect(screen.getByText("answered for 0:21")).toBeTruthy();
    expect(screen.getByText("no answer heard")).toBeTruthy();
    expect(screen.getByText("✓ No long pauses")).toBeTruthy();
    expect(screen.getByText("Next run with gentle live feedback on swaying.")).toBeTruthy();
  });

  it("lights up the behaviour JJ is talking about (report.focus), and nothing for null", () => {
    const { container, rerender } = render(<ReportView d={digest} focus="sway" />);
    const lit = container.querySelectorAll("[data-focus]");
    expect(lit).toHaveLength(1);
    expect(lit[0]!.textContent).toContain("Moving around / swaying");
    expect(lit[0]!.className).toContain("ring-2");
    rerender(<ReportView d={digest} focus={null} />);
    expect(container.querySelectorAll("[data-focus]")).toHaveLength(0);
  });

  it("says when the camera coach was not connected", () => {
    render(<ReportView d={{ ...digest, observations: [], strengths: [], sources: { coach: false } }} />);
    expect(screen.getByText(/camera coach wasn't connected/)).toBeTruthy();
    expect(fmtMs(59_600)).toBe("1:00");
  });
});

const run = (index: number, mode: "baseline" | "training", score: number) => ({
  runId: `run_${index}` as const, index, mode, level: mode === "baseline" ? "off" as const : "strong" as const, targets: [], endedBy: "qa_done" as const,
  presentationMs: 150_000, qaMs: 40_000, observations: 2, warnings: mode === "baseline" ? 0 : 3, score, coach: true,
});
const progress: SessionProgress = {
  sessionId: "s", runs: [run(1, "baseline", 0.6), run(2, "training", 0.75), run(3, "training", 0.9)],
  rows: [
    { rule: "body.torso_movement_high", kind: "sway", label: "Moving around / swaying", counts: [3, 1, 0], isTarget: true, status: "fixed", trend: "better" },
    { rule: "body.hand_movement_high", kind: null, label: "Fast hand movement", counts: [1, null, 2], isTarget: false, status: null, trend: "worse" },
  ],
  coach: { stage: "fading", level: "gentle", score: 0.9, recommendation: { mode: "training", level: "gentle", reason: "Next run with gentle live feedback.", done: false } },
  headline: "Moving around / swaying 3 → 0 · Fast hand movement 1 → 2",
};

describe("progress across runs", () => {
  it("shows each run, each behaviour per run with its trend, the targets and the headline", () => {
    render(<ProgressView p={progress} />);
    expect(screen.getByText(progress.headline!)).toBeTruthy();
    expect(screen.getByText("Run 3")).toBeTruthy();
    expect(screen.getAllByText("Training · strong feedback")).toHaveLength(2);
    expect(screen.getByText("3×")).toBeTruthy();
    expect(screen.getByText("fixed")).toBeTruthy();
    expect(screen.getByText("↓ better")).toBeTruthy();
    expect(screen.getByText("↑ worse")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();                             // run 2 without the camera coach
    expect(screen.getByText("90")).toBeTruthy();                            // coach score after run 3
    expect(screen.getByText(/Fading the feedback out/)).toBeTruthy();
  });

  it("lights up the row of the behaviour JJ is talking about", () => {
    const { container } = render(<ProgressView p={progress} focus="sway" />);
    const lit = container.querySelectorAll("[data-focus]");
    expect(lit).toHaveLength(1);
    expect(lit[0]!.textContent).toContain("Moving around / swaying");
  });

  it("the run report links to it after two runs", () => {
    render(<ReportView d={digest} progress={progress} tab="run" onTab={() => {}} />);
    expect(screen.getByText("Progress · 3 runs")).toBeTruthy();
    expect(screen.getByText(/Since run 1:/)).toBeTruthy();
  });
});

describe("Hey JJ by voice", () => {
  it("recognises the wake phrase the way speech recognition writes it", () => {
    for (const t of ["hey JJ", "Hey, J.J.", "okay jay jay what do you think", "hi jj", "hey jayjay", "hej džej džej"]) expect(isWakePhrase(t), t).toBe(true);
    for (const t of ["the jj screen", "hey jessica", "hey jay", "they jj"]) expect(isWakePhrase(t), t).toBe(false);
  });
});
