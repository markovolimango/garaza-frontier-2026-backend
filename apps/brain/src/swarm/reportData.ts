/**
 * Reporter data (swarm/reporter.ts): what a run / session narrative is built from, the deterministic
 * narratives (the fallback when the LLM fails, and the facts the LLM's text is merged onto), and the
 * LLM prompts + JSON schemas. Pure functions over the board, the RunLog records and the session.
 *
 * Facts (filler counts, body counts, Q&A questions) always come from the data; the LLM only writes
 * the words around them (headline, summary, strengths, improvements, verdicts, notes, next run).
 */
import {
  RunNarrative as RunNarrativeSchema,
  type BehaviorKind, type QaVerdict, type RunDigest, type RunId, type RunNarrative, type SessionNarrative, type SessionState,
} from "@coach/protocol";
import { buildDigest } from "../digest.ts";
import { BEHAVIOR_WORDS } from "../observedCoach.ts";
import { buildProgress, compactProgress } from "../progress.ts";
import type { RunRecord } from "../runlog.ts";
import type { Phrase, SwarmBoard, VideoNote } from "./board.ts";

export const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const CAMERA = new Set(["posture", "movement", "gaze"]);
const MODE = { baseline: "baseline", training: "training", test: "test" } as const;

/** One concrete exercise per behaviour, for the next run. */
export const DRILLS: Record<BehaviorKind, string> = {
  arms_crossed: "Rehearse your hardest slide with your hands resting loosely at your sides or holding the clicker; when you feel your arms fold, open them and finish the sentence.",
  sway: "Plant your feet hip-width apart and deliver the first minute without moving them; move only on a slide change, then plant again.",
  fast_hands: "Present one slide with one slow gesture per idea: make it, hold it for a beat, let the hands rest.",
  face_touch: "Hold the clicker or a pen in one hand for the whole next run; a hand with a job stays away from your face.",
  looking_down: "Learn the first sentence of every slide by heart and look up at a judge before you say it.",
  not_facing_judge: "Pick one judge per idea and finish each sentence looking at them.",
  filler_burst: "Re-record the slide where the fillers clustered and replace every “um” with a silent breath; silence sounds confident, fillers don't.",
  pace_fast: "Mark two places per slide where you stop for a full breath; aim for about 140 words a minute.",
  long_pause: "Write a one-line bridge sentence for every slide change so you never search for the next thought.",
};
const QA_DRILL = "Answer in three beats: the direct answer in one sentence, one piece of evidence, then stop. Say it out loud for this question twice.";

// ---------------------------------------------------------------- inputs

