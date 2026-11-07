/** viewFor: the single source for what the main app shows (spec: "Brain core", Views table). */
import type { OrbState, SessionState, StageView } from "@coach/protocol";

export function viewFor(s: Readonly<SessionState>): { view: StageView; orb: OrbState } {
  const score = s.coach.score;
  const hidden: OrbState = { visible: false, placement: "center", score };
  switch (s.phase) {
    case "setup":
      return { view: "setup", orb: hidden };
    case "intro":
    case "calibrating":
      return { view: "jj", orb: { visible: true, placement: "center", score } };
    case "running": {
      const phase = s.run?.phase;
      if (phase === "ended" || phase === "aborted") return { view: "report", orb: { visible: true, placement: "side", score } };
      const view: StageView = phase === "qa" ? "room" : "slides";
      return { view, orb: s.run?.paused ? { visible: true, placement: "corner", score } : hidden };
    }
    case "debrief":
      return { view: "report", orb: { visible: true, placement: "side", score } };
    case "final":
      return { view: "final", orb: { visible: true, placement: "side", score } };
  }
}
