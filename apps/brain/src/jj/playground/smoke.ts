/**
 * Live smoke test: drives the real JJ engine + Gemini Live through the core loop with
 * scripted user turns (sent as text, so no mic is needed) and checks the tool calls.
 *
 *   pnpm jj:smoke               # needs GEMINI_API_KEY
 *
 * Writes the transcript, every event and JJ's audio (WAV) to data/jj-smoke/<timestamp>/.
 * Exit code 0 when no step FAILs (WARN = the model did something reasonable but unexpected).
 */
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJJ, readJJConfig } from "../index.ts";
import type { HubPort, JJClock, Logger } from "../ports.ts";
import type { ToolInvocation } from "../../tools.ts";
import { SimContext, SimMic, SimReports, SimSession } from "./sim.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));
const config = (() => { try { return readJJConfig(); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exit(2); } })();

const outDir = join(REPO, "data", "jj-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
const events = join(outDir, "events.jsonl");
const record = (kind: string, data: Record<string, unknown>) => appendFileSync(events, JSON.stringify({ at: Date.now(), kind, ...data }) + "\n");

const clock: JJClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
const reports = new SimReports();
const session = new SimSession({ clock, onRunFinished: (s) => reports.produce(s) });
const context = new SimContext(session);
const mic = new SimMic(session, clock);

const audio: Int16Array[] = [];
let audioSamples = 0;
const downlinks: { type: string; payload: unknown }[] = [];
const hub: HubPort = {
  send: (_r, m) => { downlinks.push(m); record("down", { type: m.type, payload: m.payload }); return true; },
  broadcast: (_r, m) => { downlinks.push(m); },
  sendAudio: (_s, _f, _q, pcm) => { if (pcm.length) { audio.push(pcm.slice()); audioSamples += pcm.length; } },
};
const log: Logger = (level, msg, data) => { record("log", { level, msg, data }); if (level === "error" || level === "warn") console.log(`  [${level}] ${msg} ${data ? JSON.stringify(data) : ""}`); };

const { engine, tools, agent } = createJJ({ config, session, context, reports, hub, mic, clock, log });

const calls: ToolInvocation[] = [];
tools.onInvoked((i) => { calls.push(i); record("tool", { ...i }); console.log(`  ⚙ ${i.caller} → ${i.name} ${JSON.stringify(i.args)} → ${i.result.ok ? "ok" : `✗ ${i.result.reason}`}`); });
let transcript = "";
let lastWho = "";
agent.onTranscript((t) => {
  record("transcript", { ...t });
  if (t.who !== lastWho) { transcript += `\n${t.who === "jj" ? "JJ" : "USER"}: `; lastWho = t.who; }
  transcript += t.text;
});
const sentToJJ: string[] = [];
const origSend = agent.sendText.bind(agent);
agent.sendText = (text, o) => { sentToJJ.push(text); record("to_jj", { text, turnComplete: o.turnComplete }); origSend(text, o); };

/** A scripted user utterance (text in place of speech). */
const user = (text: string) => { transcript += `\nUSER (text): ${text}`; lastWho = "user-text"; agent.sendText(text, { turnComplete: true }); };

// ---------------- harness ----------------
type Verdict = "PASS" | "WARN" | "FAIL";
const results: { step: string; verdict: Verdict; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(100); }
  return pred();
}
const jjCalls = (name: string, since: number) => calls.filter((c) => c.caller === "jj" && c.name === name && calls.indexOf(c) >= since);
/** Waits for JJ to stop talking (audio stopped arriving for `quietMs`). */
async function untilQuiet(quietMs = 2500, maxMs = 45_000): Promise<void> {
  const end = Date.now() + maxMs;
  let last = audioSamples, lastChange = Date.now();
  while (Date.now() < end) {
    await sleep(200);
    if (audioSamples !== last) { last = audioSamples; lastChange = Date.now(); }
    if (!engine.status().speaking && Date.now() - lastChange >= quietMs) return;
  }
}
function check(step: string, verdict: Verdict, detail: string) {
  results.push({ step, verdict, detail });
  console.log(`${verdict === "PASS" ? "✅" : verdict === "WARN" ? "⚠️ " : "❌"} ${step}: ${detail}`);
}