export interface QaItem { judge: string; question: string; answer: string; answerMs: number; askedAt: number; reaction: string | null }
export interface BodyItem { kind: BehaviorKind | null; label: string; count: number; totalMs: number; longestMs: number; pct: number | null; first: string | null; notes: string[] }
export interface RunInputs {
  runId: RunId; index: number; mode: RunDigest["mode"];
  digest: RunDigest; runMs: number; start: number;
  /** Transcript, one phrase per line, `[1:23 s2]` prefix, fillers marked as [[um]]. */
  transcript: string;
  fillers: RunNarrative["fillers"];
  qa: QaItem[];
  body: BodyItem[];
  videoNotes: VideoNote[];
  progress: ReturnType<typeof compactProgress> | null;
  focus: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The phrase with its fillers marked [[like this]]. */
export function markFillers(p: Pick<Phrase, "text" | "fillers">): string {
  const words = [...new Set(p.fillers.map((f) => f.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return p.text;
  const re = new RegExp(`(?<![\\w\\[])(${words.map(escapeRe).join("|")})(?![\\w\\]])`, "gi");
  return p.text.replace(re, "[[$1]]");
}

export function fillerStats(phrases: Phrase[], runMs: number): RunNarrative["fillers"] {
  const byWord = new Map<string, number>();
  for (const p of phrases) for (const f of p.fillers) { const w = f.trim().toLowerCase(); if (w) byWord.set(w, (byWord.get(w) ?? 0) + 1); }
  const count = [...byWord.values()].reduce((a, b) => a + b, 0);
  const examples = phrases.filter((p) => p.fillers.length > 0).sort((a, b) => b.fillers.length - a.fillers.length).slice(0, 3)
    .sort((a, b) => a.startAt - b.startAt).map((p) => `“${clip(markFillers(p), 160)}”`);
  return {
    count, perMin: runMs > 0 ? round1(count / (runMs / 60_000)) : 0,
    top: [...byWord.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word, n]) => ({ word, count: n })),
    examples, measured: phrases.length > 0,
  };
}

export function gatherRun(o: { board: SwarmBoard; rec: RunRecord; session: Readonly<SessionState>; records: RunRecord[]; focus?: string | null }): RunInputs {
  const { board, rec, session: s } = o;
  const digest = buildDigest(rec, s.coach.recommendation);
  const runId = rec.runId;
  const phrases = board.phrases(runId).slice().sort((a, b) => a.startAt - b.startAt);
  const start = rec.run.presentationStartedAt ?? rec.run.startedAt ?? phrases[0]?.startAt ?? 0;
  const runMs = digest.durations.presentationMs + digest.durations.qaMs
    || (phrases.length ? Math.max(0, phrases.at(-1)!.endAt - phrases[0]!.startAt) : 0);
  const at = (t: number) => mmss(t - start);

  let transcript = phrases.map((p) => `[${at(p.startAt)} ${p.segment === "qa" ? "Q&A" : `s${p.slideIndex + 1}`}] ${markFillers(p)}`).join("\n");
  if (transcript.length > 14_000) transcript = `${transcript.slice(0, 7_000)}\n[…]\n${transcript.slice(-7_000)}`;

  // Q&A: the RunLog's turns (answer text when the director adds it), else the judges' board lines.
  const titles = new Map(s.scene.judges.map((j) => [j.id as string, j.title]));
  const lines = board.judgeLines(runId);
  type Turn = { judgeId: string; judge: string; question: string; askedAt: number; answerMs: number; answer?: string };
  const turns: Turn[] = rec.qa.length
    ? rec.qa.map((q) => ({ judgeId: q.judgeId, judge: q.judgeTitle || titles.get(q.judgeId) || q.judgeId, question: q.question, askedAt: q.askedAt,
        answerMs: q.answerMs, ...(typeof (q as { answer?: unknown }).answer === "string" ? { answer: (q as { answer?: string }).answer } : {}) }))
    : lines.filter((l) => l.kind === "question" || l.kind === "followup")
      .map((l) => ({ judgeId: l.judgeId, judge: titles.get(l.judgeId) ?? l.judgeId, question: l.text, askedAt: l.at, answerMs: -1 }));
  turns.sort((a, b) => a.askedAt - b.askedAt);
  const qa: QaItem[] = turns.map((t, i) => {
    const until = turns[i + 1]?.askedAt ?? Number.POSITIVE_INFINITY;
    const heard = phrases.filter((p) => p.segment === "qa" && p.startAt >= t.askedAt && p.startAt < until);
    const answer = (t.answer?.trim() || heard.map((p) => p.text).join(" ")).trim();
    const answerMs = t.answerMs >= 0 ? t.answerMs : heard.length ? Math.max(0, heard.at(-1)!.endAt - heard[0]!.startAt) : 0;
    const reaction = lines.find((l) => l.judgeId === t.judgeId && (l.kind === "reaction" || l.kind === "closing") && l.at > t.askedAt && l.at < until)?.text ?? null;
    return { judge: t.judge, question: t.question, answer: clip(answer, 900), answerMs, askedAt: t.askedAt, reaction };
  });

  // Body: camera behaviours (digest rows) + what the body agent saw on the recording.
  const videoNotes = board.videoNotes(runId);
  const body: BodyItem[] = digest.observations.filter((ob) => ob.category && CAMERA.has(ob.category) && ob.count > 0).map((ob) => {
    const e = ob.examples[0];
    return {
      kind: ob.kind, label: ob.label, count: ob.count, totalMs: ob.time?.totalMs ?? 0, longestMs: ob.time?.longestMs ?? 0, pct: ob.time?.pct ?? null,
      first: e ? `${mmss(e.tRunMs)}, ${e.segment === "qa" ? "Q&A" : `slide ${e.slideIndex + 1}`}` : null,
      notes: videoNotes.filter((n) => n.kind && n.kind === ob.kind).map((n) => `${mmss(n.atMs)}: ${n.text}`),
    };
  });
  const known = new Set(body.map((b) => b.kind));
  const extra = new Map<string, VideoNote[]>();
  for (const n of videoNotes) if (!n.kind || !known.has(n.kind)) extra.set(n.kind ?? "other", [...(extra.get(n.kind ?? "other") ?? []), n]);
  for (const [kind, notes] of extra) {
    body.push({ kind: kind === "other" ? null : (kind as BehaviorKind), label: kind === "other" ? "Seen on the recording" : cap(BEHAVIOR_WORDS[kind as BehaviorKind] ?? kind),
      count: notes.length, totalMs: notes.reduce((n, x) => n + (x.durationMs ?? 0), 0), longestMs: Math.max(0, ...notes.map((x) => x.durationMs ?? 0)), pct: null,
      first: mmss(notes[0]!.atMs), notes: notes.map((n) => `${mmss(n.atMs)}: ${n.text}`) });
  }

  const ended = o.records.filter((r) => r.run.phase === "ended");
  return {
    runId, index: rec.run.index, mode: rec.run.mode, digest, runMs, start, transcript,
    fillers: fillerStats(phrases, runMs), qa, body, videoNotes,
    progress: ended.length >= 2 ? compactProgress(buildProgress(o.records, s)) : null,
    focus: o.focus ?? null,
  };
}

// ---------------------------------------------------------------- run: deterministic

function verdictOf(q: QaItem): { verdict: QaVerdict; tip: string } {
  const words = q.answer ? q.answer.split(/\s+/).filter(Boolean).length : 0;
  if (!q.answer && q.answerMs <= 1_000) return { verdict: "no answer", tip: "Even “I don't know yet; here is how I'd find out” beats silence. Say something within three seconds." };
  if ((q.answer && words < 12) || (!q.answer && q.answerMs < 5_000)) return { verdict: "weak", tip: "Too short to convince: give the direct answer first, then one fact or example that backs it." };
  return { verdict: "ok", tip: "Lead with the one-sentence answer, back it with one fact, then stop and let the judge ask for more." };
}

function bodyNote(b: BodyItem): string {
  const parts = [`${plural(b.count, "time")}`];
  if (b.totalMs > 0) parts.push(`${Math.round(b.totalMs / 1000)} s in total${b.pct !== null ? ` (${b.pct}% of the run)` : ""}`);
  if (b.longestMs > 0 && b.count > 1) parts.push(`longest ${Math.round(b.longestMs / 1000)} s`);
  if (b.first) parts.push(`first at ${b.first}`);
  const seen = b.notes[0] ? `. On the recording: ${clip(b.notes[0], 140)}` : "";
  return `${parts.join(", ")}${seen}`;
}

export function fallbackRun(i: RunInputs, now = Date.now()): RunNarrative {
  const d = i.digest;
  const f = i.fillers;
  const improvements: RunNarrative["improvements"] = [];
  const speechObs = d.observations.filter((o) => o.count > 0 && !(o.category && CAMERA.has(o.category)) && o.rule !== "speech.fillers");
  const camera = [...i.body].filter((b) => b.kind).sort((a, b) => Number(d.targets.includes(b.kind!)) - Number(d.targets.includes(a.kind!)) || b.count - a.count);
  const fillersBad = f.measured && (f.perMin >= 3 || f.count >= 6);
  const add = (title: string, why: string, evidence: string, drill: string) => { if (!improvements.some((x) => x.title === title)) improvements.push({ title, why, evidence, drill }); };
  const addBody = (b: BodyItem) => add(cap(b.label), `${d.targets.includes(b.kind!) ? "Your training target. " : ""}${cap(bodyNote(b))}.`, b.first ?? (b.notes[0] ?? "camera coach"), DRILLS[b.kind!]);
  for (const b of camera.filter((x) => d.targets.includes(x.kind!))) addBody(b);
  if (fillersBad) {
    const top = f.top.slice(0, 2).map((t) => `“${t.word}” ${t.count}×`).join(", ");
    add("Filler words", `${plural(f.count, "filler word")} (${f.perMin}/min)${top ? `, mostly ${top}` : ""}. They make you sound less sure than you are.`, f.examples[0] ?? top, DRILLS.filler_burst);
  }
  for (const b of camera) addBody(b);
  for (const o of speechObs) add(o.label, `Flagged ${plural(o.count, "time")}.`, o.examples[0] ? `${mmss(o.examples[0].tRunMs)}, ${o.examples[0].segment === "qa" ? "Q&A" : `slide ${o.examples[0].slideIndex + 1}`}` : "speech coach", o.kind ? DRILLS[o.kind] : DRILLS.pace_fast);
  const qa = i.qa.map((q) => {
    const v = verdictOf(q);
    return { judge: q.judge, question: q.question, verdict: v.verdict, tip: v.tip,
      answerSummary: q.answer ? clip(q.answer, 180) : q.answerMs > 1_000 ? `Answered for ${mmss(q.answerMs)} (no transcript).` : "No answer heard." };
  });
  const weak = qa.filter((q) => q.verdict === "weak" || q.verdict === "no answer");
  if (weak.length) add("Answers to the judges", `${weak.length} of ${qa.length} answers were short or missing.`, `${weak[0]!.judge}: “${clip(weak[0]!.question, 120)}”`, QA_DRILL);

  const strengths: RunNarrative["strengths"] = [];
  if (f.measured && f.perMin < 1.5) strengths.push({ text: "Hardly any filler words", evidence: `${plural(f.count, "filler")} in ${mmss(i.runMs)}` });
  if (qa.length && !weak.length) strengths.push({ text: "Answered every judge's question", evidence: `${qa.length} of ${qa.length} answered` });
  for (const s of d.strengths.slice(0, 4)) strengths.push({ text: s, evidence: `not flagged once in ${mmss(i.runMs)} (camera coach)` });

  const facts: string[] = [];
  if (f.measured) facts.push(plural(f.count, "filler word"));
  const topBody = camera[0];
  if (topBody) facts.push(`${topBody.label.toLowerCase()} ${topBody.count}×`);
  if (qa.length) facts.push(`${qa.length - weak.length}/${qa.length} questions answered well`);
  const headline = `Run ${i.index}: ${facts.length ? facts.join(", ") : d.sources.coach ? "a clean run" : "done"}${improvements[0] ? `. Fix first: ${improvements[0].title.toLowerCase()}` : ""}`;

  const summary = [
    `A ${MODE[i.mode]} run: ${mmss(d.durations.presentationMs)} presenting${d.durations.qaMs ? ` and ${mmss(d.durations.qaMs)} of Q&A` : ""} over ${plural(d.slides.length, "slide")}.`,
    !d.sources.coach ? "The camera coach wasn't connected, so there are no body observations."
      : camera.length ? `The camera coach noticed ${camera.slice(0, 3).map((b) => `${b.label.toLowerCase()} (${b.count}×)`).join(", ")}.` : "The camera coach flagged nothing.",
    f.measured ? `You used ${plural(f.count, "filler word")} (${f.perMin} a minute).` : "",
    qa.length ? `${plural(qa.length, "question")} from the judges; ${weak.length ? `${weak.length} answer${weak.length === 1 ? " was" : "s were"} short or missing` : "all answered"}.` : "",
  ].filter(Boolean).join(" ");

  return {
    runId: i.runId, index: i.index, headline, summary,
    strengths: strengths.slice(0, 4), improvements: improvements.slice(0, 4),
    fillers: f, qa,
    body: i.body.map((b) => ({ kind: b.label, count: b.count, note: bodyNote(b) })),
    nextRun: d.next?.reason ?? (improvements[0] ? `Run it again and work on one thing: ${improvements[0].title.toLowerCase()}.` : "Run it again with tougher judges."),
    source: "fallback", createdAt: now,
  };
}

// ---------------------------------------------------------------- run: LLM

export const RUN_SYSTEM = `You are the Reporter in an AI presentation coach. After a practice run you write the coach's analysis for the presenter, as JSON.
Rules:
- Second person ("you"), plain, warm and direct. Short sentences. No hype.
- Evidence for every claim: a short verbatim quote from the transcript (fillers are marked [[um]]; keep the marks out of quotes unless the filler is the point), or a time and slide ("1:23, slide 2") from the data.
- Never invent numbers: use the counts in the data. If something was not measured, don't judge it.
- improvements: 2-4, the most important first; each with a concrete drill for the next run (one or two sentences, something they can practise).
- strengths: 1-3 real ones with evidence.
- qa: one entry per question, same order (index = position). verdict: strong (direct, specific, convincing), ok, weak (vague, evasive, too short) or "no answer". answerSummary: one sentence of what they said. tip: how to answer it better.
- body: one note per behaviour listed (kind = its label), what it looked like and when.
- headline: one line, max 14 words, the single most useful takeaway.`;

export const RUN_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string", description: "2-4 sentences" },
    strengths: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidence: { type: "string" } }, required: ["text", "evidence"] } },
    improvements: { type: "array", items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" }, evidence: { type: "string" }, drill: { type: "string" } }, required: ["title", "why", "evidence", "drill"] } },
    qa: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, answerSummary: { type: "string" }, verdict: { type: "string", enum: ["strong", "ok", "weak", "no answer"] }, tip: { type: "string" } }, required: ["index", "answerSummary", "verdict", "tip"] } },
    body: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, note: { type: "string" } }, required: ["kind", "note"] } },
    nextRun: { type: "string" },
  },
  required: ["headline", "summary", "strengths", "improvements", "qa", "body", "nextRun"],
} as const;

