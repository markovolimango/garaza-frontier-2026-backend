/**
 * Orchestrator (stub, to be built): JJ leads the swarm. JJ's tools issue board commands
 * (director.brief, feedback.policy, report.make, ask an agent); agents' `agent.note`s reach JJ.
 */
import type { SwarmContext } from "./context.ts";

export function installOrchestrator(ctx: SwarmContext): void {
  ctx.board.status("jj", ctx.brain.jj.status().connected ? "idle" : "off", "");
}
