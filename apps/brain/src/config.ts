/** Brain Config (spec: "Config, env and repo layout"). Read once at startup; refuses to start if invalid. */
import { z } from "zod";
import { JJConfig } from "./jj/config.ts";

export const BrainConfig = z.object({
  BRAIN_PORT: z.coerce.number().int().positive().default(8787),
  BRAIN_HOST: z.string().default("127.0.0.1"),
  SESSION_DIR: z.string().default("./data/sessions"),
  /** 1 = don't continue the session saved in SESSION_DIR (same as `--fresh`). */
  BRAIN_FRESH: z.enum(["0", "1"]).default("0"),
  COACH_CLEAN_RUNS: z.coerce.number().int().min(1).default(1),
  COACH_MAX_TRAINING_RUNS: z.coerce.number().int().min(1).default(5),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Extra CORS origins (comma-separated); localhost on any port is always allowed. */
  CORS_ORIGINS: z.string().default("").transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  /** 1 = run without Gemini (FakeVoiceAgent); buttons and the operator panel still work. */
  JJ_FAKE: z.enum(["0", "1"]).default("0"),
  /** Agent swarm models (swarm/llm.ts). All Gemini; without a key the agents use their fallbacks.
   *  Measured 2026-11-08: 3.1-flash-lite ~1.3 s, 3.5-flash-lite ~2.2 s for a short JSON answer; 3.8-flash
   *  timed out (overloaded); 2.5-* are closed to new users. */
  SWARM_TEXT_MODEL: z.string().default("gemini-3.1-flash-lite"),
  SWARM_REPORT_MODEL: z.string().default("gemini-3.5-flash-lite"),
  SWARM_LISTENER_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
  SWARM_VIDEO_MODEL: z.string().default("gemini-3.5-flash-lite"),
  /** 1 = after each run the body agent uploads a copy of the recording to Gemini (Files API), asks once,
   *  deletes it there right after (swarm/body.ts, through the swarm context). 0 = recordings never leave
   *  this computer. The session report says which. */
  SWARM_VIDEO_ANALYSIS: z.enum(["0", "1"]).default("1"),
  /** Chrome or Chromium for the session report PDF (swarm/reportPdf.ts); empty = the usual install paths. */
  CHROME: z.string().default(""),
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
