/**
 * Listener agent: one Gemini Live session per run that hears the presenter during the presentation
 * and the Q&A. The model is told to stay silent and to call `report_fillers({phrase, fillers})` after
 * every phrase (measured: ~2 s after the phrase ends, fillers kept, phrase verbatim; plain input
 * transcription drops fillers). Each call → board `phrase` (+ `filler` when there were fillers), and
 * ≥ 2 fillers within 10 s → one `filler_burst` observation (rule `speech.fillers`) in the RunLog, so
 * fillers reach the run report, the progress and the coach's targets. Also installs the feedback
 * agent (feedback.ts: the filler vignette).
 *
 * Audio gate: every 16 kHz mic frame (hub.onMic, whatever the routing) goes up only while the run is
 * live (presentation / qa), not paused (the presenter is talking to JJ), no judge is speaking
 * (`actor.say` judge_N until its `audio.playback` ended/stopped or `actor.gesture` idle; an estimate
 * from the text otherwise) and JJ is not speaking, plus a `tailMs` echo tail after each of those.
 * When the gate closes, `audioStreamEnd` flushes the model's VAD. Phrase times come from the gate's
 * own RMS segmentation (speech start/stop), so they are approximate.
 *
 * The session closes `graceMs` after the run ends (to catch the last phrase), reconnects with
 * backoff if it drops while the run is live, and never throws: no key → status "off".
 */
import { Modality } from "@google/genai";
import type { LiveConnectParameters, LiveSendRealtimeInputParameters, LiveServerMessage } from "@google/genai";
import type { DownlinkMessage, JudgeId, RunId, SessionState, Uplink } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import { pcm16ToBase64, rms } from "../jj/pcm.ts";
import type { Logger } from "../log.ts";
import type { Observation, RunLog } from "../runlog.ts";
import type { SessionCause } from "../session.ts";
import type { Phrase, SwarmBoard } from "./board.ts";
import type { SwarmContext } from "./context.ts";
import { FillerFeedback } from "./feedback.ts";
import { gemini } from "./llm.ts";

/** The subset of the SDK's Live `Session` the listener uses (tests inject a fake). */
export interface ListenerSessionLike {
  sendRealtimeInput(p: LiveSendRealtimeInputParameters): void;
  sendToolResponse(p: { functionResponses: { id?: string; name?: string; response?: Record<string, unknown> }[] }): void;
  close(): void;
}
export type ListenerConnectFn = (params: LiveConnectParameters) => Promise<ListenerSessionLike>;

export interface ListenerHub {
  onMic(fn: (pcm16k: Int16Array) => void): void;
  onOutbound(fn: (msg: DownlinkMessage, roles: unknown[]) => void): void;
  on(type: "audio.playback", handler: (msg: Uplink<"audio.playback">) => void): void;
}
export interface ListenerSession {
  get(): Readonly<SessionState>;
  subscribe(fn: (s: SessionState, cause: SessionCause) => void): unknown;
}

export interface ListenerOptions {
  board: SwarmBoard;
  session: ListenerSession;
  hub: ListenerHub;
  runLog: Pick<RunLog, "addObservation">;
  clock: Clock;
  log?: Logger;
  apiKey: string | null;
  model: string;
  /** Mic RMS (Int16) that counts as speech, for the phrase times. Default 700. */
  speechRms?: number;
  /** Defaults to gemini(apiKey).live.connect. */
  connect?: ListenerConnectFn;
  /** Echo tail after a judge / JJ stops or the pause ends. Default 400 ms. */
  tailMs?: number;
  /** Keep the session this long after the run ends, for the last report. Default 3000 ms. */
  graceMs?: number;
  setupTimeoutMs?: number;          // 10 000
  backoffMs?: number[];             // 500 → 5000
  maxAttempts?: number;             // reconnect attempts per drop streak, default 6
  /** Fillers within this window make a burst (RunLog observation). Default 10 s, ≥ 2 fillers. */
  burstWindowMs?: number;
  burstMin?: number;
}

