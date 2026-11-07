import { z } from "zod";

/** JJ slice of the brain Config (spec: "Config, env and repo layout"). */
export const JJConfig = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required for JJ"),
  GEMINI_LIVE_MODEL: z.string().min(1).default("gemini-3.8-live"),
  JJ_VOICE: z.string().default(""),
  JUDGE_VOICES: z.string().default("").transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean)),
  /** Mic RMS threshold for "user is speaking" during a wake (auto-resume). */
  JJ_SPEECH_RMS: z.coerce.number().int().positive().default(700),
});
export type JJConfig = z.infer<typeof JJConfig>;

export function readJJConfig(env: Record<string, string | undefined> = process.env): JJConfig {
  const r = JJConfig.safeParse(env);
  if (!r.success) throw new Error(`invalid JJ config:\n${z.prettifyError(r.error)}`);
  return r.data;
}
