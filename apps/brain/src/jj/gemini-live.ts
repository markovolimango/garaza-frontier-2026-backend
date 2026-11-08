/**
 * GeminiLiveAgent: the full-duplex JJ voice session over @google/genai `live.connect`.
 *
 * - 16 kHz PCM goes up as realtime input while 24 kHz PCM comes down; the server's VAD
 *   handles barge-in (`serverContent.interrupted`), which we surface via onInterrupted.
 * - Tools are declared BLOCKING unless the registry says otherwise; results are returned
 *   with sendToolResponse (NON_BLOCKING ones carry a scheduling hint).
 * - Session resumption: the latest handle is kept; on `goAway` or an unexpected close we
 *   reconnect with it. If resumption fails we start a fresh session and send the context
 *   text first. Never sends video.
 */
import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality } from "@google/genai";
import type {
  FunctionDeclaration, FunctionResponse, LiveConnectConfig, LiveConnectParameters, LiveSendClientContentParameters,
  LiveSendRealtimeInputParameters, LiveServerMessage,
} from "@google/genai";
import type { ToolName, ToolResult } from "@coach/protocol";
import type {
  ToolDeclaration, VoiceAgent, VoiceAgentState, VoiceConnectContext, VoiceToolCall, VoiceTranscript,
} from "./voice-agent.ts";
import type { JJClock, Logger } from "./ports.ts";
import { base64ToPcm16, pcm16ToBase64 } from "./pcm.ts";

/** The subset of the SDK's `Session` we use (lets tests inject a fake). */
export interface LiveSessionLike {
  sendClientContent(p: LiveSendClientContentParameters): void;
  sendRealtimeInput(p: LiveSendRealtimeInputParameters): void;
  sendToolResponse(p: { functionResponses: FunctionResponse[] }): void;
  close(): void;
}
export type LiveConnectFn = (params: LiveConnectParameters) => Promise<LiveSessionLike>;

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  clock: JJClock;
  log?: Logger;
  /** Override for tests; defaults to `new GoogleGenAI({apiKey}).live.connect`. */
  connectFn?: LiveConnectFn;
  setupTimeoutMs?: number;          // default 10 000
  reconnectBackoffMs?: number[];    // default 250 → 2000 (cap)
}

const DEFAULT_BACKOFF = [250, 500, 1000, 2000];

export class GeminiLiveAgent implements VoiceAgent {
  private readonly connectFn: LiveConnectFn;
  private readonly log: Logger;
  private ctx: VoiceConnectContext | null = null;
  private contextProvider: (() => string) | null = null;

  private session: LiveSessionLike | null = null;
  private generation = 0;           // allocator: one number per provider session attempt
  private activeGen = -1;           // the live session; callbacks from any other session are ignored
  private handle: string | null = null;
  private closedByUs = false;
  private reconnectTimer: unknown = null;
  private reconnectAttempt = 0;
  private reconnecting: Promise<void> | null = null;

  private connected = false;
  private speaking = false;
  private inModelTurn = false;
  private suppressTurn = false;     // interrupt(): drop the rest of the current model turn
  private cancelledCalls = new Set<string>();
  private nonBlocking = new Map<ToolName, ToolDeclaration["scheduling"]>();

  private audioCbs: ((pcm: Int16Array) => void)[] = [];
  private toolCb: ((c: VoiceToolCall) => Promise<ToolResult>) | null = null;
  private transcriptCbs: ((t: VoiceTranscript) => void)[] = [];
  private stateCbs: ((s: VoiceAgentState) => void)[] = [];
  private interruptedCbs: (() => void)[] = [];

  constructor(private readonly opts: GeminiLiveOptions) {
    this.log = opts.log ?? (() => {});
    this.connectFn = opts.connectFn ?? ((p) => new GoogleGenAI({ apiKey: opts.apiKey }).live.connect(p));
  }

  get resumptionHandle(): string | null { return this.handle; }

  // ---------------- VoiceAgent ----------------

  async connect(ctx: VoiceConnectContext): Promise<void> {
    this.ctx = ctx;
    this.closedByUs = false;
    this.nonBlocking = new Map(ctx.tools.filter((t) => t.behavior === "NON_BLOCKING").map((t) => [t.name, t.scheduling]));
    await this.open(this.handle);
  }

  sendAudio(pcm16k: Int16Array): void {
    if (!this.connected || !this.session) return;   // dropped while down; never buffered
    this.session.sendRealtimeInput({ audio: { data: pcm16ToBase64(pcm16k), mimeType: "audio/pcm;rate=16000" } });
  }