export const LISTENER_PROMPT = [
  "You are a silent filler-word detector listening to a presenter.",
  "Every time the presenter finishes a phrase, call report_fillers with the phrase verbatim (keep the filler words in it)",
  "and the filler words you heard in it (um, uh, er, ah, like, you know, so at the start, I mean, basically),",
  "exactly as often as they occurred; call it with an empty list if there were none.",
  "Never speak. Never answer the presenter. Only call report_fillers.",
].join(" ");

export const REPORT_FILLERS_TOOL = {
  name: "report_fillers",
  description: "Filler words heard in the last phrase the presenter said, and the phrase itself.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      fillers: { type: "array", items: { type: "string" }, description: "each filler word as often as it occurred" },
      phrase: { type: "string", description: "the phrase, verbatim, with the filler words" },
    },
    required: ["fillers"],
  },
};

export function listenerConfig(): LiveConnectParameters["config"] & object {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: LISTENER_PROMPT,
    tools: [{ functionDeclarations: [REPORT_FILLERS_TOOL] }],
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 400 } },
    contextWindowCompression: { slidingWindow: {} },
  };
}

const MIME = "audio/pcm;rate=16000";
const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 5000];
const SEG_SILENCE_MS = 400;
const FRAME_MS = 20;
const MAX_SEGS = 200;
const JJ_SPEAKING_CAP_MS = 30_000;
/** Speaking rate used to place a phrase inside a longer speech segment. */
const MS_PER_WORD = 380;

interface SpeechSeg { start: number; end: number }
interface OpenSeg { start: number; lastVoice: number }

interface LiveRun {
  runId: RunId;
  runIndex: number;
  session: ListenerSessionLike | null;
  connecting: boolean;
  closing: boolean;                 // run over: grace period before close
  graceTimer: unknown;
  retryTimer: unknown;
  attempts: number;
  lastError: string | null;
  gaveUp: boolean;                  // too many failed connects: off for the rest of this run
  phrases: number;
  fillers: Map<string, number>;
  fillerTimes: number[];            // for bursts (RunLog); only after the last burst
  bursts: number;
  segs: SpeechSeg[];                // speech the gate let through (RMS), completed
  cur: OpenSeg | null;              // speech under way
  cursor: number;                   // end of the last phrase placed
  slides: { at: number; index: number }[];
  qaAt: number | null;
}

const isLive = (s: Readonly<SessionState>) => s.phase === "running" && !!s.run && (s.run.phase === "presentation" || s.run.phase === "qa");

export class Listener {
  private readonly log: Logger;
  private readonly connectFn: ListenerConnectFn | null;
  private cur: LiveRun | null = null;
  private gen = 0;
  private gateOpen = false;
  private blockedUntil = 0;
  private wasPaused = false;
  /** utteranceId → who is speaking on the stage's speakers, and a safety deadline. */
  private readonly speaking = new Map<string, { actorId: JudgeId | "jj"; until: number }>();
  private gateTimer: unknown = null;

  constructor(private readonly o: ListenerOptions) {
    this.log = o.log ?? (() => {});
    this.connectFn = o.apiKey ? (o.connect ?? ((p) => gemini(o.apiKey!).live.connect(p))) : null;
    if (!this.connectFn) { o.board.status("listener", "off", "no Gemini key · fillers not tracked"); return; }
    o.board.status("listener", "idle", "waiting for a run");
    o.session.subscribe((s, cause) => this.onSession(s, cause));
    o.hub.onMic((pcm) => this.onMic(pcm));
    o.hub.onOutbound((msg) => this.onOutbound(msg));
    o.hub.on("audio.playback", (m) => { if (m.payload.state !== "started") this.speechDone(m.payload.utteranceId); });
  }

  /** For tests and the smoke script. */
  get runId(): RunId | null { return this.cur?.runId ?? null; }
  get connected(): boolean { return !!this.cur?.session; }
  get gate(): boolean { return this.gateOpen; }

  // ---------------- run lifecycle ----------------

