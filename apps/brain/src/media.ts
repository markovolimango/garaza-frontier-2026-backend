/**
 * Run recordings (camera + microphone, recorded by the stage's browser with the presenter's consent)
 * and the moments JJ replays from them ("you did this 5 times, here they are").
 *
 * Kept only on this computer, inside the session folder (SESSION_DIR/<sessionId>/media/), so the
 * full reset ("Delete and start over") erases them with the rest of the session.
 *
 *   POST /api/media/:runId/chunk?seq=N&startedAt=ms   the next MediaRecorder chunk (≤ 25 MB, in order)
 *   POST /api/media/:runId/done                       recording finished
 *   GET  /api/media/:runId/video                      the recording, with Range support (seeking)
 *   GET  /api/media                                   this session's recordings
 *
 * MediaRecorder WebM has no duration or cues, but Chrome seeks in it over HTTP ranges, so the stage
 * plays a moment by seeking the run's file: no transcoding, no ffmpeg.
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { BehaviorKind } from "@coach/protocol";
import { mmss } from "./format.ts";
import { readBody } from "./http.ts";
import type { Logger } from "./log.ts";
import type { RunRecord } from "./runlog.ts";

export interface Recording {
  runId: string; mimeType: string; startedAt: number; bytes: number; chunks: number; done: boolean; endedAt: number | null;
}

const RUN_ID = /^run_\d{1,4}$/;
const MAX_CHUNK = 25 * 1024 * 1024;
const MIME = /^(video|audio)\/(webm|mp4)(;[\w=.,\s-]*)?$/;

export class MediaStore {
  constructor(private readonly o: { dir: string; sessionId: () => string; hasRun: (runId: string) => boolean; log?: Logger }) {}

  private folder(): string { return join(this.o.dir, this.o.sessionId(), "media"); }
  private metaFile(runId: string): string { return join(this.folder(), `${runId}.json`); }
  file(runId: string): string { return join(this.folder(), `${runId}.media`); }

  get(runId: string): Recording | null {
    if (!RUN_ID.test(runId)) return null;
    try { return JSON.parse(readFileSync(this.metaFile(runId), "utf8")) as Recording; } catch { return null; }
  }

  list(): Recording[] {
    const out: Recording[] = [];
    for (let i = 1; i < 1000; i++) { const r = this.get(`run_${i}`); if (r) out.push(r); else if (i > 50) break; }
    return out;
  }

  /** Appends chunk `seq` (0 starts the recording). Out-of-order chunks are refused with the expected seq. */
  append(runId: string, seq: number, data: Buffer, o: { startedAt?: number; mimeType?: string }):
    { ok: true; bytes: number } | { ok: false; reason: string; hint: string; expected?: number } {
    if (!RUN_ID.test(runId) || !this.o.hasRun(runId)) return { ok: false, reason: "not_found", hint: "no such run in this session" };
    let rec = this.get(runId);
    if (seq === 0) {
      if (!o.startedAt || !Number.isFinite(o.startedAt)) return { ok: false, reason: "invalid_args", hint: "the first chunk needs startedAt (epoch ms)" };
      const mimeType = o.mimeType && MIME.test(o.mimeType) ? o.mimeType : "video/webm";
      mkdirSync(this.folder(), { recursive: true });
      writeFileSync(this.file(runId), new Uint8Array());
      rec = { runId, mimeType, startedAt: o.startedAt, bytes: 0, chunks: 0, done: false, endedAt: null };
    } else if (!rec || rec.done || seq !== rec.chunks) {
      return { ok: false, reason: "out_of_order", hint: "send chunks in order, starting at 0", expected: rec && !rec.done ? rec.chunks : 0 };
    }
    appendFileSync(this.file(runId), new Uint8Array(data));
    rec.bytes += data.length;
    rec.chunks += 1;
    writeFileSync(this.metaFile(runId), JSON.stringify(rec));
    return { ok: true, bytes: rec.bytes };
  }

  finish(runId: string, endedAt: number): boolean {
    const rec = this.get(runId);
    if (!rec) return false;
    rec.done = true;
    rec.endedAt = endedAt;
    writeFileSync(this.metaFile(runId), JSON.stringify(rec));
    this.o.log?.("info", "media.recorded", { runId, mb: Math.round(rec.bytes / 1e5) / 10, chunks: rec.chunks });
    return true;
  }
}

// ---------------------------------------------------------------- moments

