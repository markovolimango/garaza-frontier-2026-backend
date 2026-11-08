// Live swarm check: drives a real brain (real Gemini key) through one training run with a fake
// presenter: deck upload, the mic fed from WAV files (speech with fillers), the Q&A answered from a
// WAV, then waits for the reporter's run narrative and the session PDF. Prints what every agent did.
//
//   brain:  cd apps/brain && BRAIN_PORT=18871 SESSION_DIR=/tmp/x ../../node_modules/.bin/tsx src/server.ts
//   then:   BRAIN_URL=http://127.0.0.1:18871 node e2e/swarm-live.mjs pitch.wav answer.wav
// WAVs: 16 kHz mono 16-bit (macOS: say -o x.aiff "…" && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav).
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = process.env.BRAIN_URL ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const [pitchWav, answerWav] = process.argv.slice(2);
if (!pitchWav || !answerWav) { console.error("usage: node e2e/swarm-live.mjs pitch.wav answer.wav"); process.exit(2); }
const pcmOf = (f) => readFileSync(f).subarray(44);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
let seq = 0;
const env = (type, payload) => JSON.stringify({ v: 1, type, id: `s${++seq}`, ts: Date.now(), payload });

// ---- stage (control) ----
const got = [];
const pending = new Map();
const stage = new WebSocket(`${WS}/ws/control`);
stage.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  got.push({ at: Date.now(), m });
  if (m.type === "ping") stage.send(env("pong", {}));
  if (m.type === "scene.apply") stage.send(env("ack", { batchId: m.payload.batchId, version: m.payload.version, ok: true }));
  if (m.replyTo && pending.has(m.replyTo)) { pending.get(m.replyTo)(m); pending.delete(m.replyTo); }
  if (m.type === "actor.say" && m.payload.actorId !== "jj") log(`JUDGE ${m.payload.actorId}: ${m.payload.text}`);
  if (m.type === "feedback.set" && m.payload.kind !== "none") log(`VIGNETTE ${m.payload.kind} ${m.payload.intensity}`);
  if (m.type === "jj.transcript" && m.payload.final) log(`JJ caption (${m.payload.who}): ${m.payload.text.slice(0, 120)}`);
});
await new Promise((r) => stage.on("open", r));
stage.send(env("hello", { role: "stage", clientId: "swarm-live", protocol: 1 }));
await sleep(300);
const tool = (name, args = {}) => new Promise((resolve) => {
  const id = `s${++seq}`;
  pending.set(id, resolve);
  stage.send(JSON.stringify({ v: 1, type: "tool.invoke", id, ts: Date.now(), payload: { tool: name, args } }));
});

// ---- mic: silence all the time, WAVs on cue ----
const mic = new WebSocket(`${WS}/ws/mic`);
await new Promise((r) => mic.on("open", r));
mic.send(JSON.stringify({ type: "mic.hello", sampleRate: 16000 }));
let queue = [];
const silence = Buffer.alloc(640);
const micTimer = setInterval(() => { mic.send(queue.length ? queue.shift() : silence); }, 20);
const say = (pcm) => new Promise((resolve) => {
  for (let i = 0; i < pcm.length; i += 640) queue.push(Buffer.from(pcm.subarray(i, i + 640)));
  const wait = setInterval(() => { if (!queue.length) { clearInterval(wait); resolve(); } }, 50);
});

// ---- deck ----
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const fd = new FormData();
const slides = ["Acme: an AI coach for presentations", "Traction: 40 paying teams, 120% net revenue retention", "Pricing: 40 euros per seat per month"];
fd.append("manifest", JSON.stringify({ name: "acme", slides: slides.map((text, index) => ({ index, text, width: 1, height: 1 })) }));
slides.forEach((_, i) => fd.append(`slide_${i}.png`, new Blob([png], { type: "image/png" }), `slide_${i}.png`));
const deck = await (await fetch(`${BASE}/api/uploads/deck`, { method: "POST", body: fd })).json();
log("deck", deck.deckId);
stage.send(env("session.start", {}));
await sleep(1500);

// ---- JJ orders the director (as JJ would by voice) ----
log("direct_judges →", JSON.stringify((await tool("direct_judges", { strictness: "tough", focus: ["pricing"], questions: 2, follow_ups: true })).payload));

// ---- run: training, strong (so the filler vignette may fire) ----
log("start_run →", JSON.stringify((await tool("start_run", { mode: "training", level: "strong" })).payload));
await sleep(3800);
log("presenting (pitch WAV)…");
const pitch = pcmOf(pitchWav);
const half = Math.floor(pitch.length / 2 / 640) * 640;
await say(pitch.subarray(0, half));
stage.send(env("slide.changed", { index: 1, clientTs: Date.now() }));
await say(pitch.subarray(half));
await sleep(3000);
stage.send(env("presentation.done", {}));
log("Q&A");

// Answer every question with the answer WAV once the judge has finished (idle gesture), until the run ends.
const answered = new Set();
const runEnded = () => got.some((g) => g.m.type === "report.ready" && g.m.payload.kind === "run");
while (!runEnded() && Date.now() - t0 < 240_000) {
  const idle = got.filter((g) => g.m.type === "actor.gesture" && g.m.payload.gesture === "idle" && g.m.payload.actorId.startsWith("judge_"));
  const say_ = got.filter((g) => g.m.type === "actor.say" && g.m.payload.actorId.startsWith("judge_"));
  const last = say_.at(-1);
  if (last && !answered.has(last.m.payload.utteranceId) && idle.some((g) => g.at > last.at) && !/thank/i.test(last.m.payload.text)) {
    answered.add(last.m.payload.utteranceId);
    await sleep(600);
    log("answering…");
    await say(pcmOf(answerWav));
  }
  await sleep(200);
}
log(runEnded() ? "run ended" : "TIMEOUT waiting for the run to end");

// ---- what the agents know ----
for (const agent of ["listener", "director", "body"]) {
  const r = await tool("ask_agent", { agent });
  log(`ask_agent ${agent}:`, JSON.stringify(r.payload).slice(0, 600));
}
log("waiting for the reporter…");
let rep = null;
for (let i = 0; i < 60; i++) {
  rep = await (await fetch(`${BASE}/api/swarm/report/run/run_1`)).json();
  if (rep.status === "ready") break;
  await sleep(1500);
}
log("run report:", rep.status, rep.report?.source, "·", rep.report?.headline);
for (const imp of rep.report?.improvements ?? []) log("  improve:", imp.title, "—", imp.evidence);
for (const q of rep.report?.qa ?? []) log("  Q&A:", q.verdict, "·", q.question?.slice(0, 80));
log("fillers:", JSON.stringify(rep.report?.fillers));
const pdf = await fetch(`${BASE}/api/swarm/report/session.pdf?download=1`);
const bytes = Buffer.from(await pdf.arrayBuffer());
writeFileSync("/tmp/swarm-live-report.pdf", bytes);
log("session PDF:", pdf.status, bytes.length, "bytes → /tmp/swarm-live-report.pdf");
const activity = got.filter((g) => g.m.type === "swarm.activity").at(-1)?.m.payload.agents ?? [];
log("agents panel now:");
for (const a of activity) log(`  ${a.id.padEnd(9)} ${a.state.padEnd(9)} ${a.detail}`);
log("vignettes:", got.filter((g) => g.m.type === "feedback.set" && g.m.payload.kind === "warn").length, "· judge lines:", got.filter((g) => g.m.type === "actor.say" && g.m.payload.actorId !== "jj").length);
clearInterval(micTimer);
mic.close(); stage.close();
process.exit(0);
