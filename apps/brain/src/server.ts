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
import { buildDigest, digestHttp } from "./digest.ts";
import { Director } from "./director/director.ts";
import { observedCoach } from "./observedCoach.ts";
import { RunLog } from "./runlog.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));

let config;
try { config = readConfig(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
const log = consoleLogger(config.brain.LOG_LEVEL);

// Judge voices (ElevenLabs). Created before the brain so its debug route can be passed in;
// the hub is bound once the brain exists.
let judgesHttp: ReturnType<typeof judgeVoicesHttp> | null = null;
// The run log needs the session, which createBrain makes; the coach policy and routes reach it lazily.
let runLog: RunLog | null = null;
let digestRoutes: ReturnType<typeof digestHttp> | null = null;

if (config.jj.GEMINI_API_KEY === "fake" && !process.env.GEMINI_API_KEY) log("warn", "jj.fake_no_key", { hint: "set GEMINI_API_KEY in .env for JJ's real voice" });
const brain = createBrain({
  jj: config.jj, log, sessionDir: resolve(REPO, config.brain.SESSION_DIR), corsOrigins: config.brain.CORS_ORIGINS,
  ...(config.brain.JJ_FAKE === "1" ? { agent: new FakeVoiceAgent() } : {}),
  coach: observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: config.brain.COACH_CLEAN_RUNS, maxTrainingRuns: config.brain.COACH_MAX_TRAINING_RUNS }),
  reports: { compactRunReport: (runId) => { const rec = runLog?.get(runId); return rec ? buildDigest(rec, brain.session.get().coach.recommendation) : null; } },
  http: (req, res) => (digestRoutes ? digestRoutes(req, res) : false) || (judgesHttp ? judgesHttp(req, res) : false),
});
const clock = new RealClock();
runLog = new RunLog({ session: brain.session, hub: brain.hub, clock });
digestRoutes = digestHttp(runLog, () => brain.session.get().coach.recommendation);
runLog.onRunEnded((rec) => { brain.hub.send("stage", { type: "report.ready", payload: { kind: "run", runId: rec.runId } }); });
const judges = new JudgeVoices({
  hub: brain.hub, clock, log,
  apiKey: config.brain.ELEVENLABS_API_KEY || undefined,
  voiceIds: config.brain.JUDGE_VOICE_IDS,
});
judgesHttp = judgeVoicesHttp(judges);
new Director({ session: brain.session, hub: brain.hub, voices: judges, clock, log, runLog, speechRms: config.jj.JJ_SPEECH_RMS });
const port = await brain.listen(config.brain.BRAIN_PORT, config.brain.BRAIN_HOST);
log("info", "brain.listening", { url: `http://${config.brain.BRAIN_HOST}:${port}`, jj: config.brain.JJ_FAKE === "1" ? "fake" : config.jj.GEMINI_LIVE_MODEL });

const shutdown = () => { void brain.close().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
