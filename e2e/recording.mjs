// Browser e2e: run recording and JJ's replay of moments, in headless Chrome with a fake camera.
//
// Needs, already running (a fresh session):
//   brain:     JJ_FAKE=1 pnpm dev:brain                       (port 8787; BRAIN_URL overrides)
//   frontend:  pnpm dev:frontend                               (port 5174; FRONTEND_URL overrides)
// Then:        node e2e/recording.mjs
// Flow: talk to JJ before the deck → consent → upload slides on JJ's screen → recorded run with an
// arms_crossed episode from the sensor role → show_moments plays it → reset erases the recording.
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "data", "e2e");
mkdirSync(OUT, { recursive: true });
const FE = process.env.FRONTEND_URL ?? "http://localhost:5174";
const BRAIN = process.env.BRAIN_URL ?? "http://127.0.0.1:8787";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 150) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }
const get = async (p) => (await fetch(`${BRAIN}${p}`)).json();
if ((await get("/health")).phase !== "setup") { console.error("The brain must be in a fresh session (phase setup): restart it."); process.exit(2); }

/** A control socket in one role. */
async function client(role) {
  const ws = new WebSocket(`${BRAIN.replace("http", "ws")}/ws/control`);
  let n = 0; const replies = new Map(); const state = { snap: null };
  const env = (type, payload) => ({ v: 1, type, id: `${role}_${++n}`, ts: Date.now(), payload });
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "state.snapshot") state.snap = m.payload; if (m.type === "ping") ws.send(JSON.stringify(env("pong", {}))); if (m.replyTo) replies.get(m.replyTo)?.(m); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify(env("hello", { role, clientId: `e2e-${role}`, protocol: 1 })));
  const send = (type, payload) => { const e = env(type, payload); ws.send(JSON.stringify(e)); return new Promise((r) => { replies.set(e.id, r); setTimeout(() => r(null), 5000); }); };
  return { ws, state, send, tool: async (tool, args = {}) => (await send("tool.invoke", { tool, args }))?.payload ?? null };
}
const op = await client("operator");
const sensor = await client("sensor");

const CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? CHROMES.find((p) => existsSync(p)) ?? CHROMES[1], headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["microphone", "camera"] });
{ // Vite's first-visit dependency optimisation reloads the page: warm it up on a throwaway page
  const warm = await ctx.newPage();
  await warm.goto(FE + "/", { waitUntil: "load" });
  await sleep(3000);
  await warm.close();
  await waitFor(async () => !(await get("/health")).connected.includes("stage"), 5000);
}
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const path = () => new URL(page.url()).pathname;
const shot = (name) => page.screenshot({ path: join(OUT, `rec-${name}.png`) });

try {
  await page.goto(FE + "/", { waitUntil: "networkidle" });
  check("setup → presenter screen", !!(await waitFor(() => path() === "/presenter")), path());
  await page.getByText("Talk to JJ first").click();
  check("Talk to JJ first → intro without a deck, JJ's screen", !!(await waitFor(async () => (await get("/health")).phase === "intro" && path() === "/")), path());
  check("a run needs the deck", (await op.tool("start_run"))?.reason === "no_deck");

  await page.getByRole("button", { name: "Record runs" }).click();
  check("consent card → recording allowed", !!(await waitFor(() => page.evaluate(() => sessionStorage.getItem("coach.recordConsent") === "yes"))));
  await page.setInputFiles('input[type=file][accept="application/pdf"]', join(REPO, "fixtures", "decks", "sample-3-slides.pdf"));
  check("Upload slides on JJ's screen → 3-slide deck", !!(await waitFor(() => op.state.snap?.session?.context?.deck?.slides?.length === 3, 20000)));
  await shot("1-intro");

  check("start_run → presentation", (await op.tool("start_run"))?.ok === true && !!(await waitFor(() => op.state.snap?.session?.run?.phase === "presentation", 8000)));
  check("● REC while the run is under way", !!(await waitFor(() => page.getByText("● REC").isVisible())));
  await sleep(4000);
  const start = Date.now() - 500;
  await sensor.send("behavior", { kind: "arms_crossed", phase: "start", clientTs: start, conf: 1 });
  await sleep(5000);
  await sensor.send("behavior", { kind: "arms_crossed", phase: "end", clientTs: Date.now(), conf: 1 });
  await sleep(2500);
  await shot("2-run");
  check("end_run → run ended", (await op.tool("end_run"))?.ok === true && !!(await waitFor(() => op.state.snap?.session?.run?.phase === "ended")));
  const recorded = await waitFor(async () => (await get("/api/media")).recordings.find((r) => r.runId === "run_1" && r.done && r.bytes > 50_000), 15000);
  check("the recording is on the brain", !!recorded, recorded ? `${Math.round(recorded.bytes / 1024)} KB in ${recorded.chunks} chunks, ${recorded.mimeType}` : "");
  check("REC off after the run", !!(await waitFor(async () => !(await page.getByText("● REC").isVisible()))));

  const r = await op.tool("show_moments", { kind: "arms_crossed" });
  check("show_moments arms_crossed → 1 moment", r?.ok === true && r.total === 1 && r.shown === 1, JSON.stringify(r));
  const playing = await waitFor(() => page.evaluate(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.currentTime > 0 && !v.paused ? v.currentTime : null; }), 10000);
  check("the player shows the moment from the recording", !!playing, `currentTime ${playing}`);
  check("player title", await page.getByText("Crossed arms · run 1 · 1 time").isVisible());
  await shot("3-moments");
  const closed = await waitFor(() => page.evaluate(() => !document.querySelector("video")), 20000);
  check("the player closes itself after the clip", !!closed);
  check("show_moments for something that never happened → ok:false", (await op.tool("show_moments", { kind: "face_touch" }))?.ok === false);

  const reset = await (await fetch(`${BRAIN}/api/session/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  check("Delete and start over erases the session", reset.ok && reset.deleted === true);
  check("no recordings in the new session", (await get("/api/media")).recordings.length === 0);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("no exception", false, String(err));
} finally {
  await browser.close(); op.ws.close(); sensor.ws.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