  private onSession(s: Readonly<SessionState>, cause: SessionCause): void {
    const now = this.o.clock.now();
    const run = s.run;
    if (this.wasPaused && !run?.paused) this.block(now + this.tail());
    this.wasPaused = !!run?.paused;
    if (!Array.isArray(cause) && cause.type === "reset") { this.shutdown("reset"); this.idle(); return; }
    if (isLive(s)) {
      if (!this.cur || this.cur.runId !== run!.runId) {
        if (this.cur) this.shutdown("new run");
        this.start(run!.runId, run!.index, run!.slideIndex);
      }
      const r = this.cur!;
      if (r.slides.at(-1)!.index !== run!.slideIndex) r.slides.push({ at: now, index: run!.slideIndex });
      if (run!.phase === "qa" && r.qaAt === null) r.qaAt = now;
    } else if (this.cur && !this.cur.closing) {
      this.finish();
    }
    this.checkGate();
  }

  private start(runId: RunId, runIndex: number, slideIndex: number): void {
    const now = this.o.clock.now();
    this.cur = {
      runId, runIndex, session: null, connecting: false, closing: false, graceTimer: null, retryTimer: null,
      attempts: 0, lastError: null, gaveUp: false, phrases: 0, fillers: new Map(), fillerTimes: [], bursts: 0, segs: [], cur: null,
      cursor: now, slides: [{ at: now, index: slideIndex }], qaAt: null,
    };
    this.speaking.clear();
    this.log("info", "listener.run_start", { runId });
    this.open();
  }

  /** The run ended or was aborted: stop the audio, keep the session `graceMs` for the last report. */
  private finish(): void {
    const r = this.cur!;
    r.closing = true;
    if (r.retryTimer) { this.o.clock.clearTimeout(r.retryTimer); r.retryTimer = null; }
    this.endSeg(r);
    try { r.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* closing anyway */ }
    r.graceTimer = this.o.clock.setTimeout(() => { if (this.cur === r) { this.shutdown("run over"); this.idle(); } }, this.o.graceMs ?? 3000);
    this.status();
  }

