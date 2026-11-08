/**
 * Director agent (stub, to be built): the judges' director. Today it runs the deterministic Q&A
 * Director (director/director.ts, template questions). To be built: LLM questions from the pitch
 * transcript (board phrases), follow-ups on answers, live reactions, JJ's `director.brief` commands.
 */
import { Director } from "../director/director.ts";
import type { SwarmContext } from "./context.ts";

export function installDirector(ctx: SwarmContext): void {
  new Director({ session: ctx.brain.session, hub: ctx.brain.hub, voices: ctx.judges, clock: ctx.clock, log: ctx.log, runLog: ctx.runLog, speechRms: ctx.speechRms });
  ctx.board.status("director", "idle", "template questions");
}
