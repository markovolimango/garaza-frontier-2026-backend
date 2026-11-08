import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunNarrative, SessionNarrative } from "@coach/protocol";
import { RunAnalysis, RunNarrativeView, SessionNarrativeView } from "../brain/CoachAnalysis";

const run: RunNarrative = {
  runId: "run_2", index: 2, headline: "Clear pitch; drop the “uh” before your numbers.", summary: "You explained the product clearly.",
  strengths: [{ text: "Concrete pricing answer", evidence: "“twenty dollars a month”" }],
  improvements: [{ title: "Fillers before numbers", why: "They blur your strongest facts.", evidence: "“[[Uh]], our customers are [[uh]] mostly startups.”", drill: "Say the customer line with a pause instead of “uh”." }],
  fillers: { count: 14, perMin: 3.2, top: [{ word: "um", count: 6 }, { word: "uh", count: 4 }], examples: ["“So [[um]] we built it.”"], measured: true },
  qa: [{ judge: "VC investor", question: "How do you price it?", answerSummary: "Per seat, $20/month.", verdict: "strong", tip: "Add the margin." },
       { judge: "CTO", question: "What is hard to copy?", answerSummary: "No answer heard.", verdict: "no answer", tip: "Name one moat." }],
  body: [{ kind: "Crossed arms", count: 2, note: "Arms folded while explaining the product." }],
  nextRun: "Same deck, kill the fillers on slide 2.", source: "llm",
};
const session: SessionNarrative = {
  headline: "Fewer fillers, open arms", summary: "Three runs, 9:40 of practice.", progress: ["Filler words: 14 → 5 (3.2 → 1.1/min)"],
  strengths: ["Pricing answers got sharper"], focus: [{ title: "Pauses instead of fillers", why: "Still 5 per run.", drill: "Breathe at every comma." }],
  runs: [{ runId: "run_1", index: 1, headline: "First try" }, { runId: "run_2", index: 2, headline: run.headline }], source: "fallback",
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("coach's analysis", () => {
  it("shows the run narrative: headline, improvements with evidence and drill, fillers, Q&A verdicts, body", () => {
    render(<RunNarrativeView n={run} />);
    expect(screen.getByText(run.headline)).toBeTruthy();
    expect(screen.getByText("Fillers before numbers")).toBeTruthy();
    expect(screen.getAllByText("Uh")[0]!.tagName).toBe("MARK");
    expect(screen.getByText("Say the customer line with a pause instead of “uh”.")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("3.2/min")).toBeTruthy();
    expect(screen.getByText("“um” 6×")).toBeTruthy();
    expect(screen.getByText("strong")).toBeTruthy();
    expect(screen.getByText("no answer")).toBeTruthy();
    expect(screen.getByText("Arms folded while explaining the product.")).toBeTruthy();
    expect(screen.getByText("Same deck, kill the fillers on slide 2.")).toBeTruthy();
    expect(screen.getByText("written by the reporter")).toBeTruthy();
  });

  it("shows the session narrative with the PDF download", () => {
    render(<SessionNarrativeView n={session} pdfHref="http://b/api/swarm/report/session.pdf?download=1" />);
    expect(screen.getByText("Fewer fillers, open arms")).toBeTruthy();
    expect(screen.getByText("Pauses instead of fillers")).toBeTruthy();
    expect(screen.getByText("Filler words: 14 → 5 (3.2 → 1.1/min)")).toBeTruthy();
    expect(screen.getByText("from the measurements")).toBeTruthy();
    expect(screen.getByText("Download PDF").getAttribute("href")).toBe("http://b/api/swarm/report/session.pdf?download=1");
  });

  it("polls while the reporter writes, then shows the report", async () => {
    vi.useFakeTimers();
    const replies = [{ status: "pending", report: null }, { status: "pending", report: null }, { status: "ready", report: run }];
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => replies.shift() ?? { status: "ready", report: run } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RunAnalysis httpBase="http://b" runId="run_2" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/The reporter is writing/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText(/The reporter is writing/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText(run.headline)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://b/api/swarm/report/run/run_2");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);                 // ready: stops polling
  });
});