  private shutdown(why: string): void {
    const r = this.cur;
    if (!r) return;
    this.cur = null;
    this.gen++;                                     // callbacks of that session are ignored from now on
    if (r.graceTimer) this.o.clock.clearTimeout(r.graceTimer);
    if (r.retryTimer) this.o.clock.clearTimeout(r.retryTimer);
    try { r.session?.close(); } catch { /* already gone */ }
    r.session = null;
    const words = [...r.fillers.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(", ");
    const total = [...r.fillers.values()].reduce((a, b) => a + b, 0);
    this.log("info", "listener.run_closed", { runId: r.runId, why, phrases: r.phrases, fillers: total, bursts: r.bursts });
    if (r.phrases) this.o.board.note("listener", `run ${r.runIndex}: ${r.phrases} phrases, ${total} filler word${total === 1 ? "" : "s"}${words ? ` (${words})` : ""}, ${r.bursts} burst${r.bursts === 1 ? "" : "s"}`);
  }

  private open(): void {
    const r = this.cur;
    if (!r || r.closing || r.connecting || r.session) return;
    const gen = ++this.gen;
    r.connecting = true;
    this.status();
    let settled = false;
    const timer = this.o.clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      this.dropped(gen, "setup timeout");
    }, this.o.setupTimeoutMs ?? 10_000);
    let session: ListenerSessionLike | null = null;
    let promise: Promise<ListenerSessionLike>;
    try {
      promise = this.connectFn!({
        model: this.o.model,
        config: listenerConfig(),
        callbacks: {
          onmessage: (m: LiveServerMessage) => { if (gen === this.gen) this.onMessage(m, session); },
          onerror: (e: { message?: string }) => { if (gen === this.gen) this.log("warn", "listener.socket_error", { message: e?.message }); },
          onclose: (e: { code?: number; reason?: string }) => {
            if (gen !== this.gen) return;
            if (!settled) { settled = true; this.o.clock.clearTimeout(timer); }
            this.dropped(gen, `closed ${e?.code ?? ""} ${e?.reason ?? ""}`.trim());
          },
        },
      });
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (s) => {
        session = s;
        if (settled) { s.close(); return; }          // timed out or closed during setup
        settled = true;
        this.o.clock.clearTimeout(timer);
        if (gen !== this.gen || this.cur !== r || r.closing) { r.connecting = false; s.close(); return; }
        r.session = s;
        r.connecting = false;
        r.attempts = 0;
        r.lastError = null;
        this.log("info", "listener.connected", { runId: r.runId, model: this.o.model });
        this.checkGate();
      },
      (err) => {
        if (settled) return;
        settled = true;
        this.o.clock.clearTimeout(timer);
        this.dropped(gen, String(err instanceof Error ? err.message : err));
      },
    );
  }

  /** The session failed to open or closed while the run is live: retry with backoff. */
  private dropped(gen: number, reason: string): void {
    const r = this.cur;
    if (gen !== this.gen || !r) return;
    this.gen++;
    try { r.session?.close(); } catch { /* gone */ }
    r.session = null;
    r.connecting = false;
    r.lastError = reason.slice(0, 120);
    this.gateOpen = false;
    this.endSeg(r);
    if (r.closing) { this.status(); return; }
    const max = this.o.maxAttempts ?? 6;
    if (r.attempts >= max) {
      r.gaveUp = true;
      this.log("error", "listener.gave_up", { runId: r.runId, reason });
      this.status();
      return;
    }
    const backoff = this.o.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(r.attempts, backoff.length - 1)] ?? 5000;
    r.attempts++;
    this.log("warn", "listener.reconnect", { runId: r.runId, reason, attempt: r.attempts, delay });
    r.retryTimer = this.o.clock.setTimeout(() => { r.retryTimer = null; if (this.cur === r) this.open(); }, delay);
    this.status();
  }

  // ---------------- server messages ----------------

  private onMessage(m: LiveServerMessage, session: ListenerSessionLike | null): void {
    if (m.goAway) {                                  // the server will cut this session soon: open a fresh one now
      const r = this.cur;
      this.log("info", "listener.go_away", { timeLeft: m.goAway.timeLeft });
      if (r && !r.closing) { const gen = this.gen; r.attempts = 0; this.dropped(gen, "go away"); }
      return;
    }
    for (const fc of m.toolCall?.functionCalls ?? []) {
      const target = this.cur?.session ?? session;
      try { target?.sendToolResponse({ functionResponses: [{ id: fc.id ?? "", name: fc.name ?? "report_fillers", response: { ok: true } }] }); }
      catch (err) { this.log("warn", "listener.tool_response_failed", { err: String(err) }); }
      if (fc.name === "report_fillers") this.report(fc.args ?? {});
    }
    // Any model audio / text is ignored: the listener never speaks.
  }

  /** One `report_fillers` call → board phrase (+ filler), RunLog burst. Public for tests. */
  report(args: Record<string, unknown>): void {
    const r = this.cur;
    if (!r) return;
    const now = this.o.clock.now();
    const text = typeof args.phrase === "string" ? args.phrase.trim().slice(0, 2000) : "";
    const fillers = (Array.isArray(args.fillers) ? args.fillers : [])
      .filter((w): w is string => typeof w === "string").map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 30);
    if (!text && !fillers.length) return;
    const { startAt, endAt } = this.place(r, Math.max(1, (text || fillers.join(" ")).split(/\s+/).length), now);
    r.phrases++;
    const phrase: Phrase = { runId: r.runId, segment: r.qaAt !== null && startAt >= r.qaAt ? "qa" : "presentation", text, fillers, startAt, endAt, slideIndex: slideAt(r, startAt) };
    this.o.board.emit({ type: "phrase", phrase });
    if (fillers.length) {
      for (const w of fillers) r.fillers.set(w, (r.fillers.get(w) ?? 0) + 1);
      this.o.board.emit({ type: "filler", runId: r.runId, words: fillers, at: endAt });
      this.burst(r, phrase);
    }
    this.status();
  }

  /**
   * Where a phrase of `words` words was said: from the cursor (end of the last phrase) through the
   * speech the gate saw. The model reports one phrase per VAD turn (usually = one of our segments), but
   * may report several phrases of one long segment at once: then the phrase gets its share by words.
   */
  private place(r: LiveRun, words: number, now: number): { startAt: number; endAt: number } {
    const est = Math.min(15_000, Math.max(600, words * MS_PER_WORD));
    const segs = [...r.segs, ...(r.cur ? [{ start: r.cur.start, end: r.cur.lastVoice }] : [])].filter((g) => g.end > r.cursor);
    if (!segs.length) {                                      // nothing seen (e.g. the gate opened late)
      const endAt = Math.max(r.cursor, now - 1500);
      const startAt = Math.max(r.cursor, endAt - est);
      r.cursor = endAt;
      return { startAt, endAt };
    }
    const startAt = Math.max(segs[0]!.start, r.cursor);
    let endAt = segs[0]!.end;
    let covered = endAt - startAt;
    for (let i = 1; i < segs.length && covered < est * 0.6; i++) { endAt = segs[i]!.end; covered += segs[i]!.end - segs[i]!.start; }
    if (covered > est * 1.6) endAt = Math.min(endAt, startAt + est);   // part of a longer segment
    r.cursor = endAt;
    if (r.segs.length > MAX_SEGS) r.segs.splice(0, r.segs.length - MAX_SEGS);
    return { startAt, endAt };
  }

  /** ≥ burstMin fillers within burstWindowMs (counting only fillers after the last burst) → one observation. */
  private burst(r: LiveRun, p: Phrase): void {
    const windowMs = this.o.burstWindowMs ?? 10_000;
    const n0 = p.fillers.length;
    for (let i = 0; i < n0; i++) r.fillerTimes.push(p.startAt + ((i + 0.5) / n0) * (p.endAt - p.startAt));   // spread over the phrase
    r.fillerTimes = r.fillerTimes.filter((t) => t > p.endAt - windowMs);
    const n = r.fillerTimes.length;
    if (n < (this.o.burstMin ?? 2)) return;
    const spanS = Math.max(1, Math.round((r.fillerTimes.at(-1)! - r.fillerTimes[0]!) / 1000));
    r.fillerTimes = [];
    const obs: Observation = {
      rule: "speech.fillers", kind: "filler_burst", category: "disfluencies",
      text: `${n} filler words in ${spanS} s (${p.fillers.join(", ")}): "${p.text.slice(0, 160)}"`,
      at: p.endAt, slideIndex: p.slideIndex, segment: p.segment,
    };
    if (this.o.runLog.addObservation(r.runId, obs)) r.bursts++;
  }

  // ---------------- audio gate ----------------

  /** Who is audible on the speakers (echo): `actor.say` until its playback ended/stopped, `audio.stop`,
   *  the judge's idle gesture, or a safety estimate from the text (JJ's says carry no text). */
  private onOutbound(msg: DownlinkMessage): void {
    const now = this.o.clock.now();
    if (msg.type === "actor.say") {
      const ms = msg.payload.actorId === "jj" ? JJ_SPEAKING_CAP_MS : Math.min(40_000, 3000 + msg.payload.text.length * 80);
      this.speaking.set(msg.payload.utteranceId, { actorId: msg.payload.actorId, until: now + ms });
      this.checkGate();
    } else if (msg.type === "audio.stop") {
      for (const [id, a] of this.speaking) {
        if (msg.payload.utteranceId ? id === msg.payload.utteranceId : (a.actorId === "jj") === (msg.payload.source === 0)) this.speechDone(id);
      }
    } else if (msg.type === "actor.gesture" && msg.payload.gesture === "idle") {
      for (const [id, a] of this.speaking) if (a.actorId === msg.payload.actorId) this.speechDone(id);
    }
  }

  private speechDone(utteranceId: string): void {
    if (!this.speaking.delete(utteranceId)) return;
    this.block(this.o.clock.now() + this.tail());
    this.checkGate();
  }

  private tail(): number { return this.o.tailMs ?? 400; }
  private block(until: number): void { this.blockedUntil = Math.max(this.blockedUntil, until); }

  /** Why the mic is not going up now (null = it is). */
  private closedBecause(now: number): string | null {
    const r = this.cur;
    if (!r || r.closing) return "no run";
    const s = this.o.session.get();
    if (!isLive(s) || s.run!.runId !== r.runId) return "no run";
    if (s.run!.paused) return "paused · JJ is listening";
    for (const [id, a] of this.speaking) if (a.until <= now) this.speaking.delete(id);   // estimate ran out
    for (const a of this.speaking.values()) return a.actorId === "jj" ? "JJ is speaking" : "a judge is speaking";
    if (now < this.blockedUntil) return "echo tail";
    if (!r.session) return r.connecting ? "connecting" : "reconnecting";
    return null;
  }

  private checkGate(): void {
    const now = this.o.clock.now();
    const open = this.closedBecause(now) === null;
    // Re-check when the echo tail ends, even without mic frames.
    if (!open && now < this.blockedUntil && !this.gateTimer) {
      this.gateTimer = this.o.clock.setTimeout(() => { this.gateTimer = null; this.checkGate(); }, this.blockedUntil - now + 1);
    }
    if (open !== this.gateOpen) {
      this.gateOpen = open;
      const r = this.cur;
      if (!open && r) {
        this.endSeg(r);
        try { r.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* dropped; onclose handles it */ }
      }
    }
    this.status();
  }

  private onMic(pcm: Int16Array): void {
    const r = this.cur;
    if (!r) return;
    this.checkGate();
    if (!this.gateOpen || !r.session) return;
    const now = this.o.clock.now();
    this.trackSpeech(r, pcm, now);
    try { r.session.sendRealtimeInput({ audio: { data: pcm16ToBase64(pcm), mimeType: MIME } }); }
    catch (err) { this.dropped(this.gen, `send failed: ${String(err)}`); }
  }

  /** RMS segmentation of what went up: speech start/stop times for the phrases. */
  private trackSpeech(r: LiveRun, pcm: Int16Array, now: number): void {
    const loud = rms(pcm) >= (this.o.speechRms ?? 700);
    if (loud) {
      if (!r.cur) r.cur = { start: now - FRAME_MS, lastVoice: now };
      else r.cur.lastVoice = now;
    } else if (r.cur && now - r.cur.lastVoice >= SEG_SILENCE_MS) {
      this.endSeg(r);
    }
  }

  private endSeg(r: LiveRun): void {
    if (!r.cur) return;
    r.segs.push({ start: r.cur.start, end: r.cur.lastVoice });
    if (r.segs.length > MAX_SEGS) r.segs.splice(0, r.segs.length - MAX_SEGS);
    r.cur = null;
  }

  // ---------------- status ----------------

  private idle(): void { this.o.board.status("listener", "idle", "waiting for a run"); }

  private status(): void {
    const r = this.cur;
    if (!r) return;
    const total = [...r.fillers.values()].reduce((a, b) => a + b, 0);
    const counts = `${total} filler${total === 1 ? "" : "s"}`;
    if (r.closing) { this.o.board.status("listener", "working", `run ${r.runIndex} over · ${r.phrases} phrases · ${counts}`); return; }
    if (r.gaveUp) { this.o.board.status("listener", "error", `gave up after ${r.attempts} tries · ${r.lastError ?? "?"}`); return; }
    if (r.connecting && r.attempts === 0) { this.o.board.status("listener", "working", `connecting · run ${r.runIndex}`); return; }
    if (!r.session) {
      this.o.board.status("listener", "working", `reconnecting (try ${r.attempts})${r.lastError ? ` · ${r.lastError}` : ""}`);
      return;
    }
    const s = this.o.session.get();
    const where = s.run?.phase === "qa" ? "Q&A" : `slide ${(s.run?.slideIndex ?? 0) + 1}`;
    const why = this.closedBecause(this.o.clock.now());
    if (why) this.o.board.status("listener", "idle", `${why} · ${where} · ${counts}`);
    else this.o.board.status("listener", "listening", `${where} · ${counts}`);
  }
}

/** The slide on screen at `at` (slide changes seen during the run). */
function slideAt(r: LiveRun, at: number): number {
  let index = r.slides[0]!.index;
  for (const s of r.slides) if (s.at <= at) index = s.index;
  return index;
}

/** Swarm entry point (index.ts): the listener and the feedback agent (filler vignette). */
export function installListener(ctx: SwarmContext, o: Partial<Pick<ListenerOptions, "connect" | "tailMs" | "graceMs">> = {}): Listener {
  const { brain } = ctx;
  new FillerFeedback({ board: ctx.board, session: brain.session, sync: brain.sync, clock: ctx.clock, log: ctx.log });
  return new Listener({
    board: ctx.board, session: brain.session, hub: brain.hub, runLog: ctx.runLog, clock: ctx.clock, log: ctx.log,
    apiKey: ctx.models.apiKey, model: ctx.models.listener, speechRms: ctx.speechRms, ...o,
  });
}
