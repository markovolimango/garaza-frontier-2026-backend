/**
 * SessionPersistence: the session and its run log survive a brain restart.
 *
 *   SESSION_DIR/latest.json                { sessionId, savedAt }
 *   SESSION_DIR/<sessionId>/session.json   { version: 1, savedAt, state: SessionState, runs: RunRecord[] }
 *
 * Saved atomically (write a temp file, rename) at most every `debounceMs` after a session or
 * run-log change, and on shutdown (`saveNow`). On start, server.ts loads the latest session and
 * passes it to createBrain({ restore }) and RunLog({ restore }); `--fresh` / BRAIN_FRESH=1 starts
 * a new one instead. Uploads (slide images, docs) are on disk already, under
 * SESSION_DIR/<sessionId>/uploads.
 *
 * Routes (createBrain `http` option):
 *   GET  /api/session          { sessionId, phase, runs, savedAt }
 *   POST /api/session/reset    { full?: boolean = true } → a new session (full: without the deck, intro again)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { BehaviorKind, CoachState, FeedbackCategory, JudgeId, RunId, RunState, SessionState } from "@coach/protocol";
import { z } from "zod";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";
import type { RunLog, RunRecord } from "./runlog.ts";
import type { SessionStore } from "./session.ts";

const RunRecordSchema = z.object({
  runId: RunId,
  run: RunState,
  slides: z.array(z.object({ index: z.number().int(), at: z.number() })),
  observations: z.array(z.object({
    rule: z.string(), kind: BehaviorKind.nullable().catch(null), category: FeedbackCategory.nullable().catch(null), text: z.string(),
    at: z.number(), slideIndex: z.number().int(), segment: z.enum(["presentation", "qa"]),
  })),
  // episodes: added after the first saved sessions, so files without them still load
  episodes: z.array(z.object({
    kind: BehaviorKind, startAt: z.number(), endAt: z.number().nullable(), slideIndex: z.number().int(),
    segment: z.enum(["presentation", "qa"]), conf: z.number(),
  })).default([]),
  feedback: z.array(z.object({ kind: z.enum(["warn", "reward"]), at: z.number() })),
  wakes: z.number().int(),
  qa: z.array(z.object({ judgeId: JudgeId, judgeTitle: z.string(), question: z.string(), askedAt: z.number(), answerMs: z.number(), answer: z.string().optional() })),
  coachConnected: z.boolean(),
  qaStartedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endedBy: z.enum(["qa_done", "end_run", "presentation_done", "aborted"]).nullable(),
  coachAfter: z.object({ score: z.number(), stage: CoachState.shape.stage }).nullable().optional(),
});

export const SavedSession = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  state: SessionState,
  runs: z.array(RunRecordSchema),
});
export interface SavedSession { version: 1; savedAt: number; state: SessionState; runs: RunRecord[] }

const Latest = z.object({ sessionId: z.string().min(1), savedAt: z.number() });

/** The latest saved session in `dir`, or null (none, unreadable or invalid: logged, never thrown). */
export function loadLatest(dir: string, log: Logger = () => {}): SavedSession | null {
  const latestFile = join(dir, "latest.json");
  if (!existsSync(latestFile)) return null;
  let file = latestFile;
  try {
    const latest = Latest.parse(JSON.parse(readFileSync(latestFile, "utf8")));
    if (!/^[\w-]+$/.test(latest.sessionId)) throw new Error("bad session id");
    file = join(dir, latest.sessionId, "session.json");
    const parsed = SavedSession.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return parsed.data as SavedSession;
  } catch (err) {
    log("warn", "persist.load_failed", { file, err: String(err).slice(0, 500), hint: "starting a new session; the file is kept" });
    return null;
  }
}

export interface SessionPersistenceOptions {
  dir: string;
  session: SessionStore;
  runLog: RunLog;
  clock: Clock;
  log?: Logger;
  /** Coalesce saves: at most one write per this many ms. Default 500. */
  debounceMs?: number;
}

export class SessionPersistence {
  private timer: unknown = null;
  private lastSavedAt: number | null = null;
  private readonly log: Logger;

  constructor(private readonly o: SessionPersistenceOptions) {
    this.log = o.log ?? (() => {});
    o.session.subscribe(() => this.schedule());
    o.runLog.onChanged(() => this.schedule());
  }

  get savedAt(): number | null { return this.lastSavedAt; }

  /** Writes now (shutdown, tests). Never throws: a full disk must not stop the demo. */
  saveNow(): boolean {
    if (this.timer) { this.o.clock.clearTimeout(this.timer); this.timer = null; }
    const state = this.o.session.get();
    const savedAt = this.o.clock.now();
    const body: SavedSession = { version: 1, savedAt, state, runs: this.o.runLog.list() };
    try {
      const dir = join(this.o.dir, state.sessionId);
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, "session.json"), JSON.stringify(body));
      writeAtomic(join(this.o.dir, "latest.json"), JSON.stringify({ sessionId: state.sessionId, savedAt }));
      this.lastSavedAt = savedAt;
      return true;
    } catch (err) {
      this.log("error", "persist.save_failed", { err: String(err) });
      return false;
    }
  }

  /** Erases a saved session from disk: session.json, its runs and reports, and its uploads (slides, docs). */
  deleteSession(sessionId: string): boolean {
    if (!/^[\w-]+$/.test(sessionId)) return false;
    try {
      rmSync(join(this.o.dir, sessionId), { recursive: true, force: true });
      this.log("info", "persist.session_deleted", { sessionId });
      return true;
    } catch (err) {
      this.log("error", "persist.delete_failed", { sessionId, err: String(err) });
      return false;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = this.o.clock.setTimeout(() => { this.timer = null; this.saveNow(); }, this.o.debounceMs ?? 500);
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** GET /api/session, POST /api/session/reset {full?: boolean = true, keepData?: boolean = false}: a full
 *  reset erases the previous session from disk (runs, reports, personal goals, uploads) unless keepData. */
export function sessionHttp(o: { session: SessionStore; runLog: RunLog; persistence: SessionPersistence | null }) {
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/api/session") {
      const s = o.session.get();
      json(res, 200, { sessionId: s.sessionId, phase: s.phase, runs: o.runLog.list().length, savedAt: o.persistence?.savedAt ?? null });
      return true;
    }
    if (req.method === "POST" && path === "/api/session/reset") {
      let full = true, keepData = false;
      const text = await readText(req);
      if (text.trim()) {
        try {
          const body = JSON.parse(text) as { full?: unknown; keepData?: unknown };
          full = body.full !== false;
          keepData = body.keepData === true;
        } catch { json(res, 400, { ok: false, reason: "invalid_args", hint: "body must be JSON {full?: boolean, keepData?: boolean}" }); return true; }
      }
      const previous = o.session.get().sessionId;
      const r = o.session.dispatch({ type: "reset", full });
      if (!r.ok) { json(res, 409, r); return true; }
      o.persistence?.saveNow();
      // A partial reset keeps the deck (its slides live in the previous session's uploads), so it erases nothing.
      const deleted = full && !keepData && !!o.persistence?.deleteSession(previous);
      json(res, 200, { ok: true, sessionId: o.session.get().sessionId, full, deleted });
      return true;
    }
    return false;
  };
}

function readText(req: IncomingMessage, maxBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > maxBytes) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
