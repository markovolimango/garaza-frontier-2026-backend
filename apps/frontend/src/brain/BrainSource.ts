/**
 * BrainSource: the real SignalSource (Brain integration layer). Connects to the brain as the
 * `stage` role, maps protocol downlinks onto the app's bus, and sends the stage's uplinks.
 *
 *   feedback.set   → bus "feedback" (red / green / neutral)
 *   ui.state       → snapshot.ui (BrainBridge navigates) + bus "jjMood" (orb score, 0 red … 1 green)
 *   slide.show     → bus "slideCommand" (presenter jumps)
 *   bus "slide"    → slide.changed (only during the presentation)
 *   bus "deckFile" → POST /api/uploads/deck, then session.start
 *   scene.sync / scene.apply → local scene copy (ops applied, then ack) → bus "judgePanel" (seats + titles)
 *   actor.say / actor.gesture / actor.lookAt / judge audio → bus "judgeCommand" (JudgeRelay, judges screen)
 *   jj.transcript  → captions (CaptionStore, JJ's screen; cleared when a run starts or resumes)
 *   JJ audio level → bus "orbLevel"
 *   run.state       → bus "runClock" (presenter timer: start / pause / resume / stop)
 */
import { loadConsent, RunRecorder, saveConsent, type ConsentState } from "./recorder";
import type { Deck, DownlinkPayload, JJState, RunState, SceneDef, SessionPhase, ToolName, ToolResult, UplinkPayload, UplinkType } from "@coach/protocol";
import { ControlClient, type ConnectionStatus } from "@coach/web/net";
import { getLast, publish, subscribe } from "../signals/bus";
import type { SignalSource } from "../signals/sources/types";
import { AudioOut, MicIn } from "./audio";
import { CaptionStore } from "./captions";
import { pdfToSlides, uploadDeck } from "./deck";
import { JudgeRelay } from "./judges";
import { preloadJudges } from "./preload";
import { applySceneOps, panelFromScene } from "./scene";
import { WakeListener } from "./wake";
import { feedbackToBus, orbTarget, reportsSlides, runClockChanges } from "./mapping";

export interface BrainSourceOptions {
  /** http(s) base of the brain, e.g. http://localhost:8787 */
  httpBase: string;
  /** Turn off for tests / headless (no AudioContext). */
  audio?: boolean;
  /** "Hey JJ" by voice via the browser's speech recognition (default on where supported). */
  wakePhrase?: boolean;
  WebSocketImpl?: typeof WebSocket;
}

export interface Toast { id: number; text: string; level: "info" | "warn" }

export interface BrainSnapshot {
  status: ConnectionStatus;
  ui: DownlinkPayload<"ui.state"> | null;
  run: RunState | null;
  sessionPhase: SessionPhase | null;
  jj: JJState | null;
  countdown: 3 | 2 | 1 | 0 | null;
  deck: Deck | null;
  uploading: boolean;
  audioOn: boolean;
  toasts: Toast[];
  lastSay: DownlinkPayload<"actor.say"> | null;
  reportReady: DownlinkPayload<"report.ready"> | null;
  focus: DownlinkPayload<"report.focus">["kind"];
  /** Clips JJ is replaying (show_moments), null when none. */
  moments: DownlinkPayload<"moments.show"> | null;
  /** The presenter's answer to "record runs?" for this session (asked on screen before the first run). */
  recordConsent: ConsentState;
  /** A run is being recorded right now. */
  recording: boolean;
}

export function brainOptionsFromEnv(): BrainSourceOptions {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return { httpBase: (env["VITE_BRAIN_URL"] ?? "http://localhost:8787").replace(/\/$/, "") };
}

export class BrainSource implements SignalSource {
  readonly client: ControlClient;
  private snap: BrainSnapshot = {
    status: "closed", ui: null, run: null, sessionPhase: null, jj: null, countdown: null, deck: null,
    uploading: false, audioOn: false, toasts: [], lastSay: null, reportReady: null, focus: null,
    moments: null, recordConsent: typeof window === "undefined" ? null : loadConsent(), recording: false,
  };
  private recorder: RunRecorder | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly unsubs: (() => void)[] = [];
  private audioOut: AudioOut | null = null;
  private micIn: MicIn | null = null;
  private wake: WakeListener | null = null;
  private orbTimer: ReturnType<typeof setInterval> | null = null;
  private orb = 0.15;
  private lastCommandedSlide: number | null = null;
  private toastId = 0;
  private paused = false;
  private started = false;
  /** Judge messages → bus judgeCommand (the judges screen must not open a second stage connection). */
  private readonly judges = new JudgeRelay({ publish: (c) => publish("judgeCommand", c), level: (s) => this.audioOut?.level(s) ?? 0 });
  /** What JJ and the user said (jj.transcript), for JJ's screen. */
  readonly captions = new CaptionStore();
  /** The brain's scene as last synced or applied. */
  private scene: SceneDef | null = null;
  private panelKey = "";

