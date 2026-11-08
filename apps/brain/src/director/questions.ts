/**
 * Judge questions without an LLM: topics found in the deck's slide text, matched to each judge's
 * style, filled into question templates. Deterministic for a given deck, panel and seed (the run
 * index, so the panel opens differently each run). An LLM-backed source can replace it later
 * with the same output (PlannedQuestion[]).
 */
import type { Deck, JudgeDef, JudgeId, JudgeStyle } from "@coach/protocol";

export type Topic = "problem" | "pricing" | "traction" | "market" | "competition" | "tech" | "team" | "gtm" | "risk" | "vision";

const TOPIC_PATTERNS: [Topic, RegExp][] = [
  ["pricing", /(pric\w*|€|\$|\beuros?\b|\bdollars?\b|per (seat|month|user|year)|subscription|revenue|monetiz\w*|margin)/i],
  ["traction", /\b(traction|users?|customers?|clients?|growth|mrr|arr|paying|pilots?|downloads?|waitlist|retention)\b/i],
  ["market", /\b(market|tam|sam|som|billion|industry|segment)\b/i],
  ["competition", /\b(competit\w*|alternatives?|incumbents?|unlike|vs\.?)\b/i],
  ["tech", /\b(ai|ml|model|algorithm|platform|technology|api|patent|machine learning)\b/i],
  ["team", /\b(team|founders?|ceo|cto|co-founder)\b/i],
  ["gtm", /\b(go[- ]to[- ]market|sales|channels?|marketing|distribution|partners?|launch)\b/i],
];

/** Which topics each judge style asks about first. */
const STYLE_TOPICS: Record<JudgeStyle, Topic[]> = {
  skeptical: ["pricing", "competition", "market", "risk", "traction"],
  neutral: ["traction", "gtm", "tech", "team", "market"],
  warm: ["problem", "team", "vision", "traction"],
};

const TEMPLATES: Record<Topic, { withFact?: (s: string) => string; generic: string }> = {
  problem: { withFact: (s) => `"${s}": who exactly has this problem today, and what do they use instead?`, generic: "Who exactly has this problem today, and what do they use instead?" },
  pricing: { withFact: (s) => `On your slide you say "${s}". How did you arrive at that price, and what are your margins?`, generic: "How will you make money, and what does a customer pay?" },
  traction: { withFact: (s) => `You mention "${s}". How many of them are still active after the first month?`, generic: "What traction do you have so far, and how fast is it growing?" },
  market: { withFact: (s) => `"${s}": how did you size that market, and which segment do you win first?`, generic: "How big is the market really, and who buys first?" },
  competition: { withFact: (s) => `You compare yourselves to others: "${s}". What stops them from copying you in six months?`, generic: "What stops a bigger player from copying this in six months?" },
  tech: { withFact: (s) => `"${s}": what is technically hard here that a competitor couldn't rebuild quickly?`, generic: "What is the hardest technical part, and how far along is it?" },
  team: { generic: "Why is this team the right one to build it?" },
  gtm: { generic: "How do you get your first hundred paying customers?" },
  risk: { generic: "What is the single biggest risk that could kill this next year?" },
  vision: { generic: "If this works, what does it look like in five years?" },
};

export interface DeckFact { topic: Topic; slideIndex: number; snippet: string }

/** Shortens a line to a quotable snippet (≤ 70 chars, cut at a word). */
export function snippet(line: string, max = 70): string {
  const s = line.replace(/\s+/g, " ").trim().replace(/[.:;,\s]+$/, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[.:;,\s]+$/, "");
}

/** The first line about each topic, earliest slide first; the first slide's first line is the problem / idea. */
export function deckFacts(deck: Deck | null): DeckFact[] {
  const facts = new Map<Topic, DeckFact>();
  for (const slide of deck?.slides ?? []) {
    const lines = slide.text.split(/\n|(?<=[.!?])\s+/).map((l) => l.trim()).filter((l) => l.length > 3);
    if (slide.index === 0 && lines[0] && !facts.has("problem")) facts.set("problem", { topic: "problem", slideIndex: 0, snippet: snippet(lines[0]) });
    for (const line of lines) {
      for (const [topic, re] of TOPIC_PATTERNS) {
        if (!facts.has(topic) && re.test(line)) facts.set(topic, { topic, slideIndex: slide.index, snippet: snippet(line) });
      }
    }
  }
  return [...facts.values()];
}

/** `topic`: a template Topic, or a free label from the director agent's LLM plan. */
export interface PlannedQuestion { judgeId: JudgeId; judgeTitle: string; topic: Topic | (string & {}); slideIndex: number | null; text: string }

/**
 * `count` questions, one judge at a time (toughest first, rotated by `seed`), each on the first
 * topic of the judge's style that is not taken yet, quoting the deck when it covers that topic.
 */
export function planQuestions(deck: Deck | null, judges: JudgeDef[], count: number, seed = 0): PlannedQuestion[] {
  if (!judges.length || count <= 0) return [];
  const facts = new Map(deckFacts(deck).map((f) => [f.topic, f]));
  const order = [...judges].sort((a, b) => b.toughness - a.toughness || a.id.localeCompare(b.id));
  const shift = seed % order.length;
  const rotated = [...order.slice(shift), ...order.slice(0, shift)];
  const used = new Set<Topic>();
  const out: PlannedQuestion[] = [];
  for (let i = 0; i < count; i++) {
    const judge = rotated[i % rotated.length]!;
    const prefs = STYLE_TOPICS[judge.style];
    const topic = prefs.find((t) => !used.has(t) && facts.has(t)) ?? prefs.find((t) => !used.has(t))
      ?? (Object.keys(TEMPLATES) as Topic[]).find((t) => !used.has(t)) ?? prefs[0]!;
    used.add(topic);
    const fact = facts.get(topic);
    const tpl = TEMPLATES[topic];
    const text = fact && tpl.withFact ? tpl.withFact(fact.snippet) : tpl.generic;
    out.push({ judgeId: judge.id, judgeTitle: judge.title, topic, slideIndex: fact && tpl.withFact ? fact.slideIndex : null, text });
  }
  return out;
}

export const CLOSING_LINE = "Thank you. That's all from us.";
