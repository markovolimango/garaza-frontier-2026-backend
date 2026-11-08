/**
 * Live check of the swarm listener: streams a 16 kHz mono WAV (44-byte header) through the real
 * Listener (Gemini Live) as if it were the presenter's mic during a training run, then prints the
 * phrases, fillers, RunLog bursts and vignettes.
 *
 *   GEMINI_API_KEY=… pnpm --filter @coach/brain exec tsx src/swarm/smoke/listener.ts path/to/speech.wav
 */
import { readFileSync } from "node:fs";
import { GREYBOX_VENUE, type DownlinkMessage, type SceneDef } from "@coach/protocol";
import { defaultScene } from "../../brain.ts";
import { RealClock } from "../../clock.ts";
import { placeholderCoach } from "../../placeholders.ts";
import { RunLog } from "../../runlog.ts";
import { SessionStore } from "../../session.ts";
import { SwarmBoard } from "../board.ts";
import { FillerFeedback } from "../feedback.ts";
import { Listener } from "../listener.ts";

const wav = process.argv[2];
const apiKey = process.env.GEMINI_API_KEY ?? null;
if (!wav || !apiKey) { console.error("usage: GEMINI_API_KEY=… tsx src/swarm/smoke/listener.ts file.wav (16 kHz mono)"); process.exit(2); }
const model = process.env.SWARM_LISTENER_MODEL ?? "gemini-3.1-flash-live-preview";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clock = new RealClock();
const scene: SceneDef = { ...defaultScene(["v1", "v2", "v3", "v4"]), qa: { questions: 1, answerCapMs: 45_000 } };
const store = new SessionStore({ clock, coach: placeholderCoach, venue: GREYBOX_VENUE, initialScene: scene, countdownMs: 300, stage: { isConnected: () => true, send: () => true } });
const micFns: ((pcm: Int16Array) => void)[] = [];
const hub = {
  onMic: (fn: (pcm: Int16Array) => void) => { micFns.push(fn); },
  onOutbound: (_fn: (m: DownlinkMessage, roles: unknown[]) => void) => {},
  on: () => {},
};
const runLog = new RunLog({ session: store, hub: { on: () => {}, onOutbound: () => {}, connections: () => ({ stage: true, sensor: false, operator: false }) }, clock });
const board = new SwarmBoard({ clock });
const t0 = Date.now();
const at = (t: number) => `${((t - t0) / 1000).toFixed(1)}s`;
const log = (level: string, msg: string, data?: Record<string, unknown>) => { if (level !== "debug") console.log(`  [${at(Date.now())}] ${level} ${msg}`, data ? JSON.stringify(data) : ""); };
new FillerFeedback({ board, session: store, clock, log, sync: { forceVignette: (k, i, h) => console.log(`  [${at(Date.now())}] VIGNETTE ${k} ${i} ${h} ms`) } });
const listener = new Listener({ board, session: store, hub, runLog, clock, log, apiKey, model, speechRms: 700 });
board.on("phrase", (e) => {
  const p = e.phrase;
  console.log(`  [${at(Date.now())}] PHRASE ${at(p.startAt)}–${at(p.endAt)} slide ${p.slideIndex + 1} ${p.segment} fillers=${JSON.stringify(p.fillers)} "${p.text}"`);
});
board.onStatus((all) => { const s = all.find((a) => a.id === "listener")!; console.log(`  [${at(Date.now())}] status listener: ${s.state} · ${s.detail}`); });

store.setContext({ deck: { deckId: "d", name: "smoke", slides: [0, 1, 2].map((i) => ({ index: i, url: `/x/${i}.png`, text: `slide ${i}` })) } });
store.dispatch({ type: "session_start" });
store.dispatch({ type: "start_run", mode: "training", level: "strong" });
for (let i = 0; i < 200 && !listener.connected; i++) await sleep(50);
if (!listener.connected) { console.error("listener did not connect"); process.exit(1); }
console.log(`connected (${model}); streaming ${wav}`);

const buf = readFileSync(wav);
const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength - ((buf.byteLength - 44) % 2)));
const send = (frame: Int16Array) => { for (const f of micFns) f(frame); };
const started = Date.now();
for (let i = 0, n = 0; i < pcm.length; i += 320, n++) {
  send(pcm.subarray(i, i + 320));
  const due = started + (n + 1) * 20 - Date.now();
  if (due > 0) await sleep(due);
}
console.log(`  [${at(Date.now())}] audio done (${(pcm.length / 16000).toFixed(1)} s); 5 s of silence`);
const silence = new Int16Array(320);
for (let n = 0; n < 250; n++) { send(silence); await sleep(20); }
store.dispatch({ type: "end_run" });
await sleep(3500);

const rec = runLog.latest()!;
const phrases = board.phrases(rec.runId);
console.log("\n=== result ===");
console.log(`phrases: ${phrases.length}, fillers: ${phrases.reduce((a, p) => a + p.fillers.length, 0)} ${JSON.stringify(phrases.flatMap((p) => p.fillers))}`);
console.log(`RunLog filler_burst observations: ${rec.observations.filter((o) => o.kind === "filler_burst").length}`);
for (const o of rec.observations) console.log(`  ${o.rule} ${o.kind} ${at(o.at)} ${o.text}`);
console.log(`transcript:\n${board.transcript(rec.runId)}`);
process.exit(0);