export interface RunLlmOut {
  headline: string; summary: string; strengths: { text: string; evidence: string }[];
  improvements: { title: string; why: string; evidence: string; drill: string }[];
  qa: { index: number; answerSummary: string; verdict: QaVerdict; tip: string }[];
  body: { kind: string; note: string }[]; nextRun: string;
}

export function runPrompt(i: RunInputs): string {
  const d = i.digest;
  const data = {
    run: { index: i.index, mode: i.mode, targets: d.targets, presentation: mmss(d.durations.presentationMs), qa: mmss(d.durations.qaMs), slides: d.slides.length, cameraCoach: d.sources.coach },
    coachNoticed: d.observations.map((o) => ({ label: o.label, count: o.count, target: o.isTarget, time: o.time ?? null,
      moments: o.examples.map((e) => `${mmss(e.tRunMs)}, ${e.segment === "qa" ? "Q&A" : `slide ${e.slideIndex + 1}`}${e.durationMs ? ` (${Math.round(e.durationMs / 1000)} s)` : ""}`) })),
    notFlagged: d.strengths,
    fillers: i.fillers.measured ? { count: i.fillers.count, perMin: i.fillers.perMin, top: i.fillers.top } : "no transcript for this run",
    qa: i.qa.map((q, index) => ({ index, judge: q.judge, question: q.question, answer: q.answer || null, answerSeconds: Math.round(q.answerMs / 1000), judgeReaction: q.reaction })),
    body: i.body.map((b) => ({ kind: b.label, count: b.count, totalSeconds: Math.round(b.totalMs / 1000), pctOfRun: b.pct, first: b.first, seenOnRecording: b.notes.slice(0, 4) })),
    progressSoFar: i.progress,
    coachSuggestsNext: d.next?.reason ?? null,
    ...(i.focus ? { coachJJAsksToFocusOn: i.focus } : {}),
  };
  return `DATA:\n${JSON.stringify(data, null, 1)}\n\nTRANSCRIPT (presenter, verbatim, fillers marked [[…]]; [time slide] prefixes):\n${i.transcript || "(no transcript)"}\n\nWrite the run report JSON.`;
}

