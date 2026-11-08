/** Run recordings: chunks in order, served with ranges, and the moments JJ replays from them. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RunId } from "@coach/protocol";
import { MediaStore, mediaHttp, momentsOf, type Recording } from "../src/media.ts";
import type { RunRecord } from "../src/runlog.ts";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function store() {
  const dir = mkdtempSync(join(tmpdir(), "brain-media-")); dirs.push(dir);
  return { dir, media: new MediaStore({ dir, sessionId: () => "sess1", hasRun: (id) => id === "run_1" }) };
}

/** Calls the route with a body; resolves with status, headers and the response body. */
async function call(route: ReturnType<typeof mediaHttp>, method: string, url: string, body?: Buffer, headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method, url, headers });
  let status = 0, head: Record<string, unknown> = {};
  const out: Buffer[] = [];
  const res = Object.assign(new Writable({ write(c, _e, cb) { out.push(Buffer.from(c)); cb(); } }), {
    writeHead(code: number, h: Record<string, unknown> = {}) { status = code; head = h; return this; },
  });
  const finished = new Promise((r) => res.on("finish", r));
  const handled = route(req as never, res as never);
  req.end(body ?? Buffer.alloc(0));
  expect(await handled).toBe(true);
  await finished;
  return { status, head, body: Buffer.concat(out) };
}

describe("recordings", () => {
  it("are written chunk by chunk, in order, only for runs of this session", async () => {
    const { dir, media } = store();
    const route = mediaHttp(media, () => 9_000);
    const ct = { "content-type": "video/webm;codecs=vp8,opus" };
    expect((await call(route, "POST", "/api/media/run_1/chunk?seq=0&startedAt=1000", Buffer.from("AAA"), ct)).status).toBe(200);
    expect((await call(route, "POST", "/api/media/run_1/chunk?seq=2", Buffer.from("X"), ct)).status).toBe(409);
    expect((await call(route, "POST", "/api/media/run_1/chunk?seq=1", Buffer.from("BBBB"), ct)).status).toBe(200);
    expect((await call(route, "POST", "/api/media/run_9/chunk?seq=0&startedAt=1", Buffer.from("C"), ct)).status).toBe(404);
    expect(await route(Object.assign(new PassThrough(), { method: "POST", url: "/api/media/../x/chunk?seq=0", headers: {} }) as never, {} as never)).toBe(false);
    expect((await call(route, "POST", "/api/media/run_1/done")).status).toBe(200);
    expect(media.get("run_1")).toEqual({ runId: "run_1", mimeType: "video/webm;codecs=vp8,opus", startedAt: 1000, bytes: 7, chunks: 2, done: true, endedAt: 9_000 });
    expect(readFileSync(join(dir, "sess1", "media", "run_1.media"), "utf8")).toBe("AAABBBB");   // inside the session folder
    const list = await call(route, "GET", "/api/media");
    expect(JSON.parse(list.body.toString()).recordings).toHaveLength(1);
  });

  it("are served with byte ranges, so the stage can seek", async () => {
    const { media } = store();
    const route = mediaHttp(media);
    await call(route, "POST", "/api/media/run_1/chunk?seq=0&startedAt=1000", Buffer.from("0123456789"), { "content-type": "video/webm" });
    const all = await call(route, "GET", "/api/media/run_1/video");
    expect([all.status, all.head["content-type"], all.head["accept-ranges"], all.body.toString()]).toEqual([200, "video/webm", "bytes", "0123456789"]);
    const part = await call(route, "GET", "/api/media/run_1/video", undefined, { range: "bytes=2-5" });
    expect([part.status, part.head["content-range"], part.body.toString()]).toEqual([206, "bytes 2-5/10", "2345"]);
    const tail = await call(route, "GET", "/api/media/run_1/video", undefined, { range: "bytes=7-" });
    expect(tail.body.toString()).toBe("789");
    expect((await call(route, "GET", "/api/media/run_1/video", undefined, { range: "bytes=50-" })).status).toBe(416);
  });
});

describe("moments", () => {
  const recording: Recording = { runId: "run_2", mimeType: "video/webm", startedAt: 100_000, bytes: 1, chunks: 1, done: true, endedAt: 400_000 };
  const rec = (episodes: RunRecord["episodes"], observations: RunRecord["observations"] = []) => ({
    runId: "run_2" as RunId, run: { index: 2, presentationStartedAt: 103_000, startedAt: 100_000 } as RunRecord["run"],
    slides: [], observations, episodes, feedback: [], wakes: 0, qa: [], coachConnected: true, qaStartedAt: null, endedAt: 400_000, endedBy: null,
  }) as RunRecord;
  const ep = (startAt: number, ms: number, slideIndex = 0) => ({ kind: "arms_crossed" as const, startAt, endAt: startAt + ms, slideIndex, segment: "presentation" as const, conf: 1 });

  it("are clips of the run's recording around each episode, padded, in time order", () => {
    const m = momentsOf(rec([ep(160_000, 7_000, 1), ep(130_000, 3_000)]), recording, "arms_crossed");
    expect(m.total).toBe(2);
    expect(m.clips).toEqual([
      { url: "/api/media/run_2/video", fromS: 28.5, toS: 34.5, tRunMs: 27_000, slideIndex: 0, label: "0:27 · slide 1 · 3 s", seconds: 3 },
      { url: "/api/media/run_2/video", fromS: 58.5, toS: 68.5, tRunMs: 57_000, slideIndex: 1, label: "0:57 · slide 2 · 7 s", seconds: 7 },
    ]);
  });

  it("show at most five (the longest, still in time order), cap long ones, skip what was not recorded", () => {
    const eps = [1, 2, 3, 4, 5, 6, 7].map((i) => ep(100_000 + i * 20_000, i * 1000));
    const m = momentsOf(rec([ep(50_000, 5_000), ...eps, ep(300_000, 60_000)]), recording, "arms_crossed");
    expect(m.total).toBe(9);
    expect(m.clips.map((c) => c.seconds)).toEqual([4, 5, 6, 7, 60]);
    expect(m.clips.at(-1)!.toS - m.clips.at(-1)!.fromS).toBeCloseTo(13.5);   // 12 s of a 60 s episode, plus padding
  });

  it("fall back to rule observations (speech) with the seconds before each one", () => {
    const obs = [{ rule: "speech.fillers", kind: "filler_burst" as const, category: "disfluencies" as const, text: "", at: 150_000, slideIndex: 2, segment: "presentation" as const }];
    const m = momentsOf(rec([], obs), recording, "filler_burst");
    expect(m.clips).toEqual([expect.objectContaining({ fromS: 40.5, toS: 51.5, label: "0:39 · slide 3" })]);
  });
});
