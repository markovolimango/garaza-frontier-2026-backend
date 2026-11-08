/**
 * Brain entry point: `pnpm start:brain` (no reload: the demo), `pnpm dev:brain` (tsx watch: restarts
 * on every code change). Loads .env from the repo root, validates config, continues the session
 * saved in SESSION_DIR (persist.ts; `--fresh` or BRAIN_FRESH=1 starts a new one), and starts on
 * BRAIN_PORT (8787).
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrain } from "./brain.ts";
import { readConfig } from "./config.ts";
import { FakeVoiceAgent } from "./jj/index.ts";
import { consoleLogger } from "./log.ts";
import { RealClock } from "./clock.ts";
import { JudgeVoices, judgeVoicesHttp } from "./voices/judgeVoice.ts";
import { buildDigest, digestHttp } from "./digest.ts";
import { observedCoach } from "./observedCoach.ts";
import { loadLatest, SessionPersistence, sessionHttp } from "./persist.ts";
import { buildProgress, compactProgress, progressHttp } from "./progress.ts";
import { exportHttp } from "./export.ts";
import { MediaStore, mediaHttp, momentsOf } from "./media.ts";
import { pptxHttp } from "./pptx.ts";
import { BEHAVIOR_WORDS } from "./observedCoach.ts";
import { RunLog } from "./runlog.ts";
import { installSwarm, type Swarm } from "./swarm/index.ts";

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
let progressRoutes: ReturnType<typeof progressHttp> | null = null;
let sessionRoutes: ReturnType<typeof sessionHttp> | null = null;
let exportRoutes: ReturnType<typeof exportHttp> | null = null;
let mediaRoutes: ReturnType<typeof mediaHttp> | null = null;
let media: MediaStore | null = null;
let pptxRoutes: ReturnType<typeof pptxHttp> | null = null;
let swarm: Swarm | null = null;

// The session saved before the last stop (runs, reports, coach, deck), unless a fresh start was asked for.
const sessionDir = resolve(REPO, config.brain.SESSION_DIR);
const fresh = process.argv.includes("--fresh") || config.brain.BRAIN_FRESH === "1";
const saved = fresh ? null : loadLatest(sessionDir, log);
if (saved) log("info", "brain.session_restored", { sessionId: saved.state.sessionId, phase: saved.state.phase, runs: saved.runs.length });

if (config.jj.GEMINI_API_KEY === "fake" && !process.env.GEMINI_API_KEY) log("warn", "jj.fake_no_key", { hint: "set GEMINI_API_KEY in .env for JJ's real voice" });
const brain = createBrain({
  jj: config.jj, log, sessionDir, corsOrigins: config.brain.CORS_ORIGINS,
  ...(saved ? { restore: saved.state } : {}),
  ...(config.brain.JJ_FAKE === "1" ? { agent: new FakeVoiceAgent() } : {}),
  coach: observedCoach({ get: (id) => runLog?.get(id) ?? null }, { cleanRuns: config.brain.COACH_CLEAN_RUNS, maxTrainingRuns: config.brain.COACH_MAX_TRAINING_RUNS }),
  // JJ's debrief: the run digest plus how the session went so far (run 1 → 2 → 3).
  reports: { compactRunReport: (runId) => {
    const rec = runLog?.get(runId);
    if (!rec || !runLog) return null;
    const s = brain.session.get();
    return { ...buildDigest(rec, s.coach.recommendation), progress: buildProgress(runLog.list(), s).headline };
  },
  // JJ's final narration: per behaviour, first run → last (counts, per minute, share of time), targets' status.
  sessionProgress: () => (runLog ? compactProgress(buildProgress(runLog.list(), brain.session.get())) : null),
  // JJ's show_moments: one behaviour's moments in the last (or first) finished run, as clips of its recording.
  moments: (kind, which) => {
    const runs = brain.session.get().completedRuns;
    const runId = which === "first" ? runs[0] : runs.at(-1);
    const rec = runId ? runLog?.get(runId) : null;
    if (!runId || !rec) return { ok: false, reason: "not_available", hint: "no run has finished yet" };
    const recording = media?.get(runId);
    if (!recording) return { ok: false, reason: "not_available", hint: "that run was not recorded (no consent, or no camera)" };
    const { total, clips } = momentsOf(rec, recording, kind);
    const words = BEHAVIOR_WORDS[kind];
    if (!clips.length) return { ok: false, reason: "not_available", hint: total ? `the ${words} moments fall outside the recording` : `no ${words} in run ${rec.run.index}` };
    const title = `${words.charAt(0).toUpperCase()}${words.slice(1)} · run ${rec.run.index} · ${total} time${total === 1 ? "" : "s"}`;
    return { ok: true, runId: rec.runId, runIndex: rec.run.index, title, total, clips };
  } },
  http: async (req, res) => (swarm ? await swarmRoutes(swarm, req, res) : false) || (digestRoutes ? digestRoutes(req, res) : false) || (progressRoutes ? progressRoutes(req, res) : false)
    || (exportRoutes ? exportRoutes(req, res) : false)
    || (mediaRoutes ? await mediaRoutes(req, res) : false)
    || (pptxRoutes ? await pptxRoutes(req, res) : false)
    || (sessionRoutes ? await sessionRoutes(req, res) : false) || (judgesHttp ? judgesHttp(req, res) : false),
});
const clock = new RealClock();
runLog = new RunLog({ session: brain.session, hub: brain.hub, clock, ...(saved ? { restore: saved.runs } : {}) });
const persistence = new SessionPersistence({ dir: sessionDir, session: brain.session, runLog, clock, log });
digestRoutes = digestHttp(runLog, () => brain.session.get().coach.recommendation);
progressRoutes = progressHttp(runLog, () => brain.session.get());
exportRoutes = exportHttp(runLog, () => brain.session.get());
media = new MediaStore({ dir: sessionDir, sessionId: () => brain.session.get().sessionId, hasRun: (id) => !!runLog?.get(id), log });
mediaRoutes = mediaHttp(media);
pptxRoutes = pptxHttp({ log });   // .pptx decks → PDF via PowerPoint on this Mac
sessionRoutes = sessionHttp({ session: brain.session, runLog, persistence });
runLog.onRunEnded((rec) => { brain.hub.send("stage", { type: "report.ready", payload: { kind: "run", runId: rec.runId } }); });
brain.session.subscribe((s, cause) => {
  if (!Array.isArray(cause) && cause.type === "show_final") brain.hub.send("stage", { type: "report.ready", payload: { kind: "final", sessionId: s.sessionId } });
});
const judges = new JudgeVoices({
  hub: brain.hub, clock, log,
  apiKey: config.brain.ELEVENLABS_API_KEY || undefined,
  voiceIds: config.brain.JUDGE_VOICE_IDS,
});
judgesHttp = judgeVoicesHttp(judges);
// The agent swarm JJ leads: listener, director (owns the Q&A Director), body, reporter, feedback (swarm/).
swarm = installSwarm({
  brain, runLog, judges, media, clock, log, sessionDir, speechRms: config.jj.JJ_SPEECH_RMS,
  models: {
    apiKey: config.brain.JJ_FAKE === "1" ? null : config.jj.GEMINI_API_KEY,
    text: config.brain.SWARM_TEXT_MODEL, report: config.brain.SWARM_REPORT_MODEL,
    listener: config.brain.SWARM_LISTENER_MODEL, video: config.brain.SWARM_VIDEO_MODEL,
  },
});
async function swarmRoutes(sw: Swarm, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  for (const route of sw.routes) if (await route(req, res)) return true;
  return false;
}
const port = await brain.listen(config.brain.BRAIN_PORT, config.brain.BRAIN_HOST);
log("info", "brain.listening", { url: `http://${config.brain.BRAIN_HOST}:${port}`, jj: config.brain.JJ_FAKE === "1" ? "fake" : config.jj.GEMINI_LIVE_MODEL });

persistence.saveNow();
const shutdown = () => { persistence.saveNow(); swarm?.save(); void brain.close().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