const str = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
const VERDICTS = new Set(["strong", "ok", "weak", "no answer"]);

/** The LLM's words on the data's facts. Anything missing or malformed comes from the fallback. */
export function mergeRun(out: Partial<RunLlmOut> | null | undefined, i: RunInputs, now = Date.now()): RunNarrative {
  const fb = fallbackRun(i, now);
  if (!out || typeof out !== "object") return fb;
  const pairs = <T,>(v: unknown, ok: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((x) => (x && typeof x === "object" ? [ok(x as Record<string, unknown>)].filter((y): y is T => y !== null) : [])) : [];
  const strengths = pairs(out.strengths, (x) => (str(x.text, "") ? { text: str(x.text, ""), evidence: str(x.evidence, "") } : null)).slice(0, 4);
  const improvements = pairs(out.improvements, (x) => (str(x.title, "") ? { title: str(x.title, ""), why: str(x.why, ""), evidence: str(x.evidence, ""), drill: str(x.drill, "") } : null)).slice(0, 5);
  const llmQa = pairs(out.qa, (x) => x);
  const qa = fb.qa.map((q, idx) => {
    const m = llmQa.find((x) => x.index === idx) ?? (llmQa.length === fb.qa.length ? llmQa[idx] : undefined);
    if (!m) return q;
    const verdict = typeof m.verdict === "string" && VERDICTS.has(m.verdict) ? (m.verdict as QaVerdict) : q.verdict;
    return { ...q, verdict, answerSummary: str(m.answerSummary, q.answerSummary), tip: str(m.tip, q.tip) };
  });
  const llmBody = pairs(out.body, (x) => ({ kind: str(x.kind, "").toLowerCase(), note: str(x.note, "") }));
  const body = fb.body.map((b) => ({ ...b, note: llmBody.find((x) => x.note && (x.kind === b.kind.toLowerCase() || b.kind.toLowerCase().includes(x.kind) && x.kind.length > 3))?.note ?? b.note }));
  const n: RunNarrative = {
    ...fb,
    headline: str(out.headline, fb.headline), summary: str(out.summary, fb.summary),
    strengths: strengths.length ? strengths : fb.strengths,
    improvements: improvements.length ? improvements : fb.improvements,
    qa, body, nextRun: str(out.nextRun, fb.nextRun), source: "llm",
  };
  return RunNarrativeSchema.safeParse(n).success ? n : fb;
}

// ---------------------------------------------------------------- session

export interface SessionInputs {
  runs: RunNarrative[];
  progress: ReturnType<typeof compactProgress>;
  totalMs: number;
  focus: string | null;
}

export function gatherSession(o: { board: SwarmBoard; session: Readonly<SessionState>; records: RunRecord[]; focus?: string | null; now?: number }): SessionInputs {
  const progress = buildProgress(o.records, o.session);
  const ended = o.records.filter((r) => r.run.phase === "ended").sort((a, b) => a.run.index - b.run.index);
  const runs = ended.map((rec) => {
    const stored = RunNarrativeSchema.safeParse(o.board.runReport(rec.runId));
    return stored.success ? stored.data : fallbackRun(gatherRun({ board: o.board, rec, session: o.session, records: o.records }), o.now);
  });
  return { runs, progress: compactProgress(progress), totalMs: progress.runs.reduce((n, r) => n + r.presentationMs + r.qaMs, 0), focus: o.focus ?? null };
}

function progressLines(i: SessionInputs): string[] {
  const lines: string[] = [];
  const measured = i.runs.filter((r) => r.fillers.measured);
  if (measured.length >= 2) {
    const a = measured[0]!.fillers, b = measured.at(-1)!.fillers;
    lines.push(`Filler words: ${a.count} → ${b.count} (${a.perMin} → ${b.perMin}/min), run ${measured[0]!.index} → ${measured.at(-1)!.index}`);
  } else if (measured.length === 1) lines.push(`Filler words: ${measured[0]!.fillers.count} in run ${measured[0]!.index} (${measured[0]!.fillers.perMin}/min)`);
  for (const b of i.progress.behaviours) {
    if (!b.first) continue;
    const pm = (x: typeof b.first) => (x?.per_min != null ? `${x.per_min}/min` : "");
    const rate = b.last && b.last.run !== b.first.run ? ` (${pm(b.first)} → ${pm(b.last)})` : "";
    const trend = b.last && b.last.run !== b.first.run ? `, ${b.trend}` : "";
    lines.push(`${b.label}${b.target ? ` (target${b.status === "fixed" ? ", fixed" : ""})` : ""}: ${b.first.count}${b.last && b.last.run !== b.first.run ? ` → ${b.last.count}` : ` in run ${b.first.run}`}${rate}${trend}`);
  }
  return lines.slice(0, 8);
}

export function fallbackSession(i: SessionInputs, now = Date.now()): SessionNarrative {
  const n = i.runs.length;
  const last = i.runs.at(-1);
  const better = i.progress.behaviours.filter((b) => b.trend === "better" && b.first && b.last);
  const strengths = [...new Set([
    ...better.map((b) => `${b.label}: down from ${b.first!.count} to ${b.last!.count}`),
    ...(last?.strengths.map((s) => s.text) ?? []),
  ])].slice(0, 5);
  const focus = (last?.improvements ?? []).slice(0, 3).map((x) => ({ title: x.title, why: x.why, drill: x.drill }));
  for (const b of i.progress.behaviours.filter((x) => x.trend === "worse")) {
    if (focus.length >= 3 || focus.some((f) => f.title.toLowerCase() === b.label.toLowerCase())) continue;
    const kind = Object.entries(BEHAVIOR_WORDS).find(([, w]) => w === b.label.toLowerCase())?.[0] as BehaviorKind | undefined;
    focus.push({ title: b.label, why: `Went up from ${b.first?.count ?? 0} to ${b.last?.count ?? 0}.`, drill: kind ? DRILLS[kind] : "Run it again with live feedback on this one behaviour." });
  }
  return {
    headline: i.progress.headline ?? (n === 1 ? last!.headline : `${n} runs practised${last ? `; last one: ${last.headline.replace(/^Run \d+: /, "")}` : ""}`),
    summary: `${plural(n, "run")}, ${mmss(i.totalMs)} of practice.${better.length ? ` Better: ${better.map((b) => b.label.toLowerCase()).join(", ")}.` : ""}${i.progress.coach.recommendation ? ` ${i.progress.coach.recommendation}` : ""}`,
    progress: progressLines(i),
    strengths, focus,
    runs: i.runs.map((r) => ({ runId: r.runId, index: r.index, headline: r.headline })),
    source: "fallback", createdAt: now,
  };
}

export const SESSION_SYSTEM = `You are the Reporter in an AI presentation coach. The practice session is over; write the session summary for the presenter (and for a manager who may read the PDF), as JSON.
Rules: second person, plain, warm, direct; use only the numbers in the data; progress = one line per behaviour, first run → last run, with the numbers; strengths = what really improved or held; focus = exactly the top 3 things to work on next, each with a concrete drill; headline = one line, max 14 words.`;

export const SESSION_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string", description: "3-5 sentences" },
    progress: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    focus: { type: "array", items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" }, drill: { type: "string" } }, required: ["title", "why", "drill"] } },
  },
  required: ["headline", "summary", "progress", "strengths", "focus"],
} as const;
export interface SessionLlmOut { headline: string; summary: string; progress: string[]; strengths: string[]; focus: { title: string; why: string; drill: string }[] }

