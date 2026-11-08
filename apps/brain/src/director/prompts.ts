/**
 * The director agent's two LLM calls (Gemini structured JSON, see swarm/llm.ts):
 *   plan   — during the presentation: the Q&A questions, per judge, in persona and tone.
 *   decide — after each answer: follow-up / next / close, plus a verdict on the answer.
 * Pure prompt building and output checking; the agent (agent.ts) owns timing and fallbacks.
 */
import type { Deck, JudgeDef, JudgeId, PresentationBrief } from "@coach/protocol";
import type { QaVerdict, Strictness } from "../swarm/board.ts";
import type { PlannedQuestion } from "./questions.ts";

export const TONE: Record<Strictness, string> = {
  kind: "warm and encouraging; open questions; no pressure",
  neutral: "matter-of-fact and curious; asks for specifics",
  tough: "blunt and skeptical; presses for numbers and evidence; challenges weak claims; short sentences",
};

export interface PanelJudge { judge: JudgeDef; strictness: Strictness }

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…`);
const tail = (s: string, max: number) => (s.length <= max ? s : `…${s.slice(-max)}`);

function panelText(panel: PanelJudge[]): string {
  return panel.map(({ judge: j, strictness }) =>
    `- ${j.id} · ${j.title} · style ${j.style} · tone (${strictness}): ${TONE[strictness]} · background: ${clip(j.background, 200)}` +
    (j.priorities.length ? ` · cares about: ${j.priorities.join(", ")}` : "")).join("\n");
}

function deckText(deck: Deck | null): string {
  if (!deck?.slides.length) return "(no slides)";
  let out = "";
  for (const s of deck.slides) {
    const line = `Slide ${s.index}: ${s.text.replace(/\s+/g, " ").trim()}\n`;
    if (out.length + line.length > 3500) { out += "…\n"; break; }
    out += line;
  }
  return out.trim();
}

function briefText(b: PresentationBrief | null): string {
  if (!b) return "(none)";
  return [`title: ${b.title}`, `audience: ${b.audience}`, `goal: ${b.goal}`, `setting: ${b.setting}`,
    b.keyPoints.length ? `key points: ${b.keyPoints.join("; ")}` : "", b.durationMin ? `duration: ${b.durationMin} min` : ""]
    .filter(Boolean).join("\n");   // the presenter's personal goals stay out of the judges' view
}

export interface DirectorWishes { focus?: string[] | undefined; note?: string | undefined }

function wishesText(w: DirectorWishes): string {
  const parts = [w.focus?.length ? `focus topics: ${w.focus.join(", ")}` : "", w.note ? `note from the coach: ${w.note}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n") : "(none)";
}

// ---------------- plan ----------------
export const PLAN_SYSTEM = `You direct a panel of judges at a presentation rehearsal. While the presenter is still talking you prepare the questions the judges ask in the Q&A right after the talk.
Rules:
- Return exactly the number of questions asked for. Spread them over the judges, toughest first; no judge asks twice before every judge has asked once.
- Each question is spoken aloud by that judge, in their persona and tone: ONE question, at most 30 words, plain spoken English, no preamble, no numbering, no stage directions, no names.
- Ground each question in what the presenter actually said (quote a claim or a number from the transcript) or in what is clearly missing (no price, no numbers, no competitors…). Prefer the transcript over the slides when both exist.
- One topic per question, all different. Cover the coach's focus topics first when given.
- topic: one or two words (pricing, traction, market, competition, tech, team, go-to-market, risk, vision, …).
- slideIndex: the slide the question is about, or -1.`;

export function planSchema(judgeIds: JudgeId[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            judgeId: { type: "string", enum: judgeIds },
            topic: { type: "string" },
            text: { type: "string" },
            slideIndex: { type: "integer" },
          },
          required: ["judgeId", "topic", "text", "slideIndex"],
        },
      },
    },
    required: ["questions"],
  };
}

export function planPrompt(a: { count: number; panel: PanelJudge[]; deck: Deck | null; brief: PresentationBrief | null; transcript: string; wishes: DirectorWishes }): string {
  return `Questions to write: ${a.count}

PANEL
${panelText(a.panel)}

COACH'S WISHES
${wishesText(a.wishes)}

PRESENTATION BRIEF
${briefText(a.brief)}

SLIDES
${deckText(a.deck)}

TRANSCRIPT SO FAR (verbatim, with fillers; may have transcription errors)
${a.transcript.trim() ? tail(a.transcript.trim(), 5000) : "(nothing said yet: base the questions on the slides and the brief)"}`;
}

interface RawPlan { questions?: { judgeId?: unknown; topic?: unknown; text?: unknown; slideIndex?: unknown }[] }

