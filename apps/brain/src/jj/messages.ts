/**
 * Text turns the brain sends to JJ. Bracketed tags mark them as system notes, not the user
 * speaking; prompts/jj.md tells JJ how to react to each.
 */
import type { RunId, SessionState } from "@coach/protocol";

export function sessionStartNote(s: Readonly<SessionState>): string {
  const deck = s.context.deck ? `deck: ${s.context.deck.slides.length} slides` : "deck: none yet";
  return s.introDone
    ? `[SESSION START] returning presenter, phase ${s.phase}, ${deck}. Greet in one sentence and offer the next run.`
    : `[SESSION START] first session, phase ${s.phase}, ${deck}. Run the intro.`;
}

/** The presenter uploaded slides (context only: JJ takes it into account in its next turn). */
export function deckNote(s: Readonly<SessionState>): string {
  return `[DECK UPLOADED] ${s.context.deck?.slides.length ?? 0} slides ("${s.context.deck?.name ?? ""}"). A run can start now.`;
}

/** Spec: `[WOKEN DURING RUN: presentation, slide 4]` (slide numbers are 1-based for speech). */
export function wakeNote(s: Readonly<SessionState>): string {
  const run = s.run;
  const segment = run?.phase === "qa" ? "Q&A" : "presentation";
  return `[WOKEN DURING RUN: ${segment}, slide ${(run?.slideIndex ?? 0) + 1}]`;
}

export function runEndedMessage(runId: RunId, report: unknown | null): string {
  return `[RUN ENDED] ${JSON.stringify(report ?? { run_id: runId, report: "unavailable" })}`;
}

export function runAbortedNote(runId: RunId): string {
  return `[RUN ABORTED] ${runId} was stopped before the end; there is no report. Ask what the user wants next.`;
}

export function uiActionNote(caller: string, tool: string, args: unknown, result: unknown): string {
  return `[UI ACTION] the ${caller} ran ${tool} ${JSON.stringify(args ?? {})} -> ${JSON.stringify(result)}`;
}

/** A swarm agent's note to JJ: `[DIRECTOR] the VC judge pressed on pricing twice`. */
export function agentNoteText(from: string, text: string): string {
  return `[${from.toUpperCase()}] ${text.replace(/\s+/g, " ").trim().slice(0, 600)}`;
}

/**
 * Context sent first on a fresh (non-resumed) provider session: digest, brief, panel,
 * coach state and the last two run reports. JJ receives only the digest, never raw docs.
 */
export function buildContextText(s: Readonly<SessionState>, reportFor: (id: RunId) => unknown | null): string {
  const c = s.coach;
  const lastTwo = s.completedRuns.slice(-2).map((id) => ({ run_id: id, report: reportFor(id) }));
  const ctx = {
    phase: s.phase,
    intro_done: s.introDone,
    brief: s.context.brief,
    digest: s.context.digest,
    slides: s.context.deck?.slides.length ?? 0,
    panel: s.scene.judges.map((j) => ({ id: j.id, title: j.title, toughness: j.toughness, style: j.style })),
    qa_questions: s.scene.qa.questions,
    coach: {
      stage: c.stage, level: c.level, score: c.score, training_runs: c.trainingRuns,
      targets: c.targets.map((t) => ({ kind: t.kind, status: t.status })),
      recommendation: c.recommendation,
    },
    completed_runs: s.completedRuns.length,
    last_runs: lastTwo,
  };
  return `[SESSION CONTEXT] You are continuing an existing coaching session. Do not greet again unless asked. ${JSON.stringify(ctx)}`;
}
