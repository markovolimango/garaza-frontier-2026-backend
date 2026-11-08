/** The pre-run check: camera coach (sensor.status from the bridge) and microphone. */
import { describe, expect, it } from "vitest";
import type { ClientRole } from "@coach/protocol";
import { VirtualClock } from "../src/clock.ts";
import { SensorMonitor, sensorsHttp } from "../src/sensors.ts";

function rig(o: { sensor?: boolean; mic?: boolean } = {}) {
  const clock = new VirtualClock();
  let handler: ((m: { payload: unknown }, r: ClientRole) => void) | null = null;
  const state = { sensor: o.sensor ?? true, mic: o.mic ?? true };
  const hub = {
    on: (_t: string, fn: typeof handler) => { handler = fn; },
    connections: () => ({ stage: true, operator: false, sensor: state.sensor }),
    micConnected: () => state.mic,
  };
  const monitor = new SensorMonitor({ hub: hub as never, clock });
  const status = (p: Record<string, unknown>) => handler!({ payload: p }, "sensor");
  return { clock, monitor, status, state };
}

describe("pre-run check", () => {
  it("is ready when the camera sees the presenter and the microphone streams", () => {
    const t = rig();
    t.status({ camera: "ok", fps: 11.5, posePresent: true });
    expect(t.monitor.check()).toEqual({ coach: true, camera: "ok", inFrame: true, fps: 11.5, mic: true, ready: true, hints: [] });
  });

  it("says what to fix: out of frame, no frames, a stale status, no coach, no microphone", () => {
    const t = rig();
    expect(t.monitor.check()).toMatchObject({ camera: "unknown", ready: false, hints: [expect.stringMatching(/No pose frames/)] });
    t.status({ camera: "no_person", fps: 12, posePresent: false, message: "person not visible" });
    expect(t.monitor.check()).toMatchObject({ inFrame: false, hints: [expect.stringMatching(/doesn't see you/)] });
    t.status({ camera: "ok", fps: 12, posePresent: true });
    t.clock.advance(6_000);                                                     // nothing new for 6 s
    expect(t.monitor.check()).toMatchObject({ camera: "unknown", ready: false });
    t.state.sensor = false; t.state.mic = false;
    expect(t.monitor.check().hints).toEqual([expect.stringMatching(/camera coach isn't connected/), expect.stringMatching(/microphone isn't streaming/)]);
  });

  it("is served at GET /api/sensors/check", () => {
    const t = rig();
    let body = "";
    expect(sensorsHttp(t.monitor)({ method: "GET", url: "/api/sensors/check" } as never, { writeHead: () => {}, end: (b: string) => { body = b; } } as never)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ coach: true, mic: true, ready: false });
  });
});
