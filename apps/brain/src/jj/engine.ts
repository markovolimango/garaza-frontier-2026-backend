/**
 * JJEngine: the brain-side full-duplex controller around a VoiceAgent.
 *
 * Uplink  (mic → JJ): frames are forwarded only while MicRouter includes "jj"; on a
 *   mid-run wake the engine first sends the wake note, then the buffered audio from
 *   300 ms before the phrase, then live audio.
 * Downlink (JJ → stage): JJ audio goes on source 0 with `actor.say {actorId:"jj"}` at each
 *   utterance start and an empty end-flagged frame at its end; barge-in or a run start
 *   flushes it with `audio.stop`.
 * Control: tool calls go to the shared ToolRegistry; session changes drive greeting,
 *   debrief (`[RUN ENDED] …`), interrupt on run start, and auto-resume after a wake.
 * Captions: the agent's transcripts become `jj.transcript` lines (TranscriptRelay) while JJ may
 *   talk (outside runs, or woken), so the stage can show what JJ and the user said.
 *
 * Spec sections: "JJ adapter and tools", "Speech pipeline" (wake sequence).
 */
import { AUDIO_FLAG, AUDIO_SOURCE, type JJState, type RunId, type SceneOp, type SessionState } from "@coach/protocol";
import type { ToolRegistry } from "./tools.ts";
import type { VoiceAgent } from "./voice-agent.ts";
import type { HubPort, JJClock, Logger, MicPort, ReportsPort, SessionActionLike, SessionPort } from "./ports.ts";
import { buildContextText, deckNote, runAbortedNote, runEndedMessage, sessionStartNote, uiActionNote, wakeNote } from "./messages.ts";
import { rms } from "./pcm.ts";
import { TranscriptRelay } from "./transcript.ts";

export interface JJEngineOptions {
  agent: VoiceAgent;
  tools: ToolRegistry;
  session: SessionPort;
  hub: HubPort;
  mic: MicPort;
  reports: ReportsPort;
  clock: JJClock;
  systemPrompt: string;
  voice: string;
  log?: Logger;
  wake?: Partial<WakeTuning>;
  /** Retry delay when the initial connect fails. Default 5000 ms. */
  connectRetryMs?: number;
}

export interface WakeTuning {
  /** Pre-roll before the wake phrase in the replayed audio. Spec: 300 ms. */
  preRollMs: number;
  /** Resume after JJ finished and the user was silent this long. Spec: 2.5 s. */
  silenceMs: number;
  /** Resume anyway if JJ never answers within this long of silence (safety net). */
  noReplyMs: number;
  /** Mic frame RMS above which the user counts as speaking. */
  speechRms: number;
  /** How often the auto-resume condition is checked. */
  tickMs: number;
}

const DEFAULT_WAKE: WakeTuning = { preRollMs: 300, silenceMs: 2500, noReplyMs: 10_000, speechRms: 700, tickMs: 100 };
const FRAME_SAMPLES_16K = 320;     // 20 ms at 16 kHz
const OUT_RATE = 24_000;
const JJ_PHASES = new Set<SessionState["phase"]>(["intro", "calibrating", "running", "debrief", "final"]);
/** Tools whose invocation from the UI is worth telling JJ about. */
const SILENT_TOOLS = new Set(["highlight_pattern", "get_last_run_report", "get_session_state", "ask_agent"]);
/** Agent notes kept for later (a run, JJ talking); the oldest go first when more arrive. */
const MAX_PENDING_NOTES = 20;

interface PendingNote { text: string; speak: boolean }

interface Utterance { id: string; seq: number }
interface WakeTracking { since: number; jjSpoke: boolean; lastUserVoice: number; timer: unknown }

export class JJEngine {
  private readonly o: JJEngineOptions;
  private readonly wakeCfg: WakeTuning;
  private readonly log: Logger;

  private agentConnected = false;
  private agentSpeaking = false;
  private lastState: JJState | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: unknown = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;

  private utterance: Utterance | null = null;
  private seq = 0;
  private utteranceCount = 0;
  /** Estimated wall time when JJ's queued audio finishes playing on the stage. */
  private jjAudioUntil = 0;

  private wake: WakeTracking | null = null;
  private pendingPhraseStart: number | null = null;
  private reportedRuns = new Set<RunId>();
  private prevRunPhase: string | null = null;
  private readonly captions: TranscriptRelay;
  /** Swarm agents' notes waiting for JJ (agentNote): held during runs and while JJ talks. */
  private notes: PendingNote[] = [];
  private notesFlushing = false;

