/**
 * Reporter agent: writes the coach's analysis of each run and of the session (protocol RunNarrative /
 * SessionNarrative) with an LLM from the board (the listener's phrases with fillers, the judges'
 * lines, the body agent's video notes) and the RunLog (digest, episodes, Q&A, progress), and falls
 * back to a deterministic narrative from the same data whenever the LLM fails (no key, timeout, 503).
 *
 * - Run: ~3 s after a run ends (so the listener's last phrases and the director's notes land).
 * - Session: on `report.make {scope: "session"}`, on `show_final`, or when the stage asks for it.
 * - `report.make {scope: "run", runId?, focus?}` rebuilds a run's report (JJ's focus goes to the LLM).
 * Each report → board `setRunReport` / `setSessionReport`, a `report.ready` event and a note to JJ.
 *
 *   GET /api/swarm/report/run/:runId        → { status: "pending" | "ready" | "none", report }
 *   GET /api/swarm/report/session           → same shape (starts building it when missing or stale)
 *   GET /api/swarm/report/session.html      → the printable page (reportPdf.ts)
 *   GET /api/swarm/report/session.pdf[?download=1] → that page as a PDF (local Chrome; 501 without one),
 *                                              saved as SESSION_DIR/<sessionId>/report.pdf (a reset erases it)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { RunNarrative as RunNarrativeSchema, SessionNarrative as SessionNarrativeSchema, type RunId, type RunNarrative, type SessionNarrative } from "@coach/protocol";
import type { SwarmContext } from "./context.ts";
import { llmJson } from "./llm.ts";
import {
  fallbackRun, fallbackSession, gatherRun, gatherSession, mergeRun, mergeSession, runPrompt, sessionPrompt,
  RUN_SCHEMA, RUN_SYSTEM, SESSION_SCHEMA, SESSION_SYSTEM, type RunLlmOut, type SessionLlmOut,
} from "./reportData.ts";
import { buildReportHtml, findChrome, renderPdf } from "./reportPdf.ts";

export type ReporterLlm = <T>(o: { system: string; prompt: string; schema: Record<string, unknown>; timeoutMs: number }) => Promise<T>;
export interface ReporterOptions {
  /** Injected in tests; default llmJson with ctx.models.report. */
  llm?: ReporterLlm;
  /** Wait after a run ends before writing (default 3000 ms). */
  settleMs?: number;
  /** Longest wait for the body agent's video notes after a run ends (default 25 s). */
  maxWaitMs?: number;
  /** LLM timeout (default 20 s). */
  timeoutMs?: number;
  /** Chrome for the PDF; undefined = findChrome(), null = none. */
  chromePath?: string | null;
  /** HTML → PDF (default playwright-core + chromePath). */
  renderPdf?: (html: string) => Promise<Buffer>;
}
export interface Reporter {
  buildRun(runId: RunId, focus?: string | null, force?: boolean): Promise<RunNarrative | null>;
  buildSession(focus?: string | null, force?: boolean): Promise<SessionNarrative | null>;
}
export type NarrativeReply<T> = { status: "pending" | "ready" | "none"; report: T | null };

