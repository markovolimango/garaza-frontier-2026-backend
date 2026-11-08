// Browser e2e: the Lovable frontend (BrainSource) ⇄ a real brain, in headless Chrome.
//
// Needs, already running:
//   brain:     JJ_FAKE=1 pnpm dev:brain                       (fresh session, port 8787)
//   frontend:  pnpm dev:frontend                               (VITE_SIGNAL_SOURCE=brain, port 5174)
// Then:        pnpm e2e:browser   (Chrome on macOS or /usr/bin/google-chrome; CHROME=/path/to/chrome overrides)
// Screenshots: data/e2e/shot-*.png
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "data", "e2e");
mkdirSync(OUT, { recursive: true });
const FE = process.env.FRONTEND_URL ?? "http://localhost:5174";
const BRAIN = process.env.BRAIN_URL ?? "http://127.0.0.1:8787";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }
const health = async () => (await fetch(`${BRAIN}/health`)).json();
if ((await health()).phase !== "setup") { console.error("The brain must be in a fresh session (phase setup): restart it."); process.exit(2); }

// operator socket: watches state.snapshot, sends overrides and tools
const op = new WebSocket(`${BRAIN.replace("http", "ws")}/ws/control`);
let snap = null; const replies = new Map(); let n = 0;
const env = (type, payload) => ({ v: 1, type, id: `op_${++n}`, ts: Date.now(), payload });
op.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "state.snapshot") snap = m.payload; if (m.type === "ping") op.send(JSON.stringify(env("pong", {}))); if (m.replyTo) replies.get(m.replyTo)?.(m); });
await new Promise((r) => op.on("open", r));
op.send(JSON.stringify(env("hello", { role: "operator", clientId: "e2e", protocol: 1 })));
const opSend = (type, payload) => { const e = env(type, payload); op.send(JSON.stringify(e)); return new Promise((r) => { replies.set(e.id, r); setTimeout(() => r(null), 5000); }); };

const CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? CHROMES.find((p) => existsSync(p)) ?? CHROMES[1], headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],   // WebGL for the 3D judges
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ["microphone"] });

// Vite optimizes dependencies on the first visit and then reloads the page, which drops the audio
// and mic unlocked by the first click. Load the app's modules on a throwaway page first.
{
  const warm = await ctx.newPage();
  await warm.goto(FE + "/", { waitUntil: "load" });
  await warm.evaluate(() => Promise.all(["/src/components/JudgesStage.tsx", "/src/routes/presenter.tsx"]
    .map((m) => import(/* @vite-ignore */ m).catch(() => null))));
  await sleep(3000);
  await warm.close();
  await waitFor(async () => !(await health()).connected.includes("stage"), 5000);
}
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
const shot = (name) => page.screenshot({ path: join(OUT, `shot-${name}.png`) });
const path = () => new URL(page.url()).pathname;

