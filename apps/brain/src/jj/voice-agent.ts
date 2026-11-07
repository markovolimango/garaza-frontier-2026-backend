import type { ToolName, ToolResult } from "@coach/protocol";

/** Provider-neutral tool declaration (generated from the ToolRegistry). */
export interface ToolDeclaration {
  name: ToolName;
  description: string;
  /** JSON Schema of the args, from z.toJSONSchema(spec.args). */
  parameters: Record<string, unknown>;
  behavior: "BLOCKING" | "NON_BLOCKING";
  /**
   * How a NON_BLOCKING result re-enters the conversation (Gemini FunctionResponseScheduling).
   * Ignored for BLOCKING tools. Default "WHEN_IDLE".
   */
  scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT";
}

export interface VoiceToolCall { id: string; name: ToolName; args: unknown }
export interface VoiceTranscript { who: "user" | "jj"; text: string; final: boolean }
export interface VoiceAgentState { connected: boolean; speaking: boolean }

export interface VoiceConnectContext {
  systemPrompt: string;
  tools: ToolDeclaration[];
  /** Sent first whenever a *fresh* (non-resumed) provider session starts. */
  contextText: string;
  voice: string;
}

/**
 * Spec: "JJ adapter and tools". Full duplex: audio flows in while audio flows out, and the
 * provider may barge-in (user talks over JJ) at any time.
 *
 * Extensions over the spec interface (agents-lane only, not protocol):
 *  - onInterrupted: the provider stopped JJ mid-utterance because the user spoke, so the
 *    stage must flush source 0 (`audio.stop`).
 *  - setContextProvider: lets a fresh reconnect send up-to-date context instead of the
 *    context captured at connect().
 */
export interface VoiceAgent {
  connect(ctx: VoiceConnectContext): Promise<void>;
  sendAudio(pcm16k: Int16Array): void;
  sendText(text: string, opts: { turnComplete: boolean }): void;
  onAudio(cb: (pcm24k: Int16Array) => void): void;
  onToolCall(cb: (call: VoiceToolCall) => Promise<ToolResult>): void;
  onTranscript(cb: (t: VoiceTranscript) => void): void;
  onState(cb: (s: VoiceAgentState) => void): void;
  onInterrupted(cb: () => void): void;
  setContextProvider(fn: () => string): void;
  /** Stop current JJ speech (e.g. a run starts). */
  interrupt(): void;
  close(): Promise<void>;
}
