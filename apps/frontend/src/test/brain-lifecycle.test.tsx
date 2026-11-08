import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownlinkPayload, RunState } from "@coach/protocol";
import { BrainSource } from "../brain/BrainSource";
import { MomentsPlayer } from "../brain/MomentsPlayer";
import { PreRunCheck } from "../brain/PreRunCheck";
import { RunRecorder } from "../brain/recorder";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------- recorder

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  static throwOnCreate = false;
  state: "inactive" | "recording" = "inactive";
  mimeType = "video/webm";
  onstart: (() => void) | null = null;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  private stopFns: (() => void)[] = [];
  constructor(readonly stream: unknown) {
    if (FakeRecorder.throwOnCreate) throw new Error("NotSupportedError");
    FakeRecorder.instances.push(this);
  }
  start() { this.state = "recording"; this.onstart?.(); }
  /** Like Chrome: the last chunk and "stop" come a moment later. */
  stop() {
    this.state = "inactive";
    setTimeout(() => { this.chunk(); this.stopFns.splice(0).forEach((f) => f()); }, 10);
  }
  addEventListener(type: string, fn: () => void) { if (type === "stop") this.stopFns.push(fn); }
  chunk() { this.ondataavailable?.({ data: new Blob(["x"]) }); }
}

function media(getUserMedia: () => Promise<unknown>) {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const gum = vi.fn(async () => { await getUserMedia(); return { getTracks: () => tracks }; });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum }, configurable: true });
  FakeRecorder.instances = [];
  FakeRecorder.throwOnCreate = false;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  return { gum, tracks, fetchMock, urls: () => fetchMock.mock.calls.map((c) => String(c[0]).replace("http://b/api/media/", "")) };
}

describe("run recorder", () => {
  it("without a camera: one warning, the same run is not tried again, never recording", async () => {
    const m = media(async () => { throw new Error("NotAllowedError"); });
    const warn = vi.fn(), onChange = vi.fn();
    const r = new RunRecorder({ httpBase: "http://b", warn, onChange });
    await r.start("run_1");
    await r.start("run_1");
    await r.start("run_1");
    expect(m.gum).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.recording).toBe(false);
    expect(r.runId).toBe("run_1");
    expect(onChange).not.toHaveBeenCalled();
    await r.stop();
    expect(r.runId).toBeNull();
  });

  it("releases the camera when the browser can't record", async () => {
    const m = media(async () => {});
    FakeRecorder.throwOnCreate = true;
    const warn = vi.fn(), onChange = vi.fn();
    const r = new RunRecorder({ httpBase: "http://b", warn, onChange });
    await r.start("run_1");
    expect(m.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.recording).toBe(false);
    await r.start("run_1");
    expect(m.gum).toHaveBeenCalledTimes(1);
  });

  it("reports recording on and off; a late chunk of the last run keeps its run and seq", async () => {
    vi.useFakeTimers();
    const m = media(async () => {});
    const onChange = vi.fn();
    const r = new RunRecorder({ httpBase: "http://b", warn: vi.fn(), onChange });
    await r.start("run_1");
    expect(r.recording).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    FakeRecorder.instances[0]!.chunk();
    const next = r.start("run_2");            // the next run starts before run 1's last chunk arrived
    expect(onChange).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(20);
    await next;
    expect(r.recording).toBe(true);
    FakeRecorder.instances[1]!.chunk();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.urls()).toEqual([
      expect.stringMatching(/^run_1\/chunk\?seq=0&startedAt=\d+$/),
      "run_1/chunk?seq=1",
      "run_1/done",
      expect.stringMatching(/^run_2\/chunk\?seq=0&startedAt=\d+$/),
    ]);
  });

  it("an upload failure stops the recording and the camera, once", async () => {
    vi.useFakeTimers();
    const m = media(async () => {});
    m.fetchMock.mockImplementation(async () => ({ ok: false, status: 500 }) as never);
    const warn = vi.fn(), onChange = vi.fn();
    const r = new RunRecorder({ httpBase: "http://b", warn, onChange });
    await r.start("run_1");
    FakeRecorder.instances[0]!.chunk();
    FakeRecorder.instances[0]!.chunk();
    await vi.advanceTimersByTimeAsync(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.recording).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(m.tracks[0]!.stop).toHaveBeenCalled();
    await r.start("run_1");
    expect(m.gum).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- brain source

const runState = (phase: RunState["phase"], runId = "run_2"): RunState => ({
  runId: runId as RunState["runId"], index: 2, mode: "training", feedbackLevel: "strong", targets: [], enabledCategories: [],
  sceneVersion: 1, phase, slideIndex: 0, paused: false, pausedMs: 0,
});

function brainWithHandlers() {
  const brain = new BrainSource({ httpBase: "http://b", audio: false, wakePhrase: false });
  const handlers = new Map<string, (p: unknown) => void>();
  vi.spyOn(brain.client, "on").mockImplementation(((type: string, fn: (p: unknown) => void) => { handlers.set(type, fn); return () => {}; }) as never);
  vi.spyOn(brain.client, "connect").mockReturnValue(brain.client);
  brain.start();
  const emit = (type: string, p: unknown) => handlers.get(type)!(p);
  return { brain, emit };
}
const moments: DownlinkPayload<"moments.show"> = {
  title: "Swaying", kind: "sway", runId: "run_1",
  clips: [{ url: "/api/media/run_1/video", fromS: 1, toS: 3, tRunMs: 1000, slideIndex: 0, label: "0:01 · slide 1" }],
};

describe("brain source: moments and highlight around runs", () => {
  it("a new run's countdown closes JJ's replay and clears the report highlight", () => {
    const { brain, emit } = brainWithHandlers();
    emit("moments.show", moments);
    emit("report.focus", { kind: "sway" });
    expect(brain.getSnapshot().moments).not.toBeNull();
    expect(brain.getSnapshot().focus).toBe("sway");
    emit("run.state", { run: runState("countdown"), sessionPhase: "running" });
    expect(brain.getSnapshot().moments).toBeNull();
    expect(brain.getSnapshot().focus).toBeNull();
    brain.stop();
  });
});

// ---------------------------------------------------------------- moments player

describe("moments player", () => {
  it("closes when the recording can't be played", () => {
    const onClose = vi.fn();
    const { container } = render(<MomentsPlayer m={moments} httpBase="http://b" onClose={onClose} />);
    act(() => { container.querySelector("video")!.dispatchEvent(new Event("error")); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- pre-run check

describe("pre-run check", () => {
  it("stops polling the sensors once dismissed", async () => {
    vi.useFakeTimers();
    const check = { coach: true, camera: "ok", inFrame: true, fps: 24, mic: true, ready: true, hints: [] };
    const fetchMock = vi.fn(async () => ({ json: async () => check }));
    vi.stubGlobal("fetch", fetchMock);
    const brain = { httpBase: "http://b", micLevel: () => 0 } as unknown as BrainSource;
    render(<PreRunCheck brain={brain} recording="yes" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByText("Ready to present")).toBeTruthy();
    const polled = fetchMock.mock.calls.length;
    expect(polled).toBe(3);
    act(() => { fireEvent.click(screen.getByLabelText("Hide")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(polled);
    expect(screen.queryByTestId("pre-run-check")).toBeNull();
  });
});
