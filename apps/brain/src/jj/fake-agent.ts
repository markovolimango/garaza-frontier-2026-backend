/**
 * FakeVoiceAgent: scripted stand-in for tests and voice-outage demos. Records what the brain
 * sends, and lets a test drive JJ: emit audio, tool calls, transcripts, barge-in, disconnects.
 */
import type { ToolResult } from "@coach/protocol";
import type {
  VoiceAgent, VoiceAgentState, VoiceConnectContext, VoiceToolCall, VoiceTranscript,
} from "./voice-agent.ts";

export class FakeVoiceAgent implements VoiceAgent {
  readonly sentAudio: Int16Array[] = [];
  readonly sentText: { text: string; turnComplete: boolean }[] = [];
  readonly connects: VoiceConnectContext[] = [];
  interrupts = 0;
  closes = 0;
  /** Set to make the next connect() reject. */
  failNextConnect: Error | null = null;
  contextProvider: (() => string) | null = null;

  private state: VoiceAgentState = { connected: false, speaking: false };
  private audioCbs: ((p: Int16Array) => void)[] = [];
  private toolCb: ((c: VoiceToolCall) => Promise<ToolResult>) | null = null;
  private transcriptCbs: ((t: VoiceTranscript) => void)[] = [];
  private stateCbs: ((s: VoiceAgentState) => void)[] = [];
  private interruptedCbs: (() => void)[] = [];
  private callSeq = 0;

  async connect(ctx: VoiceConnectContext): Promise<void> {
    this.connects.push(ctx);
    if (this.failNextConnect) { const e = this.failNextConnect; this.failNextConnect = null; throw e; }
    this.setState({ connected: true });
  }
  sendAudio(pcm16k: Int16Array): void { if (this.state.connected) this.sentAudio.push(pcm16k); }
  sendText(text: string, opts: { turnComplete: boolean }): void { this.sentText.push({ text, turnComplete: opts.turnComplete }); }
  onAudio(cb: (p: Int16Array) => void): void { this.audioCbs.push(cb); }
  onToolCall(cb: (c: VoiceToolCall) => Promise<ToolResult>): void { this.toolCb = cb; }
  onTranscript(cb: (t: VoiceTranscript) => void): void { this.transcriptCbs.push(cb); }
  onState(cb: (s: VoiceAgentState) => void): void { this.stateCbs.push(cb); }
  onInterrupted(cb: () => void): void { this.interruptedCbs.push(cb); }
  setContextProvider(fn: () => string): void { this.contextProvider = fn; }
  interrupt(): void { this.interrupts++; this.setState({ speaking: false }); }
  async close(): Promise<void> { this.closes++; this.setState({ connected: false, speaking: false }); }

  // ---------- test drivers ----------
  get connected(): boolean { return this.state.connected; }
  /** JJ speaks: emits one chunk of 24 kHz audio (default 100 ms of silence-ish samples). */
  speak(samples = 2400): void {
    this.setState({ speaking: true });
    const pcm = new Int16Array(samples).fill(100);
    for (const cb of this.audioCbs) cb(pcm);
  }
  finishTurn(): void { this.setState({ speaking: false }); }
  bargeIn(): void { for (const cb of this.interruptedCbs) cb(); this.setState({ speaking: false }); }
  transcript(t: VoiceTranscript): void { for (const cb of this.transcriptCbs) cb(t); }
  drop(): void { this.setState({ connected: false, speaking: false }); }
  async callTool(name: string, args: unknown = {}): Promise<ToolResult> {
    if (!this.toolCb) throw new Error("no tool handler");
    return this.toolCb({ id: `call_${++this.callSeq}`, name: name as VoiceToolCall["name"], args });
  }
  textsMatching(re: RegExp): string[] { return this.sentText.map((t) => t.text).filter((t) => re.test(t)); }

  private setState(p: Partial<VoiceAgentState>): void {
    const next = { ...this.state, ...p };
    if (next.connected === this.state.connected && next.speaking === this.state.speaking) return;
    this.state = next;
    for (const cb of this.stateCbs) cb({ ...next });
  }
}