export function installReporter(ctx: SwarmContext, opts: ReporterOptions = {}): Reporter {
  const { board, runLog, log } = ctx;
  const session = () => ctx.brain.session.get();
  const settleMs = opts.settleMs ?? 3_000;
  const maxWaitMs = Math.max(settleMs, opts.maxWaitMs ?? 25_000);
  const timeoutMs = opts.timeoutMs ?? 25_000;
  // Low thinking: ~2x faster on gemini-3.5-flash-lite (measured 8.5 s vs 15 s under load); a model that
  // rejects thinkingLevel (400 INVALID_ARGUMENT) is asked again without it; an overloaded one (503) once
  // more if half the time budget is left.
  const llm: ReporterLlm = opts.llm ?? (async <T,>(o: Parameters<ReporterLlm>[0]) => {
    const t0 = Date.now();
    const base = { apiKey: ctx.models.apiKey, model: ctx.models.report, ...o };
    const low = { ...base, config: { thinkingConfig: { thinkingLevel: "low" } } };
    try { return await llmJson<T>(low); }
    catch (err) {
      const left = o.timeoutMs - (Date.now() - t0);
      if (/INVALID_ARGUMENT/.test(String(err))) return llmJson<T>({ ...base, timeoutMs: Math.max(1_000, left) });
      if (/\b503\b|UNAVAILABLE/.test(String(err)) && left > o.timeoutMs / 2) return llmJson<T>({ ...low, timeoutMs: left });
      throw err;
    }
  });
  let gen = 0;                                             // bumped on reset: late results of the old session are dropped
  const runJobs = new Map<RunId, Promise<RunNarrative | null>>();
  const settling = new Map<RunId, unknown>();             // runId → settle timer
  let sessionJob: Promise<SessionNarrative | null> | null = null;
  let pdfJob: Promise<Buffer> | null = null;

  board.status("reporter", "idle", "waiting for a run to end");
  const endedRuns = () => runLog.list().filter((r) => r.run.phase === "ended").sort((a, b) => a.run.index - b.run.index);
  const storedRun = (runId: RunId) => { const r = RunNarrativeSchema.safeParse(board.runReport(runId)); return r.success ? r.data : null; };
  const storedSession = () => { const r = SessionNarrativeSchema.safeParse(board.sessionReport()); return r.success ? r.data : null; };
  /** The stored session report covers exactly the finished runs. */
  const sessionFresh = (n: SessionNarrative | null) => {
    const ids = endedRuns().map((r) => r.runId);
    return !!n && n.runs.length === ids.length && n.runs.every((r, i) => r.runId === ids[i]);
  };

  async function ask<T>(what: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<{ out: T | null; ms: number; err: string | null }> {
    const t0 = Date.now();
    try {
      const out = await llm<T>({ system, prompt, schema, timeoutMs });
      return { out, ms: Date.now() - t0, err: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", "swarm.reporter.llm_failed", { what, err: msg.slice(0, 200), ms: Date.now() - t0 });
      return { out: null, ms: Date.now() - t0, err: msg };
    }
  }

  function buildRun(runId: RunId, focus: string | null = null, force = false): Promise<RunNarrative | null> {
    const running = runJobs.get(runId);
    if (running) return running;
    if (!force && storedRun(runId)) return Promise.resolve(storedRun(runId));
    const rec = runLog.get(runId);
    if (!rec || rec.run.phase !== "ended") return Promise.resolve(null);
    const t = settling.get(runId);
    if (t !== undefined) { ctx.clock.clearTimeout(t); settling.delete(runId); waitStart.delete(runId); }
    const myGen = gen;
    const job = (async () => {
      const index = rec.run.index;
      board.status("reporter", "thinking", `writing run ${index} report`);
      try {
        const inputs = gatherRun({ board, rec, session: session(), records: runLog.list(), focus });
        const notes = inputs.videoNotes.length;
        const update = storedRun(runId) !== null;
        const { out, ms, err } = await ask<RunLlmOut>(`run_${index}`, RUN_SYSTEM, runPrompt(inputs), RUN_SCHEMA as unknown as Record<string, unknown>);
        if (myGen !== gen) return null;
        const n = out ? mergeRun(out, inputs, ctx.clock.now()) : fallbackRun(inputs, ctx.clock.now());
        board.setRunReport(runId, n);
        notesAt.set(runId, notes);
        board.emit({ type: "report.ready", scope: "run", runId });
        board.note("reporter", `[REPORTER] run ${index} report ${update ? "updated" : "ready"}: ${n.headline}${n.improvements[0] ? ` Top fix: ${n.improvements[0].title}.` : ""}`);
        board.status("reporter", "idle", `ready: run ${index} report${n.source === "fallback" ? ` (from the data${err ? `; LLM: ${err.slice(0, 60)}` : ""})` : ""}`);
        log("info", "swarm.reporter.run_ready", { runId, source: n.source, ms });
        return n;
      } catch (err) {
        if (myGen === gen) board.status("reporter", "error", `error: run ${index} report: ${String(err).slice(0, 100)}`);
        log("error", "swarm.reporter.run_failed", { runId, err: String(err) });
        return null;
      }
    })().finally(() => { if (runJobs.get(runId) === job) runJobs.delete(runId); });
    runJobs.set(runId, job);
    return job;
  }

  function buildSession(focus: string | null = null, force = false): Promise<SessionNarrative | null> {
    if (sessionJob) return sessionJob;
    if (!force && sessionFresh(storedSession())) return Promise.resolve(storedSession());
    if (endedRuns().length === 0) return Promise.resolve(null);
    const myGen = gen;
    const job = (async () => {
      board.status("reporter", "thinking", "writing the session report");
      try {
        await Promise.allSettled([...runJobs.values()]);    // the run reports being written go in
        if (myGen !== gen) return null;
        const inputs = gatherSession({ board, session: session(), records: runLog.list(), focus, now: ctx.clock.now() });
        const { out, ms, err } = await ask<SessionLlmOut>("session", SESSION_SYSTEM, sessionPrompt(inputs), SESSION_SCHEMA as unknown as Record<string, unknown>);
        if (myGen !== gen) return null;
        const n = out ? mergeSession(out, inputs, ctx.clock.now()) : fallbackSession(inputs, ctx.clock.now());
        board.setSessionReport(n);
        board.emit({ type: "report.ready", scope: "session" });
        board.note("reporter", `[REPORTER] session report ready (${n.runs.length} run${n.runs.length === 1 ? "" : "s"}): ${n.headline}${n.focus[0] ? ` Focus next: ${n.focus.map((f) => f.title).join("; ")}.` : ""}`);
        board.status("reporter", "idle", `ready: session report${n.source === "fallback" ? ` (from the data${err ? `; LLM: ${err.slice(0, 60)}` : ""})` : ""}`);
        log("info", "swarm.reporter.session_ready", { source: n.source, ms, runs: n.runs.length });
        return n;
      } catch (err) {
        if (myGen === gen) board.status("reporter", "error", `error: session report: ${String(err).slice(0, 100)}`);
        log("error", "swarm.reporter.session_failed", { err: String(err) });
        return null;
      }
    })().finally(() => { if (sessionJob === job) sessionJob = null; });
    sessionJob = job;
    return job;
  }

  // ---- triggers ----
  // A run's report waits settleMs (the listener's last phrases, the director's notes), then for the
  // body agent's video notes: they land 10-15 s after the run, all at once, while body is "thinking".
  // Capped at maxWaitMs; notes that come later trigger one rebuild.
  const bodyThinking = () => board.allStatuses().find((a) => a.id === "body")?.state === "thinking";
  const waitStart = new Map<RunId, number>();
  const gotNotes = new Set<RunId>();                       // video notes arrived after the run ended
  const notesAt = new Map<RunId, number>();               // video notes the stored report was built with
  const tryBuild = (runId: RunId) => {
    const since = waitStart.get(runId);
    if (since === undefined || !settling.has(runId)) return;
    const waited = ctx.clock.now() - since;
    const hasNotes = gotNotes.has(runId);
    if (waited < settleMs || (bodyThinking() && !hasNotes && waited < maxWaitMs)) return;
    ctx.clock.clearTimeout(settling.get(runId));
    settling.delete(runId); waitStart.delete(runId);
    void buildRun(runId);
  };
  runLog.onRunEnded((rec) => {
    if (rec.run.phase !== "ended") return;                  // aborted: no report
    const runId = rec.runId;
    board.status("reporter", "working", `waiting for run ${rec.run.index}'s last notes`);
    const old = settling.get(runId);
    if (old !== undefined) ctx.clock.clearTimeout(old);
    waitStart.set(runId, ctx.clock.now());
    settling.set(runId, ctx.clock.setTimeout(() => {
      if (bodyThinking() && !gotNotes.has(runId)) {
        board.status("reporter", "working", `waiting for run ${rec.run.index}'s video notes`);
        settling.set(runId, ctx.clock.setTimeout(() => tryBuild(runId), Math.max(0, maxWaitMs - settleMs)));   // the cap
      }
      tryBuild(runId);
    }, settleMs));
  });
  board.onStatus((all) => {
    if (all.find((a) => a.id === "body")?.state === "thinking") return;
    for (const runId of [...settling.keys()]) tryBuild(runId);
  });
  let notesTimer: unknown = null;
  board.on("video.note", (e) => {
    const runId = e.note.runId;
    if (settling.has(runId)) {                              // they come all at once: let the rest land
      gotNotes.add(runId);
      if (notesTimer) ctx.clock.clearTimeout(notesTimer);
      notesTimer = ctx.clock.setTimeout(() => { notesTimer = null; tryBuild(runId); }, 1_000);
      return;
    }
    if (notesTimer) ctx.clock.clearTimeout(notesTimer);
    notesTimer = ctx.clock.setTimeout(() => {               // late notes: rebuild the report once they're in
      notesTimer = null;
      const rebuild = () => { if (storedRun(runId) && (notesAt.get(runId) ?? 0) < board.videoNotes(runId).length) void buildRun(runId, null, true); };
      const job = runJobs.get(runId);
      if (job) void job.then(rebuild); else rebuild();
    }, 1_500);
  });
  board.onCommand("report.make", (c) => {
    if (c.scope === "session") { void buildSession(c.focus ?? null, true); return; }
    const runId = c.runId ?? endedRuns().at(-1)?.runId;
    if (runId) void buildRun(runId, c.focus ?? null, true);
  });
  ctx.brain.session.subscribe((_s, cause) => {
    if (Array.isArray(cause)) return;
    if (cause.type === "show_final") void buildSession();
    if (cause.type === "reset") {
      gen++;
      for (const t of settling.values()) ctx.clock.clearTimeout(t);
      if (notesTimer) { ctx.clock.clearTimeout(notesTimer); notesTimer = null; }
      settling.clear(); waitStart.clear(); gotNotes.clear(); notesAt.clear(); runJobs.clear(); sessionJob = null; pdfJob = null;
      board.status("reporter", "idle", "waiting for a run to end");
    }
  });

  // ---- HTTP ----
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const runReply = (runId: RunId): NarrativeReply<RunNarrative> => {
    const stored = storedRun(runId);
    if (stored) return { status: "ready", report: stored };
    if (runJobs.has(runId) || settling.has(runId)) return { status: "pending", report: null };
    const rec = runLog.get(runId);
    if (!rec || rec.run.phase !== "ended") return { status: "none", report: null };
    void buildRun(runId);                                   // e.g. after a restart
    return { status: "pending", report: null };
  };
  const sessionReply = (): NarrativeReply<SessionNarrative> => {
    const stored = storedSession();
    if (sessionFresh(stored)) return { status: "ready", report: stored };
    if (endedRuns().length === 0) return { status: "none", report: null };
    void buildSession();
    return { status: "pending", report: stored };           // the older one, if any, while the new one is written
  };
  const pageHtml = async (): Promise<string | null> => {
    const n = await buildSession();
    if (!n) return null;
    const runs = endedRuns().map((r) => storedRun(r.runId) ?? fallbackRun(gatherRun({ board, rec: r, session: session(), records: runLog.list() }), ctx.clock.now()));
    return buildReportHtml({ s: session(), records: runLog.list(), session: n, runs, now: ctx.clock.now() });
  };
  const fileName = () => (session().context.brief?.title ?? "practice").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "practice";

  ctx.http(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") return false;
    const [path = "/", query = ""] = (req.url ?? "/").split("?");
    if (!path.startsWith("/api/swarm/report/")) return false;
    const m = /^\/api\/swarm\/report\/run\/([^/]+)$/.exec(path);
    if (m) { json(res, 200, runReply(decodeURIComponent(m[1]!) as RunId)); return true; }
    if (path === "/api/swarm/report/session") { json(res, 200, sessionReply()); return true; }
    if (path === "/api/swarm/report/session.html") {
      const html = await pageHtml();
      if (!html) { json(res, 404, { ok: false, reason: "not_available", hint: "no run has finished yet" }); return true; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return true;
    }
    if (path === "/api/swarm/report/session.pdf") {
      const chrome = opts.chromePath !== undefined ? opts.chromePath : findChrome();
      const render = opts.renderPdf ?? (chrome ? (html: string) => renderPdf(html, chrome) : null);
      if (!render) {
        json(res, 501, { ok: false, reason: "no_chrome", hint: "Install Google Chrome or set CHROME=/path/to/chrome for the PDF; the printable page is at /api/swarm/report/session.html" });
        return true;
      }
      try {
        const job = pdfJob ?? (pdfJob = (async () => {
          const html = await pageHtml();
          if (!html) throw Object.assign(new Error("no run has finished yet"), { notAvailable: true });
          const t0 = Date.now();
          const pdf = await render(html);
          const dir = ctx.sessionFolder();
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "report.pdf"), pdf);
          log("info", "swarm.reporter.pdf", { bytes: pdf.length, ms: Date.now() - t0, file: join(dir, "report.pdf") });
          return pdf;
        })().finally(() => { pdfJob = null; }));
        const pdf = await job;
        const headers: Record<string, string> = { "content-type": "application/pdf", "content-length": String(pdf.length), "cache-control": "no-store" };
        if (new URLSearchParams(query).get("download") === "1") headers["content-disposition"] = `attachment; filename="coach-report-${fileName()}.pdf"`;
        res.writeHead(200, headers);
        res.end(pdf);
      } catch (err) {
        if ((err as { notAvailable?: boolean }).notAvailable) json(res, 404, { ok: false, reason: "not_available", hint: "no run has finished yet" });
        else { log("error", "swarm.reporter.pdf_failed", { err: String(err) }); json(res, 500, { ok: false, reason: "pdf_failed", hint: String(err).slice(0, 200) }); }
      }
      return true;
    }
    return false;
  });

  return { buildRun, buildSession };
}
