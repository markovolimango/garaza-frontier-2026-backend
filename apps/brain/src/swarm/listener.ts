/**
 * Listener agent (stub, to be built): a Gemini Live session per run that hears the presenter during
 * the presentation and the Q&A and calls a `report_fillers({phrase, fillers})` tool after every
 * phrase → board `phrase` + `filler` events. Also the feedback rule for fillers (vignette).
 */
import type { SwarmContext } from "./context.ts";

export function installListener(ctx: SwarmContext): void {
  ctx.board.status("listener", "idle", "waiting for a run");
  ctx.board.status("feedback", "idle", "vignette rules ready");
}
