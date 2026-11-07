/**
 * JJ wiring. The brain's server.ts calls createJJ() once at startup and then:
 *   - MicRouter: for each frame whose sinks() include "jj" → jj.engine.acceptMic(frame)
 *   - WakeDetector.onWake(t) → jj.engine.noteWakePhrase(t), then session.dispatch({type:"wake", via:"phrase"})
 *   - hub "tool.invoke" (stage, operator) → jj.tools.invoke(tool, args, role)
 *   - operator.override {action:"jj_reconnect"} → jj.engine.reconnect()
 *   - GET /api/tools → jj.tools.catalogue();  GET /health → jj.engine.status()
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolRegistry, createCoachTools, type CoachToolDeps } from "./tools.ts";
import { JJEngine, type WakeTuning } from "./engine.ts";
import { GeminiLiveAgent } from "./gemini-live.ts";
import type { JJConfig } from "./config.ts";
import type { JJClock, Logger, MicPort } from "./ports.ts";
import type { VoiceAgent } from "./voice-agent.ts";

export { JJEngine } from "./engine.ts";
export { GeminiLiveAgent } from "./gemini-live.ts";
export { FakeVoiceAgent } from "./fake-agent.ts";
export { readJJConfig, JJConfig } from "./config.ts";
export type * from "./voice-agent.ts";
export type * from "./ports.ts";

export const JJ_PROMPT_PATH = fileURLToPath(new URL("../../prompts/jj.md", import.meta.url));
export function loadJJPrompt(path = JJ_PROMPT_PATH): string { return readFileSync(path, "utf8"); }

export interface CreateJJOptions extends Omit<CoachToolDeps, "judgeVoices"> {
  config: JJConfig;
  mic: MicPort;
  clock: JJClock;
  log?: Logger;
  /** Inject FakeVoiceAgent in tests or for a voice-less demo. */
  agent?: VoiceAgent;
  systemPrompt?: string;
  wake?: Partial<WakeTuning>;
}

export function createJJ(o: CreateJJOptions): { engine: JJEngine; tools: ToolRegistry; agent: VoiceAgent } {
  const log = o.log ?? (() => {});
  const tools = createCoachTools({ ...o, judgeVoices: o.config.JUDGE_VOICES }, new ToolRegistry(() => o.clock.now(), log));
  const agent = o.agent ?? new GeminiLiveAgent({ apiKey: o.config.GEMINI_API_KEY, model: o.config.GEMINI_LIVE_MODEL, clock: o.clock, log });
  const engine = new JJEngine({
    agent, tools, session: o.session, hub: o.hub, mic: o.mic, reports: o.reports, clock: o.clock, log,
    systemPrompt: o.systemPrompt ?? loadJJPrompt(), voice: o.config.JJ_VOICE,
    wake: { speechRms: o.config.JJ_SPEECH_RMS, ...o.wake },
  });
  return { engine, tools, agent };
}
