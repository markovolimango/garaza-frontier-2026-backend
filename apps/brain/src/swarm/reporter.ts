/**
 * Reporter agent (stub, to be built): after each run and at the end of the session, an LLM writes
 * the report as JSON (for the stage) from the board (transcript, judges, video notes) and the RunLog,
 * plus a downloadable PDF.
 */
import type { SwarmContext } from "./context.ts";

export function installReporter(ctx: SwarmContext): void {
  ctx.board.status("reporter", "idle", "waiting for a run to end");
}
