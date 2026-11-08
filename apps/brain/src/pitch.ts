/**
 * Pitch mode: the stage demo. The presenter just talks; JJ stays silent, there is no countdown, no deck
 * and no Q&A. The listener (transcript, fillers), the camera coach (episodes), the recorder and the
 * reporter work as in any run. One click ends the talk and the stage shows the dashboard.
 *
 *   POST /api/pitch/start      → { ok, runId }   JJ goes silent; a pitch run starts listening at once
 *   POST /api/pitch/stop       → { ok, runId }   ends the talk (the reporter starts writing)
 *   POST /api/pitch/exit       → { ok }          leaves pitch mode: JJ may talk again (409 during a pitch)
 *   GET  /api/pitch/dashboard[/:runId] → PitchDashboard (the latest pitch run without an id)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BehaviorKind, PitchDashboard, Result, SessionState } from "@coach/protocol";
import type { Clock } from "./clock.ts";
import { RULE_LABELS, ruleOfKind } from "./digest.ts";
import { BEHAVIOR_WORDS } from "./observedCoach.ts";
import type { RunLog, RunRecord } from "./runlog.ts";
import type { SessionAction, SessionCause } from "./session.ts";
import type { Phrase } from "./swarm/board.ts";

export interface PitchDeps {
  session: {
    get(): Readonly<SessionState>; dispatch(a: SessionAction): Result;
    subscribe(fn: (s: Readonly<SessionState>, cause: SessionCause) => void): unknown;
  };
  runLog: Pick<RunLog, "get" | "list">;
  /** The listener's phrases of a run (swarm board). */
  phrases: (runId: string) => Phrase[];
  jj: { setSilent(on: boolean): void };
  clock: Clock;
}

export class PitchMode {
  constructor(private readonly o: PitchDeps) {
    // The coaching loop takes over again (a reset, a session start, a normal run): JJ gets its voice back,
    // also when the pitch page was closed without leaving pitch mode.
    o.session.subscribe((_s, cause) => {
      if (Array.isArray(cause)) return;
      if (cause.type === "reset" || cause.type === "session_start" || cause.type === "run_it_back"
        || (cause.type === "start_run" && !("pitch" in cause && cause.pitch))) o.jj.setSilent(false);
    });
  }

  start(): Result & { runId?: string } {
    const s = this.o.session.get();
    if (s.phase === "running" && s.run?.pitch && s.run.phase === "presentation") return { ok: true, runId: s.run.runId };   // double click
    this.o.jj.setSilent(true);
    const r = this.o.session.dispatch({ type: "start_run", pitch: true });
    if (!r.ok) return { ...r, hint: r.reason === "wrong_phase" ? "a run is in progress: end it first" : r.hint };
    return { ok: true, runId: this.o.session.get().run!.runId };
  }

  stop(): Result & { runId?: string } {
    const run = this.o.session.get().run;
    if (!run?.pitch) return { ok: false, reason: "not_available", hint: "no pitch is being recorded" };
    if (run.phase === "ended" || run.phase === "aborted") return { ok: true, runId: run.runId };
    const r = this.o.session.dispatch({ type: "end_run" });
    return r.ok ? { ok: true, runId: run.runId } : r;
  }

  /** JJ may talk again; not while a pitch is being recorded (JJ would speak over it at its end). */
  exit(): Result {
    const run = this.o.session.get().run;
    if (run?.pitch && run.phase === "presentation") return { ok: false, reason: "wrong_phase", hint: "a pitch is being recorded: stop it first" };
    this.o.jj.setSilent(false);
    return { ok: true };
  }

  dashboard(runId?: string): PitchDashboard | null {
    const rec = runId ? this.o.runLog.get(runId) : this.o.runLog.list().filter((r) => r.run.pitch).at(-1) ?? null;
    if (!rec || !rec.run.pitch) return null;
    return buildPitchDashboard(rec, this.o.phrases(rec.runId), this.o.clock.now());
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildPitchDashboard(rec: RunRecord, phrases: Phrase[], now: number): PitchDashboard {
  const start = rec.run.presentationStartedAt ?? rec.run.startedAt ?? now;
  const live = rec.endedAt === null;
  const end = rec.endedAt ?? now;
  const durationMs = Math.max(0, end - start - (rec.run.pausedMs ?? 0));
  const minutes = durationMs / 60_000;
  const t = (at: number) => Math.max(0, at - start);

  // speech: the listener's phrases of the talk
  const talk = phrases.filter((p) => p.segment === "presentation").sort((a, b) => a.startAt - b.startAt);
  const words = talk.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
  const counts = new Map<string, number>();
  for (const p of talk) for (const w of p.fillers) { const k = w.toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const fillerCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const measured = talk.length > 0;

  // body: the camera coach's episodes, every behaviour seen
  const rows = new Map<BehaviorKind, PitchDashboard["body"]["rows"][number]>();
  for (const e of rec.episodes) {
    const fromMs = t(e.startAt), toMs = Math.max(fromMs, t(e.endAt ?? end));
    const row = rows.get(e.kind) ?? {
      kind: e.kind, label: RULE_LABELS[ruleOfKind(e.kind)]?.label ?? cap(BEHAVIOR_WORDS[e.kind]),
      count: 0, totalMs: 0, longestMs: 0, pct: 0, episodes: [],
    };
    row.count++;
    row.totalMs += toMs - fromMs;
    row.longestMs = Math.max(row.longestMs, toMs - fromMs);
    row.episodes.push({ fromMs, toMs });
    rows.set(e.kind, row);
  }
  for (const row of rows.values()) row.pct = durationMs ? round1((row.totalMs / durationMs) * 100) : 0;

  return {
    runId: rec.runId, index: rec.run.index, live, durationMs,
    speech: {
      measured, words,
      wpm: measured && minutes >= 0.25 ? Math.round(words / minutes) : null,
      fillers: {
        count: fillerCount,
        perMin: measured && minutes >= 0.25 ? round1(fillerCount / minutes) : null,
        top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word, count]) => ({ word, count })),
        at: talk.filter((p) => p.fillers.length).map((p) => ({ tMs: t(p.startAt), words: p.fillers })),
      },
      phrases: talk.map((p) => ({ tMs: t(p.startAt), endMs: t(p.endAt), text: p.text, fillers: p.fillers })),
    },
    body: { measured: rec.coachConnected, rows: [...rows.values()].sort((a, b) => b.totalMs - a.totalMs) },
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function pitchHttp(pitch: PitchMode) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? "").split("?")[0]!;
    if (!path.startsWith("/api/pitch/")) return false;
    if (req.method === "POST" && path === "/api/pitch/start") { const r = pitch.start(); json(res, r.ok ? 200 : 409, r); return true; }
    if (req.method === "POST" && path === "/api/pitch/stop") { const r = pitch.stop(); json(res, r.ok ? 200 : 409, r); return true; }
    if (req.method === "POST" && path === "/api/pitch/exit") { const r = pitch.exit(); json(res, r.ok ? 200 : 409, r); return true; }
    const m = /^\/api\/pitch\/dashboard(?:\/([\w-]+))?$/.exec(path);
    if (req.method === "GET" && m) {
      const d = pitch.dashboard(m[1]);
      if (d) json(res, 200, d);
      else json(res, 404, { ok: false, reason: "not_available", hint: "no pitch has been recorded yet" });
      return true;
    }
    return false;
  };
}
