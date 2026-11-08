/**
 * Session progress (SessionProgress, protocol reports.ts): how the presenter changed across the
 * session's finished runs, from the same RunLog records as the run digest. One row per coach rule
 * about the presenter (and per target, even when never seen): its count in each run (behaviour
 * episodes when the coach sent them, else rule observations; the larger), per minute, the share of
 * the run it took (episodes), and whether it got better from the first measured run to the last
 * (per minute, so a shorter run is not a better one).
 *
 *   GET /api/progress → SessionProgress
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BehaviorKind, ProgressRow, ProgressRun, SessionProgress, SessionState } from "@coach/protocol";
import { buildDigest, RULE_LABELS, ruleOfKind } from "./digest.ts";
import { BEHAVIOR_WORDS } from "./observedCoach.ts";
import { episodeTime, type RunLog, type RunRecord } from "./runlog.ts";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const kindLabel = (kind: BehaviorKind) => capitalize(BEHAVIOR_WORDS[kind] ?? kind.replace(/_/g, " "));

export function buildProgress(records: RunRecord[], s: Readonly<SessionState>): SessionProgress {
  const runs = records.filter((r) => r.run.phase === "ended").sort((a, b) => a.run.index - b.run.index);
  const targets = new Map(s.coach.targets.map((t) => [t.kind, t]));

  const progressRuns: ProgressRun[] = runs.map((r) => {
    const d = buildDigest(r, null);
    return {
      runId: r.runId, index: r.run.index, mode: r.run.mode, level: r.run.feedbackLevel, targets: r.run.targets, endedBy: r.endedBy,
      presentationMs: d.durations.presentationMs, qaMs: d.durations.qaMs,
      observations: r.observations.filter((o) => o.category).length,
      warnings: d.feedback.warnings,
      score: r.coachAfter?.score ?? null,
      coach: r.coachConnected,
    };
  });

  // Rows: every presenter-behaviour rule seen in any run (observations or episodes), plus targets never seen.
  const rows = new Map<string, { kind: BehaviorKind | null; label: string }>();
  const labelOf = (rule: string, kind: BehaviorKind | null) => RULE_LABELS[rule]?.label ?? (kind ? kindLabel(kind) : rule);
  for (const r of runs) {
    for (const o of r.observations) if (o.category && !rows.has(o.rule)) rows.set(o.rule, { kind: o.kind, label: labelOf(o.rule, o.kind) });
    for (const e of r.episodes ?? []) { const rule = ruleOfKind(e.kind); if (!rows.has(rule)) rows.set(rule, { kind: e.kind, label: labelOf(rule, e.kind) }); }
  }
  for (const kind of targets.keys()) {
    if (![...rows.values()].some((row) => row.kind === kind)) rows.set(`kind:${kind}`, { kind, label: kindLabel(kind) });
  }

  const minutes = progressRuns.map((r) => (r.presentationMs + r.qaMs) / 60_000);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const progressRows: ProgressRow[] = [...rows.entries()].map(([rule, { kind, label }]) => {
    const counts = runs.map((r) => {
      const obs = r.observations.filter((o) => (rule.startsWith("kind:") ? o.kind === kind : o.rule === rule)).length;
      // Measured when the camera coach was connected, or when the swarm's listener reported this rule (fillers).
      if (!r.coachConnected && obs === 0) return null;
      return Math.max(obs, kind ? episodeTime(r, kind, r.endedAt ?? 0).count : 0);
    });
    const perMin = counts.map((c, i) => (c === null || !minutes[i] ? null : round1(c / minutes[i]!)));
    const hasEpisodes = !!kind && runs.some((r) => (r.episodes ?? []).some((e) => e.kind === kind));
    const timePct = hasEpisodes ? runs.map((r, i) => (counts[i] === null || !minutes[i] ? null
      : round1((episodeTime(r, kind!, r.endedAt ?? 0).totalMs / (minutes[i]! * 60_000)) * 100))) : undefined;
    const rates = perMin.filter((c): c is number => c !== null);
    const first = rates[0] ?? 0;
    const last = rates.at(-1) ?? 0;
    const trend = rates.length < 2 || first === last ? "same" : last < first ? "better" : "worse";
    const target = kind ? targets.get(kind) : undefined;
    return { rule, kind, label, counts, perMin, ...(timePct ? { timePct } : {}), isTarget: !!target, status: target?.status ?? null, trend };
  });
  const firstCount = (row: ProgressRow) => row.counts.find((c) => c !== null) ?? 0;
  progressRows.sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || firstCount(b) - firstCount(a) || a.label.localeCompare(b.label));

  return {
    sessionId: s.sessionId,
    runs: progressRuns,
    rows: progressRows,
    coach: { stage: s.coach.stage, level: s.coach.level, score: s.coach.score, recommendation: s.coach.recommendation },
    headline: headline(progressRows),
  };
}

/** "Fast hand movement 4 → 1 · Moving around 3 → 0": targets first, then what was most frequent at the start. */
export function headline(rows: ProgressRow[]): string | null {
  const parts = rows
    .map((row) => ({ row, measured: row.counts.filter((c): c is number => c !== null) }))
    .filter(({ row, measured }) => measured.length >= 2 && (row.isTarget || measured[0]! > 0))
    .slice(0, 3)
    .map(({ row, measured }) => `${row.label} ${measured[0]} → ${measured.at(-1)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** For JJ's final narration: per behaviour, the first measured run against the last one. */
export function compactProgress(p: SessionProgress) {
  const runAt = (i: number) => p.runs[i]!;
  return {
    headline: p.headline,
    runs: p.runs.map((r) => ({ run: r.index, mode: r.mode, minutes: Math.round(((r.presentationMs + r.qaMs) / 60_000) * 10) / 10 })),
    behaviours: p.rows.map((row) => {
      const measured = row.counts.map((c, i) => (c === null ? -1 : i)).filter((i) => i >= 0);
      const at = (i: number | undefined) => (i === undefined ? null : {
        run: runAt(i).index, count: row.counts[i], per_min: row.perMin?.[i] ?? null, pct_of_time: row.timePct?.[i] ?? null });
      return { label: row.label, target: row.isTarget, status: row.status, trend: row.trend, first: at(measured[0]), last: at(measured.at(-1)) };
    }),
    coach: { stage: p.coach.stage, recommendation: p.coach.recommendation?.reason ?? null },
  };
}

/** HTTP route for the createBrain `http` option. */
export function progressHttp(log: RunLog, session: () => Readonly<SessionState>) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method !== "GET" || path !== "/api/progress") return false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildProgress(log.list(), session())));
    return true;
  };
}
