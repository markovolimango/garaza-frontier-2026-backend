// Browser e2e: pitch mode (/pitch), the stage demo: JJ silent, start → talk → dashboard.
//
// Needs, already running (a fresh session, phase setup):
//   brain:     JJ_FAKE=1 BRAIN_FRESH=1 SESSION_DIR=data/e2e-sessions pnpm start:brain   (port 8787; BRAIN_URL overrides)
//   frontend:  pnpm dev:frontend                                                         (port 5174; FRONTEND_URL overrides)
// Then:        node e2e/pitch.mjs
// With JJ_FAKE=1 there is no listener (no Gemini), so speech is "not measured"; the sensor role sends
// camera episodes, which the dashboard must show on its timeline and in the body table.
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
if ((await get("/health")).phase !== "setup") { console.error("The brain must be in a fresh session (phase setup): start it with BRAIN_FRESH=1, or POST /api/session/reset."); process.exit(2); }

/** A control socket in one role. */
async function client(role) {
  const ws = new WebSocket(`${BRAIN.replace("http", "ws")}/ws/control`);
  let n = 0;
  const env = (type, payload) => ({ v: 1, type, id: `${role}_${++n}`, ts: Date.now(), payload });
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "ping") ws.send(JSON.stringify(env("pong", {}))); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify(env("hello", { role, clientId: `e2e-${role}`, protocol: 1 })));
  return { send: (type, payload) => ws.send(JSON.stringify(env(type, payload))), close: () => ws.close() };
}
const sensor = await client("sensor");

const CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? CHROMES.find((p) => existsSync(p)) ?? CHROMES[1], headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["microphone", "camera"] });
{ // Vite's first-visit dependency optimisation reloads the page: warm it up on a throwaway page
  const warm = await ctx.newPage();
  await warm.goto(FE + "/pitch", { waitUntil: "load" });
  await sleep(3000);
  await warm.close();
  await waitFor(async () => !(await get("/health")).connected.includes("stage"), 5000);
}
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const path = () => new URL(page.url()).pathname;
const shot = (name) => page.screenshot({ path: join(OUT, `pitch-${name}.png`), fullPage: true });

try {
  await page.goto(FE + "/pitch", { waitUntil: "load" });
  check("/pitch stays /pitch (the brain's setup view doesn't move it)", !!(await waitFor(() => page.getByRole("button", { name: "Start listening" }).isVisible())) && (await sleep(1500), path() === "/pitch"), path());
  for (let i = 0; i < 3; i++) { sensor.send("sensor.status", { camera: "ok", fps: 12, posePresent: true }); await sleep(300); }
  check("ready: the camera sees you", !!(await waitFor(async () => (await page.textContent("main"))?.includes("sees you"))));
  await shot("1-ready");

  await page.getByRole("button", { name: "Start listening" }).click();
  const started = await waitFor(async () => { const h = await get("/health"); return h.phase === "running" ? h : null; });
  check("start → a run, listening at once (no countdown)", !!started);
  const live = await waitFor(async () => (await get("/api/pitch/dashboard")).live === true ? true : null);
  check("the run is a pitch, live", !!live);
  check("JJ stays silent (not connected)", (await get("/health")).jj !== "connected", (await get("/health")).jj);
  check("listening screen with a timer", !!(await waitFor(async () => (await page.textContent("main"))?.includes("Listening"))));
  check("stays on /pitch during the talk", path() === "/pitch", path());
  check("recording on (consent ticked)", !!(await waitFor(() => page.evaluate(() => sessionStorage.getItem("coach.recordConsent") === "yes"))));

  // the camera coach: arms crossed twice, a sway once
  const ep = async (kind, ms) => { sensor.send("behavior", { kind, phase: "start", clientTs: Date.now(), conf: 1 }); await sleep(ms); sensor.send("behavior", { kind, phase: "end", clientTs: Date.now(), conf: 1 }); };
  await ep("arms_crossed", 1500);
  await ep("sway", 1000);
  await ep("arms_crossed", 1200);
  await sleep(1500);
  check("live counters show the body moments", !!(await waitFor(async () => (await page.textContent("main"))?.includes("3 body moments"), 6000)));
  await shot("2-live");

  await page.keyboard.press("d");
  check("D → the dashboard", !!(await waitFor(() => page.getByTestId("pitch-dashboard").isVisible(), 10000)));
  const h = await get("/health");
  check("the run ended (debrief), no Q&A", h.phase === "debrief", h.phase);
  const d = await get("/api/pitch/dashboard");
  check("dashboard data: 2 crossed arms, 1 sway, speech not measured (no listener)",
    d.body.rows.find((r) => r.kind === "arms_crossed")?.count === 2 && d.body.rows.find((r) => r.kind === "sway")?.count === 1 && d.speech.measured === false,
    JSON.stringify(d.body.rows.map((r) => [r.kind, r.count])));
  const text = await page.textContent("[data-testid=pitch-dashboard]");
  check("tiles: duration, pace, fillers, body", ["Duration", "Pace", "Filler words", "Body language", "3moments"].every((t) => text?.replace(/\s+/g, "").includes(t.replace(/\s+/g, ""))));
  check("timeline lanes for both behaviours", (await page.locator("[title^='Crossed arms ·']").count()) === 2 && (await page.locator("[title*='sway' i]").count()) >= 1);
  check("the reporter's analysis arrives (a pitch, not a run over 0 slides)", !!(await waitFor(async () => (await page.textContent("[data-testid=pitch-dashboard]"))?.includes("A pitch:") || false, 40000)));
  check("still on /pitch after the run", path() === "/pitch", path());
  check("JJ still silent after the run (no debrief)", (await get("/health")).jj !== "connected");
  await shot("3-dashboard");

  await page.getByRole("button", { name: "New pitch" }).click();
  check("New pitch → ready again", !!(await waitFor(() => page.getByRole("button", { name: "Start listening" }).isVisible())));
  await page.getByRole("button", { name: "Start listening" }).click();
  check("a second pitch starts (run 2)", !!(await waitFor(async () => (await get("/api/pitch/dashboard")).runId === "run_2")));
  await page.getByRole("button", { name: "Show dashboard" }).click();
  check("…and ends", !!(await waitFor(async () => (await get("/health")).phase === "debrief")));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
} catch (err) {
  check("script", false, String(err?.stack ?? err).slice(0, 400));
} finally {
  sensor.close();
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
