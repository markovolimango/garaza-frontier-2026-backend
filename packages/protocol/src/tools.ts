/**
 * Tool argument schemas (spec: "JJ adapter and tools" table).
 * Flat objects only — no unions, refinements or transforms — because Gemini function
 * declarations are generated with z.toJSONSchema() and the operator panel builds its
 * forms from the same schema.
 */
import { z } from "zod";
import { FeedbackCategory, FeedbackEligibleKind, FeedbackLevel, JudgeStyle, LightingPreset, RunMode } from "./domain.ts";

export const ToolName = z.enum([
  "save_brief", "start_run", "end_run", "run_it_back", "resume_run", "go_to_slide",
  "set_targets", "set_feedback_level", "set_feedback_categories", "highlight_pattern",
  "get_last_run_report", "get_session_state", "set_judge", "set_judges",
  "regenerate_personas", "set_audience", "set_qa", "set_lighting", "show_final", "calibrate_gaze",
]);
export type ToolName = z.infer<typeof ToolName>;

const none = z.object({});

export const ToolArgs = {
  save_brief: z.object({
    title: z.string().min(1).max(120).describe("Talk title"),
    audience: z.string().min(1).max(200).describe("Who the talk is for"),
    goal: z.string().min(1).max(200).describe("What the presenter wants from the audience"),
    key_points: z.array(z.string().max(160)).max(6).describe("Up to 6 key points"),
    setting: z.string().min(1).max(60).describe('e.g. "investor pitch", "thesis defence", "client meeting"'),
    duration_min: z.number().positive().max(120).optional().describe("Planned length in minutes"),
  }),
  start_run: z.object({
    mode: RunMode.optional().describe("Omit to follow the coach recommendation"),
    level: FeedbackLevel.optional().describe("Omit to follow the coach recommendation"),
  }),
  end_run: none,
  run_it_back: none,
  resume_run: none,
  go_to_slide: z.object({ index: z.number().int().min(0).describe("0-based slide index") }),
  set_targets: z.object({ behaviors: z.array(FeedbackEligibleKind).max(2) }),
  set_feedback_level: z.object({ level: FeedbackLevel }),
  set_feedback_categories: z.object({ enabled: z.array(FeedbackCategory) }),
  highlight_pattern: z.object({
    kind: z.enum(["arms_crossed", "sway", "face_touch", "looking_down", "not_facing_judge",
      "filler_burst", "pace_fast", "long_pause", "none"]).describe('A behaviour, or "none" to clear'),
  }),
  get_last_run_report: none,
  get_session_state: none,
  set_judge: z.object({
    judge: z.enum(["left", "center", "right", "judge_1", "judge_2", "judge_3", "judge_4", "judge_5"]),
    toughness: z.number().min(0).max(1).optional(),
    style: JudgeStyle.optional(),
    title: z.string().min(1).max(60).optional(),
  }),
  set_judges: z.object({
    count: z.number().int().min(1).max(5).optional(),
    toughness: z.number().min(0).max(1).optional(),
    style: JudgeStyle.optional(),
  }),
  regenerate_personas: z.object({ instruction: z.string().min(1).max(200).describe('One sentence, e.g. "more technical"') }),
  set_audience: z.object({ count: z.number().int().min(0).max(40) }),
  set_qa: z.object({ questions: z.number().int().min(0).max(5) }),
  set_lighting: z.object({ preset: LightingPreset }),
  show_final: none,
  calibrate_gaze: none,
} as const satisfies Record<ToolName, z.ZodObject>;

export type ToolArgsOf<N extends ToolName> = z.infer<(typeof ToolArgs)[N]>;

/** GET /api/tools. The operator panel builds its forms from argsSchema. */
export const ToolCatalogue = z.object({
  tools: z.array(z.object({
    name: ToolName, description: z.string(), argsSchema: z.record(z.string(), z.unknown()),
    behavior: z.enum(["BLOCKING", "NON_BLOCKING"]),
  })),
});
export type ToolCatalogue = z.infer<typeof ToolCatalogue>;