export interface Clip { url: string; fromS: number; toS: number; tRunMs: number; slideIndex: number; label: string; seconds: number }

const PAD_S = 1.5;            // context before and after each moment
const MAX_CLIP_S = 12;        // a long episode shows its first 12 s
const SPEECH_LOOKBACK_S = 8;  // rule observations (speech) fire after the fact: show the seconds before

/**
 * The moments of one behaviour in one run as clips of its recording: every episode (or, for behaviours
 * without episodes, every rule observation), at most `max`: the longest ones, shown in time order.
 */
export function momentsOf(rec: RunRecord, recording: Recording, kind: BehaviorKind, max = 5): { total: number; clips: Clip[] } {
  const runStart = rec.run.presentationStartedAt ?? rec.run.startedAt ?? recording.startedAt;
  const until = rec.endedAt ?? recording.endedAt ?? Number.MAX_SAFE_INTEGER;
  type M = { startAt: number; endAt: number; slideIndex: number; precise: boolean };
  const episodes: M[] = (rec.episodes ?? []).filter((e) => e.kind === kind)
    .map((e) => ({ startAt: e.startAt, endAt: e.endAt ?? until, slideIndex: e.slideIndex, precise: true }));
  const moments: M[] = episodes.length ? episodes : rec.observations.filter((o) => o.kind === kind)
    .map((o) => ({ startAt: o.at - SPEECH_LOOKBACK_S * 1000, endAt: o.at, slideIndex: o.slideIndex, precise: false }));
  const recorded = moments.filter((m) => m.endAt > recording.startedAt);
  const chosen = [...recorded].sort((a, b) => (b.endAt - b.startAt) - (a.endAt - a.startAt)).slice(0, max).sort((a, b) => a.startAt - b.startAt);
  const url = `/api/media/${rec.runId}/video`;
  const clips = chosen.map((m) => {
    const fromS = Math.max(0, (m.startAt - recording.startedAt) / 1000 - PAD_S);
    const toS = Math.max(fromS + 1, Math.min(fromS + MAX_CLIP_S + PAD_S, (m.endAt - recording.startedAt) / 1000 + PAD_S));
    const tRunMs = Math.max(0, m.startAt - runStart);
    const seconds = Math.round((m.endAt - m.startAt) / 1000);
    const label = `${mmss(tRunMs)} · slide ${m.slideIndex + 1}${m.precise ? ` · ${seconds} s` : ""}`;
    return { url, fromS: round1(fromS), toS: round1(toS), tRunMs, slideIndex: m.slideIndex, label, seconds };
  });
  return { total: moments.length, clips };
}
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- HTTP

export function mediaHttp(store: MediaStore, now: () => number = Date.now) {
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const [path = "/", query = ""] = (req.url ?? "/").split("?");
    if (req.method === "GET" && path === "/api/media") { json(res, 200, { recordings: store.list() }); return true; }
    const m = /^\/api\/media\/([^/]+)\/(chunk|done|video)$/.exec(path);
    if (!m) return false;
    const [, runId = "", action] = m;
    if (req.method === "POST" && action === "chunk") {
      const q = new URLSearchParams(query);
      const seq = Number(q.get("seq"));
      if (!Number.isInteger(seq) || seq < 0) { json(res, 400, { ok: false, reason: "invalid_args", hint: "seq must be an integer ≥ 0" }); return true; }
      const body = await readBody(req, MAX_CHUNK);
      if (!body) { json(res, 413, { ok: false, reason: "too_large", hint: "chunks up to 25 MB" }); return true; }
      const r = store.append(runId, seq, body, { startedAt: Number(q.get("startedAt")), mimeType: String(req.headers["content-type"] ?? "") });
      json(res, r.ok ? 200 : r.reason === "not_found" ? 404 : r.reason === "out_of_order" ? 409 : 400, r);
      return true;
    }
    if (req.method === "POST" && action === "done") {
      json(res, store.finish(runId, now()) ? 200 : 404, { ok: store.get(runId)?.done === true });
      return true;
    }
    if (req.method === "GET" && action === "video") {
      const rec = store.get(runId);
      const file = store.file(runId);
      if (!rec || !existsSync(file)) { json(res, 404, { ok: false, reason: "not_found" }); return true; }
      serveRange(req, res, file, rec.mimeType.split(";")[0]!);
      return true;
    }
    return false;
  };
}

function serveRange(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (!range || size === 0) {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) { res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }); res.end(); return; }
  res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}
