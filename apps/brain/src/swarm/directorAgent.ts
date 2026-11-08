/**
 * Director agent: the judges' director (director/agent.ts) driving the Q&A Director
 * (director/director.ts) as its strategy. Plans the questions with the LLM while the presenter
 * presents (board transcript, deck, brief, panel, JJ's `director.brief`), reacts live with
 * gestures, decides follow-up / next / close after each answer, and notes the Q&A to JJ.
 * Without a key (or when Gemini is slow or down) every step falls back to templates and heuristics.
 */
import { DirectorAgent, type DirectorLlm } from "../director/agent.ts";
import { Director } from "../director/director.ts";
import type { SwarmContext } from "./context.ts";
import { llmJson } from "./llm.ts";

export function installDirector(ctx: SwarmContext): { agent: DirectorAgent; director: Director } {
  const { apiKey, text: model } = ctx.models;
  const llm: DirectorLlm | null = apiKey
    ? (c) => llmJson({ apiKey, model, system: c.system, prompt: c.prompt, schema: c.schema, timeoutMs: c.timeoutMs })
    : null;
  const agent = new DirectorAgent({ board: ctx.board, session: ctx.brain.session, hub: ctx.brain.hub, clock: ctx.clock, log: ctx.log, llm });
  const director = new Director({ session: ctx.brain.session, hub: ctx.brain.hub, voices: ctx.judges, clock: ctx.clock, log: ctx.log,
    runLog: ctx.runLog, speechRms: ctx.speechRms, strategy: agent });
  return { agent, director };
}
