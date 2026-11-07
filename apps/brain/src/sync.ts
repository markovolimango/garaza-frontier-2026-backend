/**
 * StateSync: turns session changes into downlinks, and sends each role its initial state
 * on (re)connect, so a reload mid-run restores the right view and slide.
 *
 *   stage    ui.state + scene.sync (with deck) + run.state + feedback.set   (on connect)
 *            ui.state / run.state / slide.show / countdown / feedback.set   (on change)
 *   operator state.snapshot on connect and every change, throttled to 10 Hz; run.state
 *   sensor   sensor.config on connect and when categories/calibration change; run.state
 */
import {
  FEEDBACK_NONE, type ClientRole, type FeedbackCommand, type JJState, type SessionState,
} from "@coach/protocol";
import type { Clock } from "./clock.ts";
import type { Hub } from "./hub.ts";
import type { SessionCause, SessionStore } from "./session.ts";
import { viewFor } from "./views.ts";

export interface StateSyncOptions {
  hub: Hub & { connections(): Record<ClientRole, boolean> };
  session: SessionStore;
  clock: Clock;
  jjStatus: () => JJState;
  snapshotThrottleMs?: number;   // 100 (10 Hz)
  sensorDebug?: boolean;
}

export class StateSync {
  private feedback: FeedbackCommand = FEEDBACK_NONE;
  private last = { ui: "", run: "", sensor: "" };
  private snapshotTimer: unknown = null;
  private lastSnapshotAt = 0;
  private vignetteTimer: unknown = null;

  constructor(private readonly o: StateSyncOptions) {
    const { hub, session } = o;
    hub.onConnect("stage", () => this.sendStageInitial());
    hub.onConnect("operator", () => { this.sendSnapshotNow(); this.sendRun(["operator"], true); });
    hub.onConnect("sensor", () => { this.sendSensorConfig(true); this.sendRun(["sensor"], true); });
    session.subscribe((s, cause) => this.onChange(s, cause));
  }

  /** Current vignette command (feedback controller lane calls this). Sent only on change. */
  setFeedback(f: FeedbackCommand): void {
    const same = f.kind === this.feedback.kind && f.intensity === this.feedback.intensity && f.reason === this.feedback.reason;
    this.feedback = f;
    if (!same) { this.o.hub.send("stage", { type: "feedback.set", payload: f }); this.scheduleSnapshot(); }
  }
  currentFeedback(): FeedbackCommand { return this.feedback; }

  /** operator.override vignette: bypasses the controller for holdMs. */
  forceVignette(kind: "warn" | "reward", intensity: number, holdMs: number): void {
    if (this.vignetteTimer) this.o.clock.clearTimeout(this.vignetteTimer);
    this.setFeedback({ kind, intensity, rampMs: kind === "warn" ? 2000 : 1500 });
    this.vignetteTimer = this.o.clock.setTimeout(() => { this.vignetteTimer = null; this.setFeedback(FEEDBACK_NONE); }, holdMs);
  }

  /** jj.state changes come from the JJ engine; they also go into the operator snapshot. */
  jjChanged(): void { this.scheduleSnapshot(); }

  private sendStageInitial(): void {
    const s = this.o.session.get();
    const { hub, session } = this.o;
    hub.send("stage", { type: "ui.state", payload: { ...viewFor(s), introDone: s.introDone } });
    hub.send("stage", session.syncMessage());
    hub.send("stage", { type: "run.state", payload: { run: s.run, sessionPhase: s.phase } });
    hub.send("stage", { type: "feedback.set", payload: this.feedback });
  }

  private onChange(s: SessionState, cause: SessionCause): void {
    const { hub } = this.o;
    const ui = { ...viewFor(s), introDone: s.introDone };
    const uiKey = JSON.stringify(ui);
    if (uiKey !== this.last.ui) { this.last.ui = uiKey; hub.send("stage", { type: "ui.state", payload: ui }); }

    this.sendRun(["stage", "sensor", "operator"]);

    if (!Array.isArray(cause)) {
      switch (cause.type) {
        case "countdown": hub.send("stage", { type: "countdown", payload: { secondsLeft: cause.secondsLeft } }); break;
        case "start_run": case "run_it_back": hub.send("stage", { type: "slide.show", payload: { index: 0 } }); break;
        case "slide": if (cause.from !== "stage") hub.send("stage", { type: "slide.show", payload: { index: cause.index } }); break;
        case "context": if ("deck" in cause.patch) hub.send("stage", this.o.session.syncMessage()); break;
        case "reset": hub.send("stage", this.o.session.syncMessage()); break;
      }
    }
    // Feedback is held at none while JJ is woken and outside runs.
    if ((s.run?.paused || s.phase !== "running") && this.feedback.kind !== "none" && !this.vignetteTimer) this.setFeedback(FEEDBACK_NONE);

    this.sendSensorConfig();
    this.scheduleSnapshot();
  }

  private sendRun(roles: ClientRole[], force = false): void {
    const s = this.o.session.get();
    const payload = { run: s.run, sessionPhase: s.phase };
    const key = JSON.stringify(payload);
    if (!force && key === this.last.run) return;
    if (!force) this.last.run = key;
    this.o.hub.broadcast(roles, { type: "run.state", payload });
  }

  private sendSensorConfig(force = false): void {
    const s = this.o.session.get();
    const payload = { enabledCategories: s.enabledCategories, neutralPitchDeg: s.calibration?.neutralPitchDeg ?? null, debug: this.o.sensorDebug ?? false };
    const key = JSON.stringify(payload);
    if (!force && key === this.last.sensor) return;
    if (!force) this.last.sensor = key;
    this.o.hub.send("sensor", { type: "sensor.config", payload });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer || !this.o.hub.isConnected("operator")) return;
    const wait = Math.max(0, this.lastSnapshotAt + (this.o.snapshotThrottleMs ?? 100) - this.o.clock.now());
    this.snapshotTimer = this.o.clock.setTimeout(() => { this.snapshotTimer = null; this.sendSnapshotNow(); }, wait);
  }

  private sendSnapshotNow(): void {
    this.lastSnapshotAt = this.o.clock.now();
    this.o.hub.send("operator", {
      type: "state.snapshot",
      payload: { session: this.o.session.get(), connections: this.o.hub.connections(), jj: this.o.jjStatus(), feedback: this.feedback },
    });
  }
}
