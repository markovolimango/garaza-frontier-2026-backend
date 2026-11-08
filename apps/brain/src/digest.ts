/**
 * Run digest (RunDigest, protocol reports.ts) from a RunLog record, and its HTTP routes:
 *   GET /api/runs                 → [{ runId, index, mode, level, ended }]
 *   GET /api/runs/:runId/report   → RunDigest (404 for an unknown run)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Recommendation, RunDigest, RunDigestObservation } from "@coach/protocol";
import type { RunLog, RunRecord } from "./runlog.ts";

/** Coach backend rules (services/coach) → what the presenter reads. */
export const RULE_LABELS: Record<string, { label: string; strength: string }> = {
  "body.hand_movement_high": { label: "Fast hand movement", strength: "Calm, controlled hands" },
  "body.torso_movement_high": { label: "Moving around / swaying", strength: "Stood your ground" },
  "body.arms_crossed": { label: "Crossed arms", strength: "Arms open, not crossed" },
  "body.face_touch": { label: "Hand at your face", strength: "Hands away from your face" },
  "body.looking_down": { label: "Looking down", strength: "Kept your head up" },
  "speech.rate_high": { label: "Speaking too fast", strength: "Comfortable speaking pace" },
  "speech.long_pauses": { label: "Long pauses", strength: "No long pauses" },
  "speech.fillers": { label: "Filler words", strength: "No filler words" },
  "heart.above_reference": { label: "Heart rate above your calm baseline", strength: "" },
  "body.tracking_lost": { label: "Out of the camera's view", strength: "" },
};
const labelFor = (rule: string) => RULE_LABELS[rule]?.label ?? rule;

export function buildDigest(rec: RunRecord, next: Recommendation | null): RunDigest {
  const run = rec.run;
  const start = run.presentationStartedAt ?? run.startedAt ?? 0;
  const presEnd = run.presentationEndedAt ?? rec.endedAt ?? start;
  const presentationMs = run.presentationStartedAt ? Math.max(0, presEnd - run.presentationStartedAt) : 0;
  const qaMs = rec.qaStartedAt !== null ? Math.max(0, (rec.endedAt ?? rec.qaStartedAt) - rec.qaStartedAt) : 0;

  const dwell = new Map<number, { dwellMs: number; visits: number }>();
  rec.slides.forEach((s, i) => {
    const until = Math.min(rec.slides[i + 1]?.at ?? presEnd, presEnd);
    const d = dwell.get(s.index) ?? { dwellMs: 0, visits: 0 };
    d.dwellMs += Math.max(0, until - s.at);
    d.visits += 1;
    dwell.set(s.index, d);
  });

  const byRule = new Map<string, RunDigestObservation>();
  for (const o of rec.observations) {
    const g = byRule.get(o.rule) ?? { rule: o.rule, kind: o.kind, category: o.category, label: labelFor(o.rule), count: 0, examples: [], isTarget: !!o.kind && run.targets.includes(o.kind) };
    g.count++;
    if (g.examples.length < 3) g.examples.push({ tRunMs: Math.max(0, o.at - start), segment: o.segment, slideIndex: o.slideIndex, text: o.text });
    byRule.set(o.rule, g);
  }
  const observations = [...byRule.values()].sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || b.count - a.count);
  const strengths = rec.coachConnected
    ? Object.entries(RULE_LABELS).filter(([rule, l]) => l.strength && !byRule.has(rule)).map(([, l]) => l.strength)
    : [];

  return {
    runId: run.runId, index: run.index, mode: run.mode, level: run.feedbackLevel, targets: run.targets,
    endedBy: rec.endedBy,
    durations: { presentationMs, qaMs, pausedMs: run.pausedMs },
    slides: [...dwell.entries()].sort((a, b) => a[0] - b[0]).map(([index, d]) => ({ index, ...d })),
    observations,
    feedback: { warnings: rec.feedback.filter((f) => f.kind === "warn").length, rewards: rec.feedback.filter((f) => f.kind === "reward").length },
    wakes: rec.wakes,
    qa: rec.qa.map(({ judgeId, judgeTitle, question, answerMs }) => ({ judgeId, judgeTitle, question, answerMs })),
    strengths,
    next,
    sources: { coach: rec.coachConnected },
  };
}

/** HTTP routes for the createBrain `http` option. */
export function digestHttp(log: RunLog, next: () => Recommendation | null) {
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "GET") return false;
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/runs") {
      json(res, 200, log.list().map((r) => ({ runId: r.runId, index: r.run.index, mode: r.run.mode, level: r.run.feedbackLevel, ended: r.endedAt !== null })));
      return true;
    }
    const m = /^\/api\/runs\/([^/]+)\/report$/.exec(path);
    if (!m) return false;
    const rec = log.get(decodeURIComponent(m[1]!));
    if (!rec) { json(res, 404, { ok: false, reason: "not_found" }); return true; }
    json(res, 200, buildDigest(rec, next()));
    return true;
  };
}