  constructor(private readonly o: BrainSourceOptions) {
    const ws = o.httpBase.replace(/^http/, "ws");
    this.client = new ControlClient({ role: "stage", url: `${ws}/ws/control`, ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {}) });
  }

  get wsBase(): string { return this.o.httpBase.replace(/^http/, "ws"); }
  get httpBase(): string { return this.o.httpBase; }

  // ---------------- SignalSource ----------------

  start(): void {
    if (this.started) return;
    this.started = true;
    const c = this.client;
    c.onStatus((status) => this.set({ status }));
    c.on("ui.state", (p) => {
      this.set({ ui: p });
      publish("jjMood", p.orb.score);
      if (p.view !== "setup" && this.o.audio !== false) preloadJudges();   // models ready before the Q&A
    });
    c.on("run.state", (p) => {
      for (const cmd of runClockChanges(this.snap.run, p.run)) publish("runClock", cmd);   // presenter timer
      const prev = this.snap.run;
      if (p.run && ((p.run.phase === "countdown" && prev?.phase !== "countdown") || (prev?.paused && !p.run.paused))) this.captions.clear();
      this.set({ run: p.run, sessionPhase: p.sessionPhase });
      this.syncRecorder();
    });
    c.on("feedback.set", (p) => { if (!this.paused) publish("feedback", feedbackToBus(p)); });
    c.on("slide.show", (p) => { this.lastCommandedSlide = p.index; publish("slideCommand", p.index); });
    c.on("countdown", (p) => {
      this.set({ countdown: p.secondsLeft });
      if (p.secondsLeft === 0) setTimeout(() => { if (this.snap.countdown === 0) this.set({ countdown: null }); }, 700);
    });
    c.on("scene.sync", (p) => { this.scene = p.scene; this.publishPanel(); this.set({ deck: p.deck }); });
    c.on("scene.apply", (p) => {
      // Apply first, then ack: the brain commits the batch only after the stage has it.
      if (!this.scene) { c.send("ack", { batchId: p.batchId, ok: false, error: "the stage has no scene yet" }); return; }
      this.scene = applySceneOps(this.scene, p.ops, p.version);
      this.publishPanel();
      c.send("ack", { batchId: p.batchId, version: p.version, ok: true });
    });
    c.on("jj.state", (p) => this.set({ jj: p }));
    c.on("jj.transcript", (p) => this.captions.push(p));
    c.on("actor.say", (p) => { this.audioOut?.utterances.set(p.source, p.utteranceId); this.set({ lastSay: p }); this.judges.say(p); });
    c.on("actor.gesture", (p) => this.judges.gesture(p));
    c.on("actor.lookAt", (p) => this.judges.lookAt(p));
    c.on("audio.stop", (p) => this.audioOut?.stop(p.source));
    c.on("hud.toast", (p) => this.toast(p.text, p.level));
    c.on("error", (p) => this.toast(p.message, "warn"));
    c.on("report.ready", (p) => this.set({ reportReady: p }));
    c.on("report.focus", (p) => this.set({ focus: p.kind }));
    c.on("moments.show", (p) => this.set({ moments: p.clips.length ? p : null }));
    c.connect();

    this.unsubs.push(subscribe("slide", (i) => {
      if (i === this.lastCommandedSlide) { this.lastCommandedSlide = null; return; }   // echo of slide.show
      if (reportsSlides(this.snap.run?.phase) && this.snap.sessionPhase === "running") this.send("slide.changed", { index: i, clientTs: Date.now() });
    }));
    this.unsubs.push(subscribe("deckFile", (file) => { this.unlockAudio(); void this.uploadPdf(file); }));

    this.orbTimer = setInterval(() => {
      const target = orbTarget(this.snap.jj, this.audioOut?.level(0) ?? 0, this.micIn?.level ?? 0);
      this.orb += (target - this.orb) * 0.3;
      publish("orbLevel", this.orb);
    }, 50);
  }

  stop(): void {
    this.unsubs.splice(0).forEach((u) => u());
    if (this.orbTimer) clearInterval(this.orbTimer);
    this.client.close();
    this.audioOut?.close();
    this.micIn?.close();
    this.wake?.stop();
    this.judges.clear();
    this.captions.clear();
    this.started = false;
  }

  /** The stage's copy of the brain's scene (scene.sync, then each applied scene.apply). */
  sceneCopy(): Readonly<SceneDef> | null { return this.scene; }

  /** The judges the room seats → JudgeRelay and bus "judgePanel" (published only when it changes). */
  private publishPanel(): void {
    if (!this.scene) return;
    const panel = panelFromScene(this.scene);
    this.judges.setPanel(panel);
    const key = JSON.stringify(panel);
    if (key === this.panelKey) return;
    this.panelKey = key;
    publish("judgePanel", panel);
  }

  setPaused(p: boolean): void { this.paused = p; }
  isPaused(): boolean { return this.paused; }

  // ---------------- React store ----------------

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): BrainSnapshot => this.snap;

  private set(patch: Partial<BrainSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  toast(text: string, level: Toast["level"] = "info"): void {
    const id = ++this.toastId;
    this.set({ toasts: [...this.snap.toasts, { id, text, level }].slice(-3) });
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((t) => t.id !== id) }), 4000);
  }

  // ---------------- actions ----------------

  send<T extends UplinkType>(type: T, payload: UplinkPayload<T>): boolean { return this.client.send(type, payload) !== null; }

  async invoke(tool: ToolName, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      const env = await this.client.request("tool.invoke", { tool, args });
      if (env.type === "tool.result") return env.payload as ToolResult;
      if (env.type === "error") return { ok: false, reason: env.payload.code, hint: env.payload.message };
      return { ok: false, reason: "internal" };
    } catch (err) {
      return { ok: false, reason: "stage_offline", hint: String(err) };
    }
  }

  ptt(down: boolean): void { this.send("ptt", { down }); }

  /** "Record runs?" answered on screen; asked again in a new session. */
  setRecordConsent(v: ConsentState): void {
    saveConsent(v);
    this.set({ recordConsent: v });
    this.syncRecorder();
  }

  closeMoments(): void { this.set({ moments: null }); }

  /** Record while a run is under way (countdown → Q&A) and the presenter agreed; a reset forgets the answer. */
  private syncRecorder(): void {
    const { run, sessionPhase, recordConsent } = this.snap;
    if (sessionPhase === "setup" && !run && recordConsent !== null) { saveConsent(null); this.set({ recordConsent: null }); }
    const live = !!run && (run.phase === "countdown" || run.phase === "presentation" || run.phase === "qa");
    if (live && this.snap.recordConsent === "yes" && this.o.audio !== false && RunRecorder.supported()) {
      this.recorder ??= new RunRecorder({ httpBase: this.o.httpBase, warn: (t) => this.toast(t, "warn") });
      if (this.recorder.recording !== run!.runId) void this.recorder.start(run!.runId);
      if (!this.snap.recording) this.set({ recording: true });
    } else if (this.snap.recording || this.recorder?.recording) {
      void this.recorder?.stop();
      this.set({ recording: false });
    }
  }

  /** "Hey JJ" heard: during a live run, the same wake as holding J (outside runs JJ already listens). */
  private onWakePhrase(): void {
    const run = this.snap.run;
    if (!run || run.paused || (run.phase !== "presentation" && run.phase !== "qa" && run.phase !== "countdown")) return;
    this.ptt(true);
    this.ptt(false);
    this.toast("Hey JJ: JJ is listening");
  }

  /** Ends a wake ("Hey JJ" / hold J) when JJ doesn't resume the run by itself. */
  resume(): void { void this.invoke("resume_run").then((r) => { if (!r.ok) this.toast(r.hint ?? r.reason, "warn"); }); }

  /** Starts JJ's voice and the mic. Must run inside a user gesture (click / key). */
  unlockAudio(): void {
    if (this.o.audio === false || typeof window === "undefined" || typeof AudioContext === "undefined") return;
    if (!this.audioOut) {
      this.audioOut = new AudioOut(`${this.wsBase}/ws/audio`, (p) => { this.send("audio.playback", p); this.judges.playback(p); });
      this.micIn = new MicIn(`${this.wsBase}/ws/mic`);
      void this.micIn.start().catch((err) => this.toast(`Microphone unavailable: ${String(err)}`, "warn"));
      if (this.o.wakePhrase !== false && WakeListener.supported()) {
        this.wake = new WakeListener(() => this.onWakePhrase());
        this.wake.start();
      }
    }
    this.audioOut.start();
    if (!this.snap.audioOn) this.set({ audioOn: true });
  }

  /** PDF → slides → brain, then session.start when still in setup. */
  async uploadPdf(file: File): Promise<void> {
    if (this.snap.sessionPhase === "running") { this.toast("The deck can't change during a run", "warn"); return; }
    this.set({ uploading: true });
    try {
      const { manifest, images } = await pdfToSlides(file);
      await this.uploadSlides(manifest, images);
    } catch (err) {
      this.toast(`Deck upload failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
    } finally {
      this.set({ uploading: false });
    }
  }

  async uploadSlides(manifest: Parameters<typeof uploadDeck>[1], images: Blob[]): Promise<Deck> {
    const deck = await uploadDeck(this.o.httpBase, manifest, images);
    this.set({ deck });
    if (this.snap.sessionPhase === "setup" || this.snap.sessionPhase === null) this.send("session.start", {});
    return deck;
  }
}

/** The deck the presenter loaded last (kept on the bus so the screen can re-open it). */
export const lastDeckFile = (): File | undefined => getLast("deckFile");
