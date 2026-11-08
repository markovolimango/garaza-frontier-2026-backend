/**
 * Pre-run check: what the brain knows right now about the camera coach and the microphone, for the
 * stage's "Before you start" card and JJ's start_run.
 *
 *   GET /api/sensors/check → SensorCheck
 *
 * The camera side comes from `sensor.status` (the coach bridge, from the coach's body.metrics); between
 * runs the bridge keeps a standby coach session so this stays current before the first run too.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientRole, Uplink } from "@coach/protocol";
import type { Clock } from "./clock.ts";

export interface SensorCheck {
  /** The coach bridge (sensor role) is connected to the brain. */
  coach: boolean;
  /** Camera state from the latest fresh sensor.status: ok (body in view), no_person, error, or unknown. */
  camera: "ok" | "no_person" | "error" | "unknown";
  inFrame: boolean;
  fps: number | null;
  /** The stage streams the microphone to the brain. */
  mic: boolean;
  /** Everything needed for a measured run. */
  ready: boolean;
  /** What to fix, in plain words (empty when ready). */
  hints: string[];
}

export interface SensorHub {
  on(type: "sensor.status", handler: (msg: Uplink<"sensor.status">, role: ClientRole) => void): void;
  connections(): Record<ClientRole, boolean>;
  micConnected(): boolean;
}

const STALE_MS = 5_000;

export class SensorMonitor {
  private last: { p: Uplink<"sensor.status">["payload"]; at: number } | null = null;

  constructor(private readonly o: { hub: SensorHub; clock: Clock }) {
    o.hub.on("sensor.status", (m) => { this.last = { p: m.payload, at: o.clock.now() }; });
  }

  check(): SensorCheck {
    const coach = this.o.hub.connections().sensor;
    const fresh = this.last && this.o.clock.now() - this.last.at <= STALE_MS ? this.last.p : null;
    const camera = coach && fresh ? fresh.camera : "unknown";
    const inFrame = camera === "ok" && !!fresh?.posePresent;
    const mic = this.o.hub.micConnected();
    const hints: string[] = [];
    if (!coach) hints.push("The camera coach isn't connected: start it (pnpm demo, or the coach bridge), or this run has no body measurements.");
    else if (camera === "unknown") hints.push("No pose frames from the camera yet: start the iPhone app or vision/run.sh --coach.");
    else if (camera === "error") hints.push(`The camera has a problem${fresh?.message ? `: ${fresh.message}` : ""}.`);
    else if (!inFrame) hints.push("The camera doesn't see you: step into the frame, whole upper body visible.");
    if (!mic) hints.push("The microphone isn't streaming: click anywhere on the screen and allow the microphone.");
    return { coach, camera, inFrame, fps: fresh?.fps ?? null, mic, ready: hints.length === 0, hints };
  }
}

export function sensorsHttp(monitor: SensorMonitor) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/api/sensors/check") return false;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(monitor.check()));
    return true;
  };
}
