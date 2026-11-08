import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsPanel, agentRows, type SwarmAgent } from "../brain/AgentsPanel";

const agents: SwarmAgent[] = [
  { id: "reporter", label: "Reporter · report", state: "idle", detail: "waiting for a run to end", at: 1 },
  { id: "listener", label: "Listener · transcript + fillers", state: "listening", detail: "12 fillers · um ×7", at: 2 },
  { id: "jj", label: "JJ · coach", state: "working", detail: "→ director: tough judges", at: 3 },
  { id: "director", label: "Director · judges", state: "thinking", detail: "picking the next question", at: 4 },
  { id: "body", label: "Body · camera", state: "off", detail: "", at: 5 },
  { id: "feedback", label: "Feedback · vignette", state: "error", detail: "coach offline", at: 6 },
];

describe("agents panel (JJ's team)", () => {
  it("maps swarm.activity agents to rows: JJ first, team order, name + role, active states", () => {
    const rows = agentRows(agents);
    expect(rows.map((r) => r.id)).toEqual(["jj", "listener", "director", "body", "reporter", "feedback"]);
    expect(rows[0]).toEqual({ id: "jj", name: "JJ", role: "coach", state: "working", active: true, detail: "→ director: tough judges" });
    expect(rows[1]).toMatchObject({ name: "Listener", role: "transcript + fillers", active: true });
    expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual(["jj", "listener", "director"]);
  });

  it("corner card: every agent with its detail; active dots pulse; key A collapses and expands", () => {
    localStorage.clear();
    const { container } = render(<AgentsPanel agents={agents} jjScreen={false} />);
    expect(screen.getByText("JJ's team")).toBeTruthy();
    expect(screen.getByText("3 active")).toBeTruthy();
    expect(screen.getByText("12 fillers · um ×7")).toBeTruthy();
    expect(screen.getByText("Director")).toBeTruthy();
    expect(container.querySelector('[data-agent="listener"] .animate-ping')).toBeTruthy();
    expect(container.querySelector('[data-agent="reporter"] .animate-ping')).toBeNull();
    act(() => { fireEvent.keyDown(window, { key: "a" }); });
    expect(screen.queryByText("12 fillers · um ×7")).toBeNull();
    expect(localStorage.getItem("brain.agentsPanel.collapsed")).toBe("1");
    act(() => { fireEvent.keyDown(window, { key: "A" }); });
    expect(screen.getByText("12 fillers · um ×7")).toBeTruthy();
  });

  it("JJ's screen: the large panel with JJ leading the team (plus the corner card for small screens)", () => {
    localStorage.clear();
    render(<AgentsPanel agents={agents} jjScreen />);
    const hero = screen.getByTestId("agents-hero");
    expect(hero.textContent).toContain("JJ's team");
    expect(hero.querySelector('[data-agent="jj"]')!.textContent).toContain("→ director: tough judges");
    expect(hero.querySelectorAll("li[data-agent]")).toHaveLength(5);
    expect(screen.getByTestId("agents-corner")).toBeTruthy();
  });

  it("renders nothing before the first swarm.activity", () => {
    const { container } = render(<AgentsPanel agents={[]} jjScreen />);
    expect(container.innerHTML).toBe("");
  });
});