/** The LLM's plan, checked: known judges, non-empty spoken text, at most `count`. */
export function readPlan(out: unknown, judges: JudgeDef[], count: number, slides: number): PlannedQuestion[] {
  const byId = new Map(judges.map((j) => [j.id, j]));
  const list = Array.isArray((out as RawPlan | null)?.questions) ? (out as RawPlan).questions! : [];
  const res: PlannedQuestion[] = [];
  for (const q of list) {
    const judge = typeof q.judgeId === "string" ? byId.get(q.judgeId as JudgeId) : undefined;
    const text = typeof q.text === "string" ? spoken(q.text) : "";
    if (!judge || text.length < 8) continue;
    const slide = typeof q.slideIndex === "number" && Number.isInteger(q.slideIndex) && q.slideIndex >= 0 && q.slideIndex < slides ? q.slideIndex : null;
    res.push({ judgeId: judge.id, judgeTitle: judge.title, topic: typeof q.topic === "string" && q.topic.trim() ? clip(q.topic.trim().toLowerCase(), 30) : "general", slideIndex: slide, text });
    if (res.length >= count) break;
  }
  return res;
}

/** One spoken line: no quotes around it, no "Judge:" prefix, at most ~300 chars. */
export function spoken(s: string): string {
  return clip(s.replace(/\s+/g, " ").trim().replace(/^["“']+|["”']+$/g, "").replace(/^judge_\d+:\s+/i, ""), 300);
}

// ---------------- decide ----------------
export const DECIDE_SYSTEM = `You direct a panel of judges in the Q&A of a presentation rehearsal. A judge just asked a question and the presenter answered (live transcript, verbatim, may have transcription errors). Decide what happens next:
- "followup": the SAME judge asks ONE short follow-up (at most 25 words), in their persona and tone, because the answer dodged the question, stayed vague, or missed what was asked (e.g. no number when a number was asked). Only when follow-ups are allowed. Tough judges follow up on any vagueness; kind judges only when the question was not answered at all.
- "next": move on to the next planned question. text = "".
- "close": end the Q&A now. text = a short closing line from the panel. Only when the presenter asked to stop, or nothing useful is left to ask.
If the judge cut in on a rambling answer, a follow-up asking for the short, concrete version is usually right.
Also judge the answer: verdict "answered" | "partial" | "dodged" | "no_answer", and note: what was missing or what was strong, at most 10 words (e.g. "no number given", "clear: 40 paying teams").`;

export const DECIDE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["followup", "next", "close"] },
    text: { type: "string" },
    verdict: { type: "string", enum: ["answered", "partial", "dodged", "no_answer"] },
    note: { type: "string" },
  },
  required: ["action", "text", "verdict", "note"],
};

export function decidePrompt(a: {
  judge: PanelJudge; question: string; kind: "question" | "followup"; answer: string; answerMs: number; interrupted: boolean;
  followUpAllowed: boolean; remaining: PlannedQuestion[]; wishes: DirectorWishes;
}): string {
  const { judge: j, strictness } = a.judge;
  return `JUDGE: ${j.id} · ${j.title} · tone (${strictness}): ${TONE[strictness]}${j.priorities.length ? ` · cares about: ${j.priorities.join(", ")}` : ""}
${a.kind === "followup" ? "FOLLOW-UP" : "QUESTION"}: ${a.question}
ANSWER (${Math.round(a.answerMs / 1000)} s${a.interrupted ? ", the judge cut in on it" : ""}): ${a.answer.trim() ? tail(a.answer.trim(), 3000) : "(no answer: silence or nothing transcribed)"}
FOLLOW-UPS ALLOWED: ${a.followUpAllowed ? "yes" : "no"}
PLANNED QUESTIONS LEFT: ${a.remaining.length ? a.remaining.map((q) => `${q.judgeTitle} on ${q.topic}`).join("; ") : "none (next = the closing line)"}
COACH'S WISHES: ${wishesText(a.wishes).replace(/\n/g, "; ")}`;
}

export interface Decision { action: "followup" | "next" | "close"; text: string; verdict: QaVerdict["verdict"]; note: string }

export function readDecision(out: unknown): Decision {
  const o = (out ?? {}) as Record<string, unknown>;
  const action = o.action === "followup" || o.action === "close" ? o.action : "next";
  const verdicts: QaVerdict["verdict"][] = ["answered", "partial", "dodged", "no_answer"];
  const verdict = verdicts.includes(o.verdict as QaVerdict["verdict"]) ? (o.verdict as QaVerdict["verdict"]) : "partial";
  return { action, text: typeof o.text === "string" ? spoken(o.text) : "", verdict, note: typeof o.note === "string" ? clip(o.note.trim(), 80) : "" };
}

/** Topics where a good answer carries a number. */
const NUMERIC_TOPIC = /pric|traction|market|revenue|growth|cost|margin|retention|money|customers|users/i;

/** Verdict without the LLM: silence → no_answer; a numeric topic answered without a number → partial. */
export function heuristicVerdict(topic: string, answer: string, answerMs: number): Pick<QaVerdict, "verdict" | "note"> {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (answerMs === 0 && words === 0) return { verdict: "no_answer", note: "no answer" };
  if (!answer.trim()) return { verdict: "partial", note: "answer not transcribed" };
  if (NUMERIC_TOPIC.test(topic) && !/\d|percent|million|thousand|billion|hundred|[€$%]/i.test(answer)) return { verdict: "partial", note: "no number given" };
  if (words < 6) return { verdict: "partial", note: "very short answer" };
  return { verdict: "answered", note: "" };
}
