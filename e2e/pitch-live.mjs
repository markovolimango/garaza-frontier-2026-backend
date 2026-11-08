// Live pitch-mode check (real Gemini key): a pitch fed from a WAV into the brain's mic, then the dashboard.
// No browser: the listener hears the WAV, the reporter writes the analysis. Prints the dashboard numbers.
//
//   brain:  BRAIN_PORT=18788 BRAIN_FRESH=1 SESSION_DIR=data/pitch-live pnpm start:brain   (GEMINI_API_KEY set, JJ_FAKE=0)
//   then:   BRAIN_URL=http://127.0.0.1:18788 node e2e/pitch-live.mjs pitch.wav
// WAV: 16 kHz mono 16-bit (macOS: say -o x.aiff "… um …" && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav).
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = process.env.BRAIN_URL ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const wav = process.argv[2];
if (!wav) { console.error("usage: node e2e/pitch-live.mjs pitch.wav"); process.exit(2); }
const pcm = readFileSync(wav).subarray(44);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const post = async (p) => (await fetch(`${BASE}${p}`, { method: "POST" })).json();
const get = async (p) => { const r = await fetch(`${BASE}${p}`); return r.ok ? r.json() : null; };

// the stage role keeps the session's screen side alive, as the browser would
const stage = new WebSocket(`${WS}/ws/control`);
await new Promise((r) => stage.on("open", r));
stage.send(JSON.stringify({ v: 1, type: "hello", id: "h", ts: Date.now(), payload: { role: "stage", clientId: "pitch-live", protocol: 1 } }));
stage.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "ping") stage.send(JSON.stringify({ v: 1, type: "pong", id: "p", ts: Date.now(), payload: {} })); });

// mic: silence all the time, the WAV on cue (20 ms frames, real time)
const mic = new WebSocket(`${WS}/ws/mic`);
await new Promise((r) => mic.on("open", r));
mic.send(JSON.stringify({ type: "mic.hello", sampleRate: 16000 }));
const queue = [];
const silence = Buffer.alloc(640);
const timer = setInterval(() => mic.send(queue.length ? queue.shift() : silence), 20);
const say = () => new Promise((resolve) => {
  for (let i = 0; i < pcm.length; i += 640) queue.push(Buffer.from(pcm.subarray(i, i + 640)));
  const wait = setInterval(() => { if (!queue.length) { clearInterval(wait); resolve(); } }, 50);
});

await sleep(1500);
const start = await post("/api/pitch/start");
log("start", JSON.stringify(start));
await sleep(1500);   // the listener connects
await say();
await sleep(1500);
const live = await get("/api/pitch/dashboard");
log("live counters", JSON.stringify({ words: live?.speech.words, fillers: live?.speech.fillers.count }));
log("stop", JSON.stringify(await post("/api/pitch/stop")));
log("JJ", (await get("/health")).jj, "(should not be connected)");

let d = null;
for (let i = 0; i < 10; i++) { await sleep(1000); d = await get("/api/pitch/dashboard"); }
log("dashboard", JSON.stringify({ duration: d.durationMs, speech: { measured: d.speech.measured, words: d.speech.words, wpm: d.speech.wpm, fillers: d.speech.fillers.count, perMin: d.speech.fillers.perMin, top: d.speech.fillers.top } }));
for (const p of d.speech.phrases) log("  phrase", `${Math.round(p.tMs / 1000)}s`, p.fillers.length ? `[${p.fillers.join(",")}]` : "", p.text);

let n = null;
for (let i = 0; i < 40; i++) { n = await get(`/api/swarm/report/run/${d.runId}`); if (n?.status === "ready") break; await sleep(1500); }
log("analysis", n?.status, n?.report?.source, "·", n?.report?.headline);
log("  summary:", n?.report?.summary);
for (const m of n?.report?.improvements ?? []) log("  fix:", m.title, "—", m.drill);

clearInterval(timer);
mic.close(); stage.close();
const ok = d.speech.measured && d.speech.words > 20 && d.speech.fillers.count > 0 && n?.status === "ready";
console.log(ok ? "\nOK: transcript, fillers and the analysis" : "\nNOT OK");
process.exit(ok ? 0 : 1);
