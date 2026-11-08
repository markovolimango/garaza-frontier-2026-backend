/**
 * Live check of the director agent's two LLM calls with the real key (no brain needed):
 *   set -a; . ./.env; set +a; pnpm --filter @coach/brain exec tsx src/director/liveCheck.ts [model]
 * Runs one planning call (sample deck + transcript) and one follow-up decision, prints the output
 * and the latency. Model: argv[2] or SWARM_TEXT_MODEL or gemini-3.1-flash-lite.
 */
import type { Deck, JudgeDef } from "@coach/protocol";
import { llmJson } from "../swarm/llm.ts";
import { DECIDE_SCHEMA, DECIDE_SYSTEM, PLAN_SYSTEM, decidePrompt, planPrompt, planSchema, readDecision, readPlan, type PanelJudge } from "./prompts.ts";

const apiKey = process.env.GEMINI_API_KEY ?? null;
const model = process.argv[2] ?? process.env.SWARM_TEXT_MODEL ?? "gemini-3.1-flash-lite";
if (!apiKey) { console.error("GEMINI_API_KEY is not set"); process.exit(1); }

const j = (n: number, title: string, style: JudgeDef["style"], toughness: number, priorities: string[], background: string): JudgeDef =>
  ({ id: `judge_${n}` as JudgeDef["id"], title, background, seat: `judge_seat_${n}`, voiceId: `v${n}`, toughness, style, priorities });
const judges = [
  j(1, "Customer advocate", "warm", 0.3, ["user pain", "onboarding"], "Ran customer success at a SaaS company for 8 years."),
  j(2, "Startup mentor", "neutral", 0.5, ["focus", "go-to-market"], "Accelerator mentor, two exits."),
  j(3, "VC investor", "skeptical", 0.8, ["unit economics", "market size", "defensibility"], "Partner at a seed fund, sees 500 pitches a year."),
  j(4, "Technical expert", "neutral", 0.6, ["architecture", "privacy"], "Principal engineer, speech and ML systems."),
];
const strict = (x: JudgeDef): PanelJudge => ({ judge: x, strictness: x.toughness >= 0.7 ? "tough" : x.toughness <= 0.35 ? "kind" : "neutral" });
const deck: Deck = { deckId: "d", name: "Notely", slides: [
  { index: 0, url: "", text: "Notely: meeting notes that write themselves" },
  { index: 1, url: "", text: "Problem: teams lose 4 hours a week writing and chasing meeting notes" },
  { index: 2, url: "", text: "Traction: 40 paying teams, 3 pilots with enterprises" },
  { index: 3, url: "", text: "Pricing: 12 euros per seat per month" },
  { index: 4, url: "", text: "Competition: Otter, Fireflies, built-in Zoom notes. Unlike them we run on-device." },
] };
const transcript = [
  "Hi everyone, um, I'm Ana and this is Notely.",
  "So basically every team we talked to loses like four hours a week on meeting notes.",
  "We record the meeting, uh, and the notes write themselves, with action items.",
  "We have forty paying teams and, um, three enterprise pilots.",
  "And unlike Otter or Fireflies, everything runs on the device, so nothing leaves your laptop.",
  "We are the only ones who do that, and, you know, privacy is huge for our customers.",
].join("\n");

const ms = (t0: number) => `${Date.now() - t0} ms`;

const t0 = Date.now();
try {
  const out = await llmJson({ apiKey, model, system: PLAN_SYSTEM, schema: planSchema(judges.map((x) => x.id)), timeoutMs: 45_000,
    prompt: planPrompt({ count: 3, panel: judges.map(strict), deck, brief: null, transcript, wishes: { focus: ["pricing"] } }) });
  console.log(`PLAN (${model}) ${ms(t0)}`);
  for (const q of readPlan(out, judges, 3, deck.slides.length)) console.log(`  ${q.judgeId} ${q.judgeTitle} [${q.topic}${q.slideIndex !== null ? ` · slide ${q.slideIndex}` : ""}]: ${q.text}`);
} catch (err) { console.log(`PLAN failed after ${ms(t0)}: ${String(err)}`); }

const t1 = Date.now();
try {
  const out = await llmJson({ apiKey, model, system: DECIDE_SYSTEM, schema: DECIDE_SCHEMA, timeoutMs: 45_000,
    prompt: decidePrompt({ judge: strict(judges[2]!), kind: "question", question: "Twelve euros a seat: what does a team of ten actually pay you, and what's your margin after the transcription costs?",
      answer: "Um, so, it really depends on the team, we're, uh, still experimenting with the pricing, and basically the on-device part means our costs are low, so, yeah, margins should be good.",
      answerMs: 14_000, interrupted: false, followUpAllowed: true, remaining: [{ judgeId: "judge_4", judgeTitle: "Technical expert", topic: "tech", slideIndex: 4, text: "" }], wishes: {} }) });
  console.log(`DECIDE (${model}) ${ms(t1)}`);
  console.log(`  ${JSON.stringify(readDecision(out))}`);
} catch (err) { console.log(`DECIDE failed after ${ms(t1)}: ${String(err)}`); }
