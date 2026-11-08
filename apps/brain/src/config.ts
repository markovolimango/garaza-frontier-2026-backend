/** Brain Config (spec: "Config, env and repo layout"). Read once at startup; refuses to start if invalid. */
import { z } from "zod";
import { JJConfig } from "./jj/config.ts";

export const BrainConfig = z.object({
  BRAIN_PORT: z.coerce.number().int().positive().default(8787),
  BRAIN_HOST: z.string().default("127.0.0.1"),
  SESSION_DIR: z.string().default("./data/sessions"),
  RECORD_AUDIO: z.enum(["0", "1"]).default("0"),
  AUDIO_OUTPUT: z.enum(["headphones", "speakers"]).default("headphones"),
  COACH_CLEAN_RUNS: z.coerce.number().int().min(1).default(1),
  COACH_MAX_TRAINING_RUNS: z.coerce.number().int().min(1).default(5),
  WAKE_PHRASES: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Extra CORS origins (comma-separated); localhost on any port is always allowed. */
  CORS_ORIGINS: z.string().default("").transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  /** 1 = run without Gemini (FakeVoiceAgent); buttons and the operator panel still work. */
  JJ_FAKE: z.enum(["0", "1"]).default("0"),
  /** Judge TTS (voices/judgeVoice.ts). Empty = judges send actor.say/gestures but no audio. Independent of JJ_FAKE. */
  ELEVENLABS_API_KEY: z.string().default(""),
  /** Comma-separated ElevenLabs voiceIds for judge_1..judge_4; empty entries fall back to premade defaults. */
  JUDGE_VOICE_IDS: z.string().default("").transform((s) => s.split(",").map((v) => v.trim())),
});
export type BrainConfig = z.infer<typeof BrainConfig>;

export function readConfig(env: Record<string, string | undefined> = process.env): { brain: BrainConfig; jj: JJConfig } {
  const b = BrainConfig.safeParse(env);
  if (!b.success) throw new Error(`invalid brain config:\n${z.prettifyError(b.error)}`);
  // No Gemini key → fake JJ (instead of refusing to start), so adding the key later is all it takes.
  if (!env.GEMINI_API_KEY?.trim()) b.data.JJ_FAKE = "1";
  const jjEnv = b.data.JJ_FAKE === "1" ? { ...env, GEMINI_API_KEY: env.GEMINI_API_KEY || "fake" } : env;
  const j = JJConfig.safeParse(jjEnv);
  if (!j.success) throw new Error(`invalid JJ config:\n${z.prettifyError(j.error)}\n(set JJ_FAKE=1 to run without Gemini)`);
  return { brain: b.data, jj: j.data };
}