try {
  await page.goto(FE + "/", { waitUntil: "networkidle" });
  check("SSR + hydrate: page loads", (await page.title()).length > 0, await page.title());
  check("stage connects to the brain", !!(await waitFor(async () => (await health()).connected.includes("stage"))));
  check("view setup → presenter screen", !!(await waitFor(() => path() === "/presenter")), path());
  await shot("1-setup");

  await page.mouse.click(960, 900);   // first gesture: unlock audio + mic
  check("mic streams to /ws/mic after the first click", !!(await waitFor(async () => (await health()).mic)));

  await page.setInputFiles('input[type=file][accept="application/pdf"]', join(REPO, "fixtures", "decks", "sample-3-slides.pdf"));
  check("PDF upload → brain has a 3-slide deck", !!(await waitFor(() => snap?.session?.context?.deck?.slides?.length === 3, 15000)), snap?.session?.context?.deck?.name);
  check("session.start → intro, JJ connected", !!(await waitFor(async () => { const h = await health(); return h.phase === "intro" && h.jj === "connected"; })));
  check("view jj → JJ screen (/)", !!(await waitFor(() => path() === "/")), path());
  await shot("2-jj");
  const slideText = snap?.session?.context?.deck?.slides?.map((s) => s.text).join(" | ");
  check("slide text extracted by pdf.js", /Traction/.test(slideText ?? ""), slideText);
  const img = await fetch(BRAIN + snap.session.context.deck.slides[0].url);
  check("slide PNG served by the brain", img.status === 200 && img.headers.get("content-type") === "image/png");

  await page.keyboard.press("2");     // JJ → Presenter = start the run
  check("key 2 on JJ screen → start_run", !!(await waitFor(() => snap?.session?.phase === "running")), snap?.session?.run?.runId);
  check("countdown overlay shows", !!(await waitFor(async () => (await page.locator("text=/^[321]$/").count()) > 0, 3000)));
  await shot("3-countdown");
  check("presentation starts after the countdown", !!(await waitFor(() => snap?.session?.run?.phase === "presentation", 6000)));
  check("presenter screen with the PDF re-opened (1 / 3)", !!(await waitFor(async () => path() === "/presenter" && (await page.locator("text=/1 \\/ 3/").count()) > 0)), path());

  await page.keyboard.press("ArrowRight");
  check("→ arrow reaches the brain (slideIndex 1)", !!(await waitFor(() => snap?.session?.run?.slideIndex === 1)));
  const r = await opSend("tool.invoke", { tool: "go_to_slide", args: { index: 2 } });
  check("operator go_to_slide 2 → presenter shows 3 / 3", r?.payload?.ok && !!(await waitFor(async () => (await page.locator("text=/3 \\/ 3/").count()) > 0)));

  op.send(JSON.stringify(env("operator.override", { action: "vignette", kind: "warn", intensity: 0.65, holdMs: 4000 })));   // no reply for overrides
  const red = await waitFor(async () => { const o = await page.locator(".vignette-red").evaluate((el) => Number(getComputedStyle(el).opacity)); return o > 0.1 ? o : false; });
  check("feedback.set warn → red vignette on the presenter", !!red, `opacity ${red}`);
  await shot("4-vignette");

  await page.keyboard.down("j");
  check("hold J → run paused (push-to-talk)", !!(await waitFor(() => snap?.session?.run?.paused === true)));
  check("'JJ is listening' chip shows", !!(await waitFor(async () => (await page.locator("text=JJ is listening").count()) > 0)));
  await shot("5-woken");
  await page.keyboard.up("j");
  await page.keyboard.press("Escape");
  check("Esc → resume_run → run continues", !!(await waitFor(() => snap?.session?.run?.paused === false)));
  check("presenter timer runs with the presentation", !!(await waitFor(async () => !/elapsed 0:00/.test(await page.innerText("body")), 4000)));

  await page.keyboard.press("3");     // Presenter → Judges = slides done
  check("key 3 → presentation.done → Q&A room (/judges)", !!(await waitFor(async () => snap?.session?.run?.phase === "qa" && path() === "/judges")), path());
  await page.keyboard.press("4");     // Judges → Report = end run (pressed right after the view changed: race check)
  check("key 4 → end_run → report (/report)", !!(await waitFor(async () => snap?.session?.phase === "debrief" && path() === "/report")), path());
  check("report screen shows run 1 (baseline)", !!(await waitFor(async () => (await page.locator("text=Baseline run · no feedback").count()) > 0, 6000)));
  await shot("6-report");

  await page.keyboard.press("3");     // meaningless move: snaps back with a hint
  check("key 3 on report → hint toast, stays on /report", !!(await waitFor(async () => (await page.locator("text=/Start a run first/").count()) > 0)) && !!(await waitFor(() => path() === "/report", 3000)));
  await page.keyboard.press("1");     // JJ's screen is allowed after a run
  await sleep(1600);
  check("key 1 on report → JJ screen stays (debrief)", path() === "/" && snap?.session?.phase === "debrief", path());
  check("next-run buttons after the run", (await page.locator("text=With live feedback").count()) > 0);
  await page.keyboard.press("4");     // back to the report
  await waitFor(() => path() === "/report", 3000);

  const s = await opSend("tool.invoke", { tool: "set_audience", args: { count: 30 } });
  check("scene tool → stage acks scene.apply → ok", s?.payload?.ok === true, JSON.stringify(s?.payload));

  await page.reload({ waitUntil: "networkidle" });
  check("reload restores the brain's view (/report)", !!(await waitFor(() => path() === "/report")), path());

  // second run, straight to the judges: the 3D scene runs on BrainSource's connection (bus judgeCommand)
  await page.mouse.click(960, 540);   // unlock audio again after the reload
  await page.getByRole("button", { name: "With live feedback", exact: true }).click();
  check("run 2 'With live feedback' → training/strong presentation", !!(await waitFor(() => snap?.session?.run?.index === 2 && snap?.session?.run?.phase === "presentation" && snap?.session?.run?.feedbackLevel === "strong", 10000)), `${snap?.session?.run?.mode}/${snap?.session?.run?.feedbackLevel}`);
  await page.keyboard.press("3");
  check("run 2 → Q&A room (/judges)", !!(await waitFor(async () => snap?.session?.run?.phase === "qa" && path() === "/judges")), path());
  check("judges screen renders the 3D scene", !!(await waitFor(async () => (await page.locator("canvas").count()) > 0, 20000)));
  // The director asks by itself, from the deck: run 2 opens with judge_4 (neutral) on the traction slide.
  check("director: a judge asks about the deck by itself", !!(await waitFor(async () => (await page.locator("text=/still active after the first month/").count()) > 0, 20000)));
  await shot("7-judges");
  check("judges screen keeps the single stage connection", (await health()).connected.includes("stage") && (await page.locator("text=Opened in another tab").count()) === 0);
  await page.getByText("Report →").click();
  check("report screen shows run 2 (training, strong)", !!(await waitFor(async () => path() === "/report" && (await page.locator("text=Training run · strong feedback").count()) > 0, 8000)), path());
  check("report: time per slide from the brain", (await page.locator("text=Time per slide").count()) > 0 && (await page.locator("text=Slide 1").count()) > 0);
  await shot("8-report");
} catch (e) {
  check("script", false, String(e));
} finally {
  const relevant = errors.filter((e) => !/favicon|DevTools|Download the React DevTools/.test(e));
  check("no page errors / console errors", relevant.length === 0, relevant.slice(0, 5).join(" || "));
  await browser.close(); op.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