  sendText(text: string, opts: { turnComplete: boolean }): void {
    if (!this.session) { this.log("warn", "jj.sendText while disconnected, dropped", { text: text.slice(0, 80) }); return; }
    this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: opts.turnComplete });
  }

  onAudio(cb: (pcm24k: Int16Array) => void): void { this.audioCbs.push(cb); }
  onToolCall(cb: (call: VoiceToolCall) => Promise<ToolResult>): void { this.toolCb = cb; }
  onTranscript(cb: (t: VoiceTranscript) => void): void { this.transcriptCbs.push(cb); }
  onState(cb: (s: VoiceAgentState) => void): void { this.stateCbs.push(cb); }
  onInterrupted(cb: () => void): void { this.interruptedCbs.push(cb); }
  setContextProvider(fn: () => string): void { this.contextProvider = fn; }

  interrupt(): void {
    if (this.inModelTurn) this.suppressTurn = true;
    this.setState({ speaking: false });
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) { this.opts.clock.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.activeGen = -1;
    const s = this.session;
    this.session = null;
    s?.close();
    this.inModelTurn = false;
    this.setState({ connected: false, speaking: false });
  }

  // ---------------- connection management ----------------

  private buildConfig(handle: string | null): LiveConnectConfig {
    const ctx = this.ctx!;
    const functionDeclarations: FunctionDeclaration[] = ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
      behavior: t.behavior === "BLOCKING" ? Behavior.BLOCKING : Behavior.NON_BLOCKING,
    }));
    return {
      responseModalities: [Modality.AUDIO],
      ...(ctx.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ctx.voice } } } } : {}),
      systemInstruction: ctx.systemPrompt,
      tools: [{ functionDeclarations }],
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
  }

  /** Opens a provider session; with a handle, falls back to a fresh one if resumption fails. */
  private async open(handle: string | null): Promise<void> {
    try {
      await this.openOnce(handle);
    } catch (err) {
      if (handle === null) throw err;
      this.log("warn", "jj.resume_failed, starting fresh session", { err: String(err) });
      this.handle = null;
      await this.openOnce(null);
    }
  }

  private openOnce(handle: string | null): Promise<void> {
    const gen = ++this.generation;
    const old = this.session;
    const timeoutMs = this.opts.setupTimeoutMs ?? 10_000;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let pending: LiveSessionLike | null = null;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        this.opts.clock.clearTimeout(timer);
        pending?.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = this.opts.clock.setTimeout(() => fail(new Error("setup timeout")), timeoutMs);

      const onSetup = () => {
        if (settled) return;
        settled = true;
        this.opts.clock.clearTimeout(timer);
        if (this.closedByUs) { pending?.close(); reject(new Error("closed during setup")); return; }
        // swap: the new session is live, the old one (goAway) can go
        this.activeGen = gen;
        this.session = pending;
        if (old && old !== pending) old.close();
        this.inModelTurn = false;
        this.suppressTurn = false;
        this.reconnectAttempt = 0;
        this.setState({ connected: true, speaking: false });
        if (handle === null) {
          const text = this.contextProvider?.() ?? this.ctx!.contextText;
          if (text) this.sendText(text, { turnComplete: false });
        }
        this.log("info", "jj.connected", { resumed: handle !== null });
        resolve();
      };

      this.connectFn({
        model: this.opts.model,
        config: this.buildConfig(handle),
        callbacks: {
          onmessage: (m: LiveServerMessage) => {
            if (m.setupComplete && !settled) { onSetup(); return; }
            if (gen !== this.activeGen) return;
            this.handleMessage(m);
          },
          onerror: (e: { message?: string }) => {
            if (gen !== this.activeGen && settled) return;
            this.log("error", "jj.socket_error", { message: e?.message });
          },
          onclose: (e: { code?: number; reason?: string }) => {
            if (!settled) { fail(new Error(`closed during setup: ${e?.code} ${e?.reason ?? ""}`)); return; }
            if (gen !== this.activeGen) return;   // an old (goAway) session closing after the swap
            this.onUnexpectedClose(e?.code, e?.reason);
          },
        },
      }).then(
        (s) => { pending = s; if (settled) s.close(); },
        fail,
      );
    });
  }

  private onUnexpectedClose(code?: number, reason?: string): void {
    this.activeGen = -1;
    this.session = null;
    this.inModelTurn = false;
    this.setState({ connected: false, speaking: false });
    if (this.closedByUs) return;
    this.log("warn", "jj.closed, reconnecting", { code, reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer || this.reconnecting) return;
    const backoff = this.opts.reconnectBackoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)] ?? 2000;
    this.reconnectAttempt++;
    this.reconnectTimer = this.opts.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = this.open(this.handle).then(
        () => { this.reconnecting = null; },
        (err) => { this.reconnecting = null; this.log("error", "jj.reconnect_failed", { err: String(err) }); this.scheduleReconnect(); },
      );
    }, delay);
  }

  /** goAway: open a resumed session now, before the server cuts the old one. */
  private onGoAway(timeLeft?: string): void {
    this.log("info", "jj.go_away", { timeLeft });
    if (this.reconnecting || this.closedByUs) return;
    this.reconnecting = this.open(this.handle).then(
      () => { this.reconnecting = null; },
      (err) => {
        this.reconnecting = null;
        this.log("error", "jj.go_away_reconnect_failed", { err: String(err) });
        // the old session may still be alive; it will close on its own and trigger a reconnect
        if (!this.session) this.scheduleReconnect();
      },
    );
  }

  // ---------------- server messages ----------------

  private handleMessage(m: LiveServerMessage): void {
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.handle = u.newHandle;
    }
    if (m.goAway) this.onGoAway(m.goAway.timeLeft);
    if (m.toolCallCancellation?.ids) for (const id of m.toolCallCancellation.ids) this.cancelledCalls.add(id);
    if (m.toolCall?.functionCalls) for (const fc of m.toolCall.functionCalls) void this.runTool(fc.id ?? "", fc.name ?? "", fc.args ?? {});

    const sc = m.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) this.emitTranscript({ who: "user", text: sc.inputTranscription.text, final: sc.inputTranscription.finished ?? false });
    if (sc.outputTranscription?.text) this.emitTranscript({ who: "jj", text: sc.outputTranscription.text, final: sc.outputTranscription.finished ?? false });

    if (sc.interrupted) {
      const wasSpeaking = this.speaking;
      this.inModelTurn = false;
      this.suppressTurn = false;
      // interrupted first, so listeners flush the utterance instead of ending it normally
      if (wasSpeaking) for (const cb of this.interruptedCbs) cb();
      this.setState({ speaking: false });
      return;
    }

    for (const part of sc.modelTurn?.parts ?? []) {
      this.inModelTurn = true;
      const d = part.inlineData;
      if (!d?.data || !d.mimeType?.startsWith("audio/")) continue;
      if (this.suppressTurn) continue;
      const pcm = base64ToPcm16(d.data);
      if (pcm.length === 0) continue;
      this.setState({ speaking: true });
      for (const cb of this.audioCbs) cb(pcm);
    }

    if (sc.turnComplete) {
      this.inModelTurn = false;
      this.suppressTurn = false;
      this.setState({ speaking: false });
    }
  }

  private async runTool(id: string, name: string, args: unknown): Promise<void> {
    const session = this.session;
    let result: ToolResult;
    try {
      result = this.toolCb
        ? await this.toolCb({ id, name: name as ToolName, args })
        : { ok: false, reason: "not_available", hint: "no tool handler" };
    } catch (err) {
      result = { ok: false, reason: "internal", hint: String(err) };
    }
    if (this.cancelledCalls.delete(id)) { this.log("info", "jj.tool_cancelled", { id, name }); return; }
    const target = this.session ?? session;
    if (!target) { this.log("warn", "jj.tool_result_dropped (disconnected)", { id, name }); return; }
    const response: FunctionResponse = { id, name, response: result as Record<string, unknown> };
    if (this.nonBlocking.has(name as ToolName)) {
      const s = this.nonBlocking.get(name as ToolName) ?? "WHEN_IDLE";
      response.scheduling = FunctionResponseScheduling[s];
    }
    target.sendToolResponse({ functionResponses: [response] });
  }

  // ---------------- helpers ----------------

  private emitTranscript(t: VoiceTranscript): void { for (const cb of this.transcriptCbs) cb(t); }

  private setState(patch: Partial<VoiceAgentState>): void {
    const next = { connected: patch.connected ?? this.connected, speaking: patch.speaking ?? this.speaking };
    if (next.connected === this.connected && next.speaking === this.speaking) return;
    this.connected = next.connected;
    this.speaking = next.speaking;
    for (const cb of this.stateCbs) cb({ ...next });
  }
}