async function main() {
  console.log(`JJ smoke test · model ${config.GEMINI_LIVE_MODEL} · voice ${config.JJ_VOICE || "default"}\noutput: ${outDir}\n`);
  engine.start();

  // 1. connect + greeting
  let t0 = Date.now();
  session.dispatch({ type: "session_start" });
  const connected = await waitFor(() => engine.status().connected, 20_000);
  check("connect", connected ? "PASS" : "FAIL", connected ? `${Date.now() - t0} ms` : "no Live session within 20 s (key, model name, network?)");
  if (!connected) return;
  const a0 = audioSamples;
  const greeted = await waitFor(() => audioSamples > a0 + 24_000, 20_000);   // > 1 s of speech
  check("greeting audio", greeted ? "PASS" : "FAIL", greeted ? `first audio after ${Date.now() - t0} ms` : "JJ did not speak within 20 s of [SESSION START]");
  await untilQuiet();

  // 2. brief → save_brief → panel
  let mark = calls.length;
  user("Sure. It's a five minute seed pitch for Acme, an AI tool that writes meeting notes. The audience is seed investors and I want them to agree to a follow-up meeting. Key points: we have 40 paying teams, we charge 40 euros per seat, and the team built two similar products before.");
  const briefed = await waitFor(() => jjCalls("save_brief", mark).some((c) => c.result.ok), 60_000);
  const sb = jjCalls("save_brief", mark)[0];
  check("save_brief", briefed ? "PASS" : "FAIL",
    briefed ? `args ${JSON.stringify(sb!.args)}` : sb ? `called but failed: ${JSON.stringify(sb.result)}` : "JJ never called save_brief");
  if (briefed) check("panel generated", session.get().scene.judges.length === 3 ? "PASS" : "FAIL", session.get().scene.judges.map((j) => j.title).join(", "));
  await untilQuiet(3000, 60_000);

  // 3. start the baseline
  mark = calls.length;
  user("Sounds good, I'm ready. Let's start.");
  const started = await waitFor(() => jjCalls("start_run", mark).some((c) => c.result.ok), 30_000);
  const sr = jjCalls("start_run", mark)[0];
  check("start_run", started ? "PASS" : "FAIL", started ? `args ${JSON.stringify(sr!.args)} → ${session.get().run?.mode}/${session.get().run?.feedbackLevel}` : "JJ did not start the run");
  if (!started) return;
  if (session.get().run?.mode !== "baseline") check("first run is baseline", "WARN", `mode ${session.get().run?.mode}; JJ passed ${JSON.stringify(sr!.args)}`);
  await waitFor(() => session.get().run?.phase === "presentation", 5000);
  const leaked = audioSamples; await sleep(3000);
  check("silent during run", audioSamples - leaked < 4800 ? "PASS" : "WARN", `${((audioSamples - leaked) / 24).toFixed(0)} ms of JJ audio reached the stage while not woken`);

  // 4. wake mid-run: "make them tougher" → panel change → resume
  session.dispatch({ type: "slide", index: 3 });
  mark = calls.length;
  t0 = Date.now();
  session.dispatch({ type: "wake", via: "ptt" });
  await sleep(300);
  user("Hey JJ, make the judges tougher please.");
  const changed = await waitFor(() => calls.slice(mark).some((c) => c.caller === "jj" && ["set_judges", "set_judge", "regenerate_personas"].includes(c.name) && c.result.ok), 40_000);
  const ch = calls.slice(mark).find((c) => c.caller === "jj" && ["set_judges", "set_judge", "regenerate_personas"].includes(c.name));
  check("wake: panel change", changed ? "PASS" : "FAIL", ch ? `${ch.name} ${JSON.stringify(ch.args)} → ${JSON.stringify(ch.result)}` : "no panel tool call");
  const resumed = await waitFor(() => session.get().run?.paused === false, 30_000);
  const viaTool = jjCalls("resume_run", mark).length > 0;
  check("wake: resumed", resumed ? "PASS" : "FAIL", resumed ? `${viaTool ? "via resume_run" : "via auto-resume (2.5 s silence)"} after ${Date.now() - t0} ms` : "run still paused after 30 s");
  check("wake note sent", sentToJJ.some((s) => s.startsWith("[WOKEN DURING RUN: presentation, slide 4]")) ? "PASS" : "FAIL", "[WOKEN DURING RUN …]");

  // 5. finish the run → debrief
  await sleep(1000);
  session.dispatch({ type: "presentation_done" });
  session.dispatch({ type: "qa_done" });
  mark = calls.length;
  const a1 = audioSamples;
  check("[RUN ENDED] sent", sentToJJ.some((s) => s.startsWith("[RUN ENDED]")) ? "PASS" : "FAIL", "compact report delivered");
  const debriefed = await waitFor(() => audioSamples > a1 + 48_000, 25_000);
  check("debrief audio", debriefed ? "PASS" : "FAIL", debriefed ? "JJ started the debrief" : "JJ silent after [RUN ENDED]");
  await untilQuiet(3500, 90_000);
  const highlighted = jjCalls("highlight_pattern", mark).length;
  check("highlight_pattern during debrief", highlighted ? "PASS" : "WARN", `${highlighted} calls`);

  // 6. choose targets
  mark = calls.length;
  user("Let's work on the arms crossing.");
  const targeted = await waitFor(() => jjCalls("set_targets", mark).some((c) => c.result.ok), 30_000);
  const st = jjCalls("set_targets", mark)[0];
  check("set_targets", targeted ? "PASS" : "FAIL", st ? `${JSON.stringify(st.args)} → ${JSON.stringify(st.result)}` : "no set_targets call");
  await untilQuiet(3000, 45_000);
}

function writeWav(path: string, chunks: Int16Array[], rate = 24_000) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let o = 44; for (const c of chunks) for (const v of c) { buf.writeInt16LE(v, o); o += 2; }
  writeFileSync(path, buf);
}

const hardTimeout = setTimeout(() => { check("overall", "FAIL", "smoke test exceeded 6 minutes"); void finish(); }, 6 * 60_000);
async function finish() {
  clearTimeout(hardTimeout);
  await engine.stop().catch(() => {});
  writeWav(join(outDir, "jj.wav"), audio);
  writeFileSync(join(outDir, "transcript.txt"), transcript.trim() + "\n");
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const fails = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - fails}/${results.length} without failure · ${(audioSamples / 24_000).toFixed(1)} s of JJ audio`);
  console.log(`transcript: ${join(outDir, "transcript.txt")}\naudio:      ${join(outDir, "jj.wav")}\nevents:     ${events}`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { check("harness", "FAIL", String(e)); }).finally(() => void finish());