export function sessionPrompt(i: SessionInputs): string {
  const data = {
    totalPractice: mmss(i.totalMs),
    progress: i.progress,
    fillersPerRun: i.runs.map((r) => ({ run: r.index, ...(r.fillers.measured ? { count: r.fillers.count, perMin: r.fillers.perMin, top: r.fillers.top.slice(0, 3) } : { measured: false }) })),
    runs: i.runs.map((r) => ({ run: r.index, headline: r.headline, summary: r.summary, improvements: r.improvements.map((x) => x.title), strengths: r.strengths.map((x) => x.text),
      qa: r.qa.map((q) => ({ judge: q.judge, verdict: q.verdict })) })),
    ...(i.focus ? { coachJJAsksToFocusOn: i.focus } : {}),
  };
  return `DATA:\n${JSON.stringify(data, null, 1)}\n\nWrite the session summary JSON.`;
}

export function mergeSession(out: Partial<SessionLlmOut> | null | undefined, i: SessionInputs, now = Date.now()): SessionNarrative {
  const fb = fallbackSession(i, now);
  if (!out || typeof out !== "object") return fb;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
  const focus = Array.isArray(out.focus) ? out.focus.filter((x) => x && typeof x === "object" && str(x.title, ""))
    .map((x) => ({ title: str(x.title, ""), why: str(x.why, ""), drill: str(x.drill, "") })).slice(0, 3) : [];
  return {
    ...fb,
    headline: str(out.headline, fb.headline), summary: str(out.summary, fb.summary),
    progress: strs(out.progress).length ? strs(out.progress).slice(0, 10) : fb.progress,
    strengths: strs(out.strengths).length ? strs(out.strengths).slice(0, 6) : fb.strengths,
    focus: focus.length ? focus : fb.focus,
    source: "llm",
  };
}