  constructor(opts: JJEngineOptions) {
    this.o = opts;
    this.wakeCfg = { ...DEFAULT_WAKE, ...opts.wake };
    this.log = opts.log ?? (() => {});
    this.captions = new TranscriptRelay({
      clock: opts.clock,
      send: (line) => {
        if (line.final) this.log("debug", "jj.transcript", { who: line.who, text: line.text });
        this.o.hub.broadcast(["stage", "operator"], { type: "jj.transcript", payload: line });
      },
    });
  }

  // ---------------- lifecycle ----------------

  start(): void {
    if (this.started) return;
    this.started = true;
    const { agent, tools, session } = this.o;

    agent.setContextProvider(() => buildContextText(session.get(), (id) => this.o.reports.compactRunReport(id)));
    agent.onAudio((pcm) => this.onAgentAudio(pcm));
    agent.onState((st) => this.onAgentState(st.connected, st.speaking));
    agent.onInterrupted(() => this.onBargeIn());
    agent.onToolCall((call) => tools.invoke(call.name, call.args, "jj"));
    agent.onTranscript((t) => {
      if (t.who === "user" && this.wake && t.text.trim()) this.wake.lastUserVoice = this.o.clock.now();
      if (this.captionsAllowed(t.who)) this.captions.push(t.who, t.text, t.final, t.who === "jj" ? this.utterance?.id : undefined);
    });

    tools.onInvoked((i) => {
      if (i.caller === "jj" || !i.result.ok || SILENT_TOOLS.has(i.name) || !this.agentConnected) return;
      this.o.agent.sendText(uiActionNote(i.caller, i.name, i.args, i.result), { turnComplete: false });
    });

    const s0 = session.get();
    this.prevRunPhase = s0.run?.phase ?? null;
    for (const id of s0.completedRuns) this.reportedRuns.add(id);
    this.unsubscribe = session.subscribe((s, cause) => this.onSession(s, cause));
    // Brain restarted mid-session: connect, after the current tick, so tools registered right after
    // createBrain() (the swarm's) are in the declarations.
    queueMicrotask(() => { if (this.started && JJ_PHASES.has(this.o.session.get().phase)) this.withAgent(() => {}); });
    this.publishState();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearWake();
    this.captions.clear();
    if (this.retryTimer) { this.o.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
    await this.o.agent.close();
    this.started = false;
  }

  /** Operator `jj_reconnect`. */
  async reconnect(): Promise<void> {
    this.log("info", "jj.reconnect_requested");
    await this.o.agent.close();
    this.connecting = null;
    await this.ensureConnected().catch(() => {});
  }

  /** For GET /health and state.snapshot. */
  status(): JJState { return { connected: this.agentConnected, listening: this.listening(), speaking: this.agentSpeaking }; }

  // ---------------- mic uplink ----------------

  /** Called by MicRouter for every 16 kHz frame routed to the "jj" sink. */
  acceptMic(pcm16k: Int16Array): void {
    if (!this.agentConnected || !this.listening()) return;
    this.o.agent.sendAudio(pcm16k);
    if (this.wake && rms(pcm16k) >= this.wakeCfg.speechRms) this.wake.lastUserVoice = this.o.clock.now();
  }

  /** WakeDetector: phrase start time, called just before it dispatches `wake`. */
  noteWakePhrase(phraseStart: number): void { this.pendingPhraseStart = phraseStart; }

  // ---------------- swarm agents → JJ ----------------

  /**
   * A note from a swarm agent ("[DIRECTOR] …"), added to JJ's context as a system note.
   * During a run (not woken) it waits and reaches JJ with the debrief (or a wake), as context only;
   * while JJ talks it waits for the end of JJ's turn. `speak` outside runs ends the turn, so JJ says it.
   * Dropped before the session starts (JJ is not there yet).
   */
  agentNote(text: string, speak = false): void {
    const s = this.o.session.get();
    if (s.phase === "setup") { this.log("debug", "jj.agent_note_dropped", { text: text.slice(0, 80) }); return; }
    const inRun = s.phase === "running";
    this.notes.push({ text, speak: speak && !inRun });
    if (this.notes.length > MAX_PENDING_NOTES) this.notes.splice(0, this.notes.length - MAX_PENDING_NOTES);
    this.flushNotes();
  }

  /** Agent notes not yet given to JJ (the agents panel shows them as "for the debrief"). */
  pendingNotes(): number { return this.notes.length; }

  /** Gives the waiting notes to JJ when it may hear them: outside runs or woken, and not mid-turn. */
  private flushNotes(): void {
    if (!this.notes.length || this.notesFlushing || !this.speechAllowed() || this.agentSpeaking) return;
    this.notesFlushing = true;
    this.ensureConnected().then(() => {
      if (!this.agentConnected || !this.speechAllowed() || this.agentSpeaking) return;
      const batch = this.notes;
      this.notes = [];
      // While woken, a turn follows anyway (the wake): notes are context then.
      const speak = this.o.session.get().phase !== "running" && batch.some((n) => n.speak);
      batch.forEach((n, i) => this.o.agent.sendText(n.text, { turnComplete: speak && i === batch.length - 1 }));
      this.log("info", "jj.agent_notes", { count: batch.length, speak });
    }, () => {}).finally(() => {
      this.notesFlushing = false;
      // notes that came in meanwhile; without a connection they wait for the next state change
      if (this.notes.length && this.agentConnected) this.flushNotes();
    });
  }

  // ---------------- session events ----------------

  private onSession(s: SessionState, cause: SessionActionLike | SceneOp[]): void {
    const action = Array.isArray(cause) ? null : cause;
    if (action?.type === "reset") this.notes = [];
    else this.flushNotes();   // before [RUN ENDED] / the wake note, so JJ has them for that turn
    switch (action?.type) {
      case "session_start":
        if (s.phase !== "setup") this.withAgent(() => this.say(sessionStartNote(this.o.session.get()), true));
        break;
      case "context":   // slides uploaded while JJ talks (the session may start before the deck)
        if ((action as { patch?: { deck?: unknown } }).patch?.deck && (s.phase === "intro" || s.phase === "debrief")) {
          this.withAgent(() => this.o.agent.sendText(deckNote(s), { turnComplete: false }));
        }
        break;
      case "reset":
        this.clearWake();
        this.stopJJAudio();
        this.captions.end();
        void this.o.agent.close();
        this.reportedRuns.clear();
        break;
      case "start_run":
      case "run_it_back":
        if (s.phase === "running") { this.clearWake(); this.stopJJAudio(); this.captions.end(); this.o.agent.interrupt(); }
        break;
      case "wake":
        if (s.wake.active && s.run?.paused && !this.wake) this.beginWake(s);
        break;
    }
    if (this.wake && !s.wake.active) this.clearWake();   // resumed by tool, operator, run end …

    this.detectRunEnd(s);
    this.publishState();
  }

  private detectRunEnd(s: SessionState): void {
    const run = s.run;
    const prev = this.prevRunPhase;
    this.prevRunPhase = run?.phase ?? null;
    if (!run) return;
    if (run.phase === "aborted" && prev !== "aborted") {
      this.withAgent(() => this.say(runAbortedNote(run.runId), true));
      return;
    }
    // Debrief starts once the run is ended and in completedRuns (spec: running: ended → debrief).
    if (s.phase === "debrief" && run.phase === "ended" && s.completedRuns.includes(run.runId) && !this.reportedRuns.has(run.runId)) {
      this.reportedRuns.add(run.runId);
      const report = this.o.reports.compactRunReport(run.runId);
      this.withAgent(() => this.say(runEndedMessage(run.runId, report), true));
    }
  }

  // ---------------- wake ----------------

  private beginWake(s: SessionState): void {
    const now = this.o.clock.now();
    const phraseStart = s.wake.via === "phrase" ? this.pendingPhraseStart ?? s.wake.since ?? now : null;
    this.pendingPhraseStart = null;
    this.wake = { since: now, jjSpoke: false, lastUserVoice: now, timer: null };
    this.withAgent(() => {
      if (!this.wake) return;
      this.say(wakeNote(this.o.session.get()), false);
      if (phraseStart !== null) {
        const buffered = this.o.mic.replaySince(phraseStart - this.wakeCfg.preRollMs);
        for (let i = 0; i < buffered.length; i += FRAME_SAMPLES_16K) this.o.agent.sendAudio(buffered.subarray(i, i + FRAME_SAMPLES_16K));
      }
    });
    this.scheduleWakeTick();
    this.log("info", "jj.woken", { via: s.wake.via, phraseStart });
  }

  private scheduleWakeTick(): void {
    if (!this.wake) return;
    this.wake.timer = this.o.clock.setTimeout(() => this.wakeTick(), this.wakeCfg.tickMs);
  }

  private wakeTick(): void {
    const w = this.wake;
    if (!w) return;
    w.timer = null;
    const now = this.o.clock.now();
    const jjBusy = this.agentSpeaking || now < this.jjAudioUntil;
    const quietSince = Math.max(w.lastUserVoice, this.jjAudioUntil);
    const resume =
      (w.jjSpoke && !jjBusy && now - quietSince >= this.wakeCfg.silenceMs) ||
      (!w.jjSpoke && !jjBusy && now - quietSince >= this.wakeCfg.noReplyMs);
    if (resume) {
      this.log("info", "jj.auto_resume", { jjSpoke: w.jjSpoke });
      const r = this.o.session.dispatch({ type: "resume" });
      if (!r.ok) this.log("warn", "jj.auto_resume_refused", { reason: r.reason });
      this.clearWake();
      return;
    }
    this.scheduleWakeTick();
  }

  private clearWake(): void {
    if (this.wake?.timer) this.o.clock.clearTimeout(this.wake.timer);
    this.wake = null;
  }

  // ---------------- downlink audio ----------------

  /** Captions follow speech: a line in progress continues; a new one starts only while JJ may talk (or JJ's utterance still plays). */
  private captionsAllowed(who: "user" | "jj"): boolean {
    if (this.captions.isOpen(who)) return true;
    return this.speechAllowed() || (who === "jj" && this.utterance !== null);
  }

  /** JJ may talk outside runs, while woken, or to finish an utterance it began while allowed. */
  private speechAllowed(): boolean {
    const s = this.o.session.get();
    if (s.phase === "setup") return false;
    if (s.phase !== "running") return true;
    return s.wake.active && s.run?.paused === true;
  }

  private onAgentAudio(pcm: Int16Array): void {
    const now = this.o.clock.now();
    if (!this.utterance) {
      if (!this.speechAllowed()) return;   // e.g. a late reply after the run resumed
      this.seq = (this.seq + 1) & 0xffff;
      this.utterance = { id: `jj_u${++this.utteranceCount}`, seq: this.seq };
      this.o.hub.send("stage", { type: "actor.say", payload: { actorId: "jj", utteranceId: this.utterance.id, source: 0, text: "" } });
      this.o.hub.sendAudio(AUDIO_SOURCE.jj, AUDIO_FLAG.utteranceStart, this.seq, pcm);
    } else {
      this.o.hub.sendAudio(AUDIO_SOURCE.jj, 0, this.utterance.seq, pcm);
    }
    this.jjAudioUntil = Math.max(this.jjAudioUntil, now) + (pcm.length / OUT_RATE) * 1000;
    if (this.wake) this.wake.jjSpoke = true;
  }

  private endUtterance(): void {
    if (!this.utterance) return;
    this.o.hub.sendAudio(AUDIO_SOURCE.jj, AUDIO_FLAG.utteranceEnd, this.utterance.seq, new Int16Array(0));
    this.utterance = null;
  }

  /** Flush JJ's audio on the stage (barge-in, run start). */
  private stopJJAudio(): void {
    const u = this.utterance;
    this.utterance = null;
    this.jjAudioUntil = 0;
    this.captions.end("jj");
    if (u) this.o.hub.send("stage", { type: "audio.stop", payload: { source: AUDIO_SOURCE.jj, utteranceId: u.id } });
  }

  private onBargeIn(): void {
    this.log("info", "jj.barge_in");
    this.stopJJAudio();
  }

  private onAgentState(connected: boolean, speaking: boolean): void {
    const wasConnected = this.agentConnected;
    this.agentConnected = connected;
    this.agentSpeaking = speaking;
    if (!speaking) this.endUtterance();
    if (wasConnected && !connected) {
      this.stopJJAudio();
      if (this.started) this.o.hub.send("stage", { type: "hud.toast", payload: { text: "JJ is reconnecting", level: "warn" } });
    }
    this.publishState();
    if (connected && !speaking) this.flushNotes();   // notes held while JJ talked
  }

  // ---------------- connection ----------------

  private ensureConnected(): Promise<void> {
    if (this.agentConnected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const { agent, tools, session } = this.o;
    this.connecting = agent
      .connect({
        systemPrompt: this.o.systemPrompt,
        tools: tools.declarations(),
        contextText: buildContextText(session.get(), (id) => this.o.reports.compactRunReport(id)),
        voice: this.o.voice,
      })
      .catch((err) => {
        this.log("error", "jj.connect_failed", { err: String(err) });
        this.o.hub.send("stage", { type: "hud.toast", payload: { text: "JJ is offline. The buttons still work.", level: "warn" } });
        this.scheduleRetry();
        throw err;
      })
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;
    this.retryTimer = this.o.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.started && JJ_PHASES.has(this.o.session.get().phase)) void this.ensureConnected().catch(() => {});
    }, this.o.connectRetryMs ?? 5000);
  }

  /** Runs fn once JJ is connected; connect failures are already logged and retried. */
  private withAgent(fn: () => void): void {
    this.ensureConnected().then(fn, () => {});
  }

  private say(text: string, turnComplete: boolean): void {
    if (!this.agentConnected) { this.log("warn", "jj.note_dropped", { text: text.slice(0, 60) }); return; }
    this.o.agent.sendText(text, { turnComplete });
  }

  // ---------------- state ----------------

  private listening(): boolean { return this.o.mic.sinks().includes("jj"); }

  private publishState(): void {
    const st = this.status();
    const l = this.lastState;
    if (l && l.connected === st.connected && l.listening === st.listening && l.speaking === st.speaking) return;
    this.lastState = st;
    this.o.hub.broadcast(["stage", "operator"], { type: "jj.state", payload: st });
  }
}
