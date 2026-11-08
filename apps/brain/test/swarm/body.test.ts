/** Body agent: live status from the run log, and after a run Gemini (faked) watches the recording. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunId } from "@coach/protocol";
import { MediaStore } from "../../src/media.ts";
import type { EpisodeRecord, RunRecord } from "../../src/runlog.ts";
import { SwarmBoard } from "../../src/swarm/board.ts";
import { readConfig } from "../../src/config.ts";
import { installBody } from "../../src/swarm/body.ts";
import type { VideoClient } from "../../src/swarm/bodyVideo.ts";
import type { SwarmContext } from "../../src/swarm/context.ts";
import { flush, VirtualClock } from "../helpers.ts";

const T0 = 1_700_000_000_000;     // VirtualClock start = recording start
const PRES = T0 + 3_000;          // presentation starts after a 3 s countdown

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_1" as RunId,
    run: { runId: "run_1" as RunId, index: 1, mode: "baseline", feedbackLevel: "off", targets: [], enabledCategories: [], sceneVersion: 1,
      phase: "presentation", slideIndex: 0, paused: false, pausedMs: 0, startedAt: T0, presentationStartedAt: PRES } as RunRecord["run"],
    slides: [{ index: 0, at: PRES }], observations: [], episodes: [], feedback: [], wakes: 0, qa: [],
    coachConnected: true, qaStartedAt: null, endedAt: null, endedBy: null, ...over,
  };
}
const ep = (kind: EpisodeRecord["kind"], fromS: number, toS: number | null, slideIndex = 1): EpisodeRecord =>
  ({ kind, startAt: PRES + fromS * 1000, endAt: toS === null ? null : PRES + toS * 1000, slideIndex, segment: "presentation", conf: 0.9 });

function setup(o: { apiKey?: string | null; recording?: boolean; sensor?: boolean; enabled?: boolean; client?: Partial<VideoClient> } = {}) {
  const clock = new VirtualClock(T0);
  const dir = mkdtempSync(join(tmpdir(), "brain-body-")); dirs.push(dir);
  const media = new MediaStore({ dir, sessionId: () => "sess1", hasRun: () => true });
  const board = new SwarmBoard({ clock });
  const conns = { stage: true, sensor: o.sensor ?? true, operator: false };
  const fns = { changed: [] as (() => void)[], ended: [] as ((r: RunRecord) => void)[], connect: [] as (() => void)[], disconnect: [] as (() => void)[] };
  let current: RunRecord | null = null;
  const runLog = {
    onChanged: (fn: () => void) => fns.changed.push(fn),
    onRunEnded: (fn: (r: RunRecord) => void) => fns.ended.push(fn),
    live: () => (current && (current.run.phase === "presentation" || current.run.phase === "qa") ? current : null),
    get: (id: string) => (current?.runId === id ? current : null),
  };
  const calls: string[] = [];
  const asked: { model: string; prompt: string }[] = [];
  const client: VideoClient = {
    upload: async (path, mimeType) => { calls.push(`upload ${path.endsWith("run_1.media")} ${mimeType}`); return { name: "files/abc", uri: "https://x/files/abc", mimeType }; },
    waitActive: async (f) => { calls.push("active"); return f; },
    ask: async (q) => {
      calls.push("ask"); asked.push(q);
      return { moments: [{ n: 1, text: "You folded your arms and leaned back." }], extra: [{ atS: 12, durationS: 3, kind: "other", text: "You turned your back to the audience to read the slide." }] };
    },
    remove: async (name) => { calls.push(`delete ${name}`); },
    ...o.client,
  };
  const ctx = {
    board, runLog, media, clock, log: () => {},
    models: { apiKey: o.apiKey === undefined ? "k" : o.apiKey, text: "t", report: "r", listener: "l", video: "video-model" },
    brain: {
      hub: { connections: () => conns, onConnect: (_r: string, fn: () => void) => fns.connect.push(fn), onDisconnect: (fn: () => void) => fns.disconnect.push(fn) },
      session: { get: () => ({ sessionId: "sess1" }), subscribe: () => () => {} },
    },
    sessionDir: dir, sessionFolder: () => join(dir, "sess1"), videoAnalysis: o.enabled ?? true,
  } as unknown as SwarmContext;
  installBody(ctx, { client: () => client });
  if (o.recording ?? true) {
    media.append("run_1", 0, Buffer.from("webm-bytes"), { startedAt: T0, mimeType: "video/webm;codecs=vp8,opus" });
    media.finish("run_1", T0 + 40_000);
  }
  return {
    clock, board, calls, asked, conns, fns,
    start(rec: RunRecord) { current = rec; for (const f of fns.changed) f(); },
    changed() { for (const f of fns.changed) f(); },
    end() { current!.run = { ...current!.run, phase: "ended" }; current!.endedAt = T0 + 40_000; for (const f of fns.ended) f(current!); for (const f of fns.changed) f(); },
    status: () => board.allStatuses().find((s) => s.id === "body")!,
    notes: () => board.toJSON().videoNotes,
    jj: [] as string[],
    async settle() { for (let i = 0; i < 40; i++) { clock.advance(250); await flush(); } },
  };
}
function listenJJ(t: ReturnType<typeof setup>) { t.board.on("agent.note", (e) => { if (e.from === "body") t.jj.push(e.text); }); return t; }

describe("body agent · live status", () => {
  it("says off without the camera coach, then watches the run's episodes", () => {
    const t = setup({ sensor: false });
    expect(t.status()).toMatchObject({ state: "off", detail: "no camera" });
    t.conns.sensor = true; for (const f of t.fns.connect) f();
    expect(t.status()).toMatchObject({ state: "idle", detail: "camera coach ready" });
    const rec = run();
    t.start(rec);
    expect(t.status()).toMatchObject({ state: "watching", detail: "nothing so far" });
    rec.episodes.push(ep("arms_crossed", 5, null));
    t.changed();
    expect(t.status()).toMatchObject({ state: "watching", detail: "crossed arms now · 1 episode so far" });
    rec.episodes[0]!.endAt = PRES + 9_000; rec.episodes.push(ep("sway", 12, 15));
    t.changed();
    expect(t.status().detail).toBe("2 episodes so far");
    t.conns.sensor = false; for (const f of t.fns.disconnect) f();
    expect(t.status()).toMatchObject({ state: "off", detail: "no camera" });
  });
});

describe("body agent · after a run", () => {
  it("uploads the recording, asks the video model, deletes the file, writes video notes and tells JJ", async () => {
    const t = listenJJ(setup());
    const rec = run({ episodes: [ep("arms_crossed", 10, 17), ep("arms_crossed", 25, 27), ep("face_touch", 30, 31)] });
    t.start(rec);
    t.end();
    await t.settle();
    expect(t.calls).toEqual(["upload true video/webm", "active", "ask", "delete files/abc"]);
    expect(t.asked[0]!.model).toBe("video-model");
    expect(t.asked[0]!.prompt).toContain("1. arms_crossed (crossed arms) from 13.0 s (0:13) to 20.0 s (0:20), slide 2");
    const notes = t.notes();
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.atMs)).toEqual([9_000, 10_000, 25_000, 30_000]);   // in time order
    expect(notes[1]).toEqual({ runId: "run_1", kind: "arms_crossed", atMs: 10_000, durationMs: 7_000, text: "You folded your arms and leaned back." });
    // the extra finding: recording time 12 s → run time 9 s (the presentation started 3 s into the recording)
    expect(notes.find((n) => n.kind === null)).toEqual({ runId: "run_1", kind: null, atMs: 9_000, durationMs: 3_000, text: "You turned your back to the audience to read the slide." });
    expect(notes.find((n) => n.kind === "face_touch")!.text).toBe("Touching your face for 1 s at 0:30 (slide 2).");   // the model skipped it
    expect(t.jj).toHaveLength(1);
    expect(t.jj[0]).toContain("[BODY] run_1 (Gemini watched the recording)");
    expect(t.jj[0]).toContain("crossed arms 2×, longest 7 s at 0:10 — You folded your arms and leaned back.");
    expect(t.jj[0]).toContain("at 0:09: You turned your back");
    expect(t.jj[0]).toContain("show_moments arms_crossed");
    expect(t.status()).toMatchObject({ state: "idle", detail: "run_1: 4 video notes (Gemini)" });
  });

  it("deletes the uploaded file even when the model fails, and falls back to the episodes", async () => {
    const t = listenJJ(setup({ client: { ask: async () => { throw new Error("503 overloaded"); } } }));
    t.start(run({ episodes: [ep("arms_crossed", 80, 87, 2)] }));
    t.end();
    await t.settle();
    expect(t.calls).toEqual(["upload true video/webm", "active", "delete files/abc"]);
    expect(t.notes()).toEqual([{ runId: "run_1", kind: "arms_crossed", atMs: 80_000, durationMs: 7_000, text: "Crossed arms for 7 s at 1:20 (slide 3)." }]);
    expect(t.jj[0]).toBe("[BODY] run_1: 1) crossed arms 1×, longest 7 s at 1:20. Recording available: offer show_moments arms_crossed.");
  });

  it("without a key, a recording or consent to analyse: deterministic notes, nothing uploaded", async () => {
    for (const o of [{ apiKey: null }, { recording: false }, { enabled: false }]) {
      const t = listenJJ(setup(o));
      t.start(run({ episodes: [ep("arms_crossed", 80, 87, 2), ep("arms_crossed", 90, 92), ep("sway", 100, 104)] }));
      t.end();
      await t.settle();
      expect(t.calls).toEqual([]);
      expect(t.notes().map((n) => n.text)).toEqual(["Crossed arms for 7 s at 1:20 (slide 3).", "Crossed arms for 2 s at 1:30 (slide 2).", "Swaying for 4 s at 1:40 (slide 2)."]);
      expect(t.jj[0]).toMatch(/^\[BODY\] run_1: 1\) crossed arms 2×, longest 7 s at 1:20 2\) swaying 1×, longest 4 s at 1:40\./);
    }
  });

  it("knows every camera behaviour: head tilt and hands in pockets read as words, and the model may name them", async () => {
    const prompts: string[] = [];
    const extra = [{ atS: 20, durationS: 4, kind: "hands_in_pockets", text: "Your hands went into your pockets." }];
    const t = listenJJ(setup({ client: { ask: async (q) => { prompts.push(q.prompt); return { moments: [], extra }; } } }));
    t.start(run({ episodes: [ep("head_tilt", 40, 43), ep("hands_in_pockets", 50, 56)] }));
    t.end();
    await t.settle();
    expect(prompts[0]).toContain("1. head_tilt (tilting your head) from 43.0 s (0:43)");
    expect(t.notes().map((n) => [n.kind, n.text])).toEqual([
      ["hands_in_pockets", "Your hands went into your pockets."],
      ["head_tilt", "Tilting your head for 3 s at 0:40 (slide 2)."],
      ["hands_in_pockets", "Hands in your pockets for 6 s at 0:50 (slide 2)."],
    ]);
  });

  it("SWARM_VIDEO_ANALYSIS (config) defaults to on; 0 turns the upload off", () => {
    expect(readConfig({}).brain.SWARM_VIDEO_ANALYSIS).toBe("1");
    expect(readConfig({ SWARM_VIDEO_ANALYSIS: "0" }).brain.SWARM_VIDEO_ANALYSIS).toBe("0");
    expect(() => readConfig({ SWARM_VIDEO_ANALYSIS: "yes" })).toThrow(/SWARM_VIDEO_ANALYSIS/);
  });
});
