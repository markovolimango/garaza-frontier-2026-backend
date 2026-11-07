/**
 * Brain entry point: `pnpm dev:brain` (tsx watch) or `pnpm --filter @coach/brain start`.
 * Loads .env from the repo root, validates config, starts on BRAIN_PORT (8787).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrain } from "./brain.ts";
import { readConfig } from "./config.ts";
import { FakeVoiceAgent } from "./jj/index.ts";
import { consoleLogger } from "./log.ts";
import { RealClock } from "./clock.ts";
import { JudgeVoices, judgeVoicesHttp } from "./voices/judgeVoice.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));

let config;
try { config = readConfig(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
const log = consoleLogger(config.brain.LOG_LEVEL);

// Judge voices (ElevenLabs). Created before the brain so its debug route can be passed in;
// the hub is bound once the brain exists.
let judgesHttp: ReturnType<typeof judgeVoicesHttp> | null = null;

const brain = createBrain({
  jj: config.jj, log,
  ...(config.brain.JJ_FAKE === "1" ? { agent: new FakeVoiceAgent() } : {}),
  http: (req, res) => judgesHttp ? judgesHttp(req, res) : false,
});
const judges = new JudgeVoices({
  hub: brain.hub, clock: new RealClock(), log,
  apiKey: config.brain.ELEVENLABS_API_KEY || undefined,
  voiceIds: config.brain.JUDGE_VOICE_IDS,
});
judgesHttp = judgeVoicesHttp(judges);
const port = await brain.listen(config.brain.BRAIN_PORT, config.brain.BRAIN_HOST);
log("info", "brain.listening", { url: `http://${config.brain.BRAIN_HOST}:${port}`, jj: config.brain.JJ_FAKE === "1" ? "fake" : config.jj.GEMINI_LIVE_MODEL });

const shutdown = () => { void brain.close().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
