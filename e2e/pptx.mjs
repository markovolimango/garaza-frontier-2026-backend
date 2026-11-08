// Browser e2e: a PowerPoint deck. Microsoft PowerPoint on this Mac converts it (it opens in the
// background), the slides reach the brain, and the presenter keeps the .pptx slide durations.
//
// Needs, already running (a fresh session): the brain (JJ_FAKE=1 BRAIN_FRESH=1 SESSION_DIR=data/e2e-sessions
// pnpm dev:brain) and the frontend (pnpm dev:frontend); BRAIN_URL / FRONTEND_URL override the ports.
// Then: node e2e/pptx.mjs
// A fresh session (phase setup): the brain restores its saved session on restart, so start it with
// BRAIN_FRESH=1 and a separate SESSION_DIR (your real session stays untouched), or reset a running one
// with curl -X POST localhost:8787/api/session/reset (this erases the saved session from disk).
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "data", "e2e");
mkdirSync(OUT, { recursive: true });
const FE = process.env.FRONTEND_URL ?? "http://localhost:5174";
const BRAIN = process.env.BRAIN_URL ?? "http://127.0.0.1:8787";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }
if ((await (await fetch(`${BRAIN}/health`)).json()).phase !== "setup") { console.error("The brain must be in a fresh session (phase setup): restart it."); process.exit(2); }

const deck = join(mkdtempSync(join(tmpdir(), "e2e-pptx-")), "acme-pitch.pptx");
execFileSync("python3", [join(REPO, "e2e", "make-pptx.py"), deck, "5,8,12"]);

const op = new WebSocket(`${BRAIN.replace("http", "ws")}/ws/control`);
let snap = null;
op.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "state.snapshot") snap = m.payload; if (m.type === "ping") op.send(JSON.stringify({ v: 1, type: "pong", id: "p", ts: Date.now(), payload: {} })); });
const tool = (name, args = {}) => op.send(JSON.stringify({ v: 1, type: "tool.invoke", id: `t_${Date.now()}`, ts: Date.now(), payload: { tool: name, args } }));
await new Promise((r) => op.on("open", r));
op.send(JSON.stringify({ v: 1, type: "hello", id: "h", ts: Date.now(), payload: { role: "operator", clientId: "e2e-pptx", protocol: 1 } }));

const CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? CHROMES.find((p) => existsSync(p)) ?? CHROMES[1], headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(FE + "/presenter", { waitUntil: "networkidle" });
  check("the deck upload says PDF or PowerPoint", await page.getByText("Upload your deck (PDF or PowerPoint)").isVisible());
  await page.setInputFiles('input[type=file][accept*=".pptx"]', deck);
  const t0 = Date.now();
  const slides = await waitFor(() => snap?.session?.context?.deck?.slides?.length, 120000, 500);
  check("PowerPoint converts the .pptx → the brain has 3 slides", slides === 3, `${slides} slides in ${Math.round((Date.now() - t0) / 1000)} s`);
  const texts = (snap?.session?.context?.deck?.slides ?? []).map((s) => s.text);
  check("slide text survives the conversion", /traction: 40 paying teams/i.test(texts.join(" | ")), texts.join(" | ").slice(0, 120));
  const stored = await waitFor(() => page.evaluate(() => localStorage.getItem("timings:acme-pitch.pdf:3")));
  check("the .pptx slide durations are kept for this deck", stored === "[5,8,12]", String(stored));
  // the run opens the presenter with the deck restored: its timings are the .pptx ones
  check("intro after the upload (JJ's screen)", !!(await waitFor(() => new URL(page.url()).pathname === "/")));
  tool("start_run");
  check("start_run → presenter screen", !!(await waitFor(() => new URL(page.url()).pathname === "/presenter", 15000)));
  const timings = await waitFor(async () => {
    const v = await page.$$eval('ol input[type=number]', (els) => els.map((e) => Number(e.value)));
    return v.length === 3 ? v : null;
  }, 15000);
  check("the presenter's per-slide timings are 5, 8, 12 s", JSON.stringify(timings) === "[5,8,12]", JSON.stringify(timings));
  await page.screenshot({ path: join(OUT, "pptx-presenter.png") });
  const bad = await (await fetch(`${BRAIN}/api/convert/pptx`, { method: "POST", body: "not a pptx" })).json();
  check("a non-.pptx upload is refused with a reason", bad.ok === false && bad.reason === "invalid_args");
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (err) {
  check("no exception", false, String(err));
} finally {
  await browser.close(); op.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
