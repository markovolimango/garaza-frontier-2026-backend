/**
 * JJ playground: talk to the real JJ engine (full duplex, real Gemini Live) from a browser,
 * over a simulated session, and watch every tool call, transcript, note and downlink.
 *
 *   pnpm jj:playground            # needs GEMINI_API_KEY (in .env or the environment)
 *   pnpm jj:playground --fake     # no key: FakeVoiceAgent, to check the page and wiring
 *
 * Open http://localhost:8790 in Chrome, use headphones, press "Enable audio".
 * Every event is also appended to data/jj-playground/<timestamp>.jsonl.
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientRole } from "@coach/protocol";
import { createJJ, readJJConfig, FakeVoiceAgent, type JJConfig } from "../index.ts";
import type { HubPort, JJClock, JJDownlink, Logger } from "../ports.ts";
import type { VoiceAgent } from "../voice-agent.ts";
import { SimContext, SimMic, SimReports, SimSession } from "./sim.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const PORT = Number(process.env.JJ_PLAYGROUND_PORT ?? 8790);
const FAKE = process.argv.includes("--fake");

if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));

const config: JJConfig = FAKE
  ? readJJConfig({ ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY || "fake" })
  : (() => {
      try { return readJJConfig(); } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        console.error("\nSet GEMINI_API_KEY in .env (see .env.example), or run with --fake.");
        process.exit(1);
      }
    })();

// ---------------- event log ----------------
const logDir = join(REPO, "data", "jj-playground");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}${FAKE ? "-fake" : ""}.jsonl`);
let browser: WebSocket | null = null;

function emit(kind: string, data: Record<string, unknown>): void {
  const ev = { t: "event", at: Date.now(), kind, ...data };
  appendFileSync(logFile, JSON.stringify(ev) + "\n");
  if (browser?.readyState === 1) browser.send(JSON.stringify(ev));
}

const log: Logger = (level, msg, data) => {
  if (level !== "debug") console.log(`[${level}] ${msg}`, data ? JSON.stringify(data) : "");
  emit("log", { level, msg, ...(data ? { data } : {}) });
};

// ---------------- brain pieces ----------------
const clock: JJClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
const reports = new SimReports();
const session = new SimSession({ clock, onRunFinished: (s) => reports.produce(s) });
const context = new SimContext(session);
const mic = new SimMic(session, clock);

const hub: HubPort = {
  send(role: ClientRole, msg: JJDownlink) {
    if (role !== "stage") return true;
    emit("down", { type: msg.type, payload: msg.payload });
    return true;
  },
  broadcast(roles, msg) { if (roles.includes("stage")) hub.send("stage", msg); },
  sendAudio(source, flags, seq, pcm) {
    if (flags) emit("audio", { source, flags, seq, samples: pcm.length });
    if (browser?.readyState !== 1) return;
    const buf = Buffer.alloc(4 + pcm.byteLength);
    buf[0] = source; buf[1] = flags; buf.writeUInt16LE(seq, 2);
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 4);
    browser.send(buf);
  },
};

const fakeAgent = FAKE ? new FakeVoiceAgent() : null;
const { engine, tools, agent: realAgent } = createJJ({ config, session, context, reports, hub, mic, clock, log, ...(fakeAgent ? { agent: fakeAgent } : {}) });
const agent: VoiceAgent = realAgent;

// Make everything sent to JJ visible.
const sendText = agent.sendText.bind(agent);
agent.sendText = (text, opts) => { emit("to_jj", { text, turnComplete: opts.turnComplete }); sendText(text, opts); };
let framesToJJ = 0;
const sendAudio = agent.sendAudio.bind(agent);
agent.sendAudio = (pcm) => { framesToJJ++; sendAudio(pcm); };

tools.onInvoked((i) => emit("tool", { caller: i.caller, name: i.name, args: i.args, result: i.result, durationMs: i.durationMs }));
agent.onTranscript((t) => emit("transcript", { who: t.who, text: t.text, final: t.final }));

function pushState(): void {
  if (browser?.readyState !== 1) return;
  browser.send(JSON.stringify({ t: "state", session: session.get(), jj: engine.status(), sinks: mic.sinks(), framesToJJ, fake: FAKE, model: config.GEMINI_LIVE_MODEL, voice: config.JJ_VOICE }));
}
session.subscribe(() => pushState());
setInterval(pushState, 500);

engine.start();

// ---------------- browser commands ----------------
type Cmd =
  | { t: "action"; action: { type: string; [k: string]: unknown } }
  | { t: "tool"; name: string; args: unknown }
  | { t: "ptt" } | { t: "wake_phrase" } | { t: "operator_wake" }
  | { t: "reconnect" }
  | { t: "note"; text: string; turnComplete: boolean }
  | { t: "fake"; what: "speak" | "finish" | "barge" | "drop" | "tool"; name?: string; args?: unknown };

async function handle(cmd: Cmd): Promise<void> {
  switch (cmd.t) {
    case "action": {
      const r = session.dispatch(cmd.action);
      emit("action", { action: cmd.action, result: r });
      break;
    }
    case "tool": await tools.invoke(cmd.name, cmd.args, "operator"); break;
    case "ptt": emit("action", { action: { type: "wake", via: "ptt" }, result: session.dispatch({ type: "wake", via: "ptt" }) }); break;
    case "operator_wake": emit("action", { action: { type: "wake", via: "operator" }, result: session.dispatch({ type: "wake", via: "operator" }) }); break;
    case "wake_phrase":
      // Browser speech recognition reports the phrase after it was said; assume it started ~1.2 s ago.
      engine.noteWakePhrase(Date.now() - 1200);
      emit("action", { action: { type: "wake", via: "phrase" }, result: session.dispatch({ type: "wake", via: "phrase" }) });
      break;
    case "reconnect": await engine.reconnect(); break;
    case "note": agent.sendText(cmd.text, { turnComplete: cmd.turnComplete }); break;
    case "fake":
      if (!fakeAgent) return;
      if (cmd.what === "speak") { for (let i = 0; i < 10; i++) fakeAgent.speak(2400); }
      if (cmd.what === "finish") fakeAgent.finishTurn();
      if (cmd.what === "barge") fakeAgent.bargeIn();
      if (cmd.what === "drop") fakeAgent.drop();
      if (cmd.what === "tool" && cmd.name) await fakeAgent.callTool(cmd.name, cmd.args ?? {});
      break;
  }
  pushState();
}

// ---------------- http + ws ----------------
const page = () => readFileSync(join(HERE, "index.html"), "utf8");
const server = createServer((req, res) => {
  if (req.url === "/" || req.url?.startsWith("/?")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page()); return; }
  if (req.url === "/api/tools") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(tools.catalogue())); return; }
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, jj: engine.status() })); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  browser?.close(4001, "replaced");
  browser = ws;
  log("info", "playground.browser_connected");
  pushState();
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const b = data as Buffer;
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
      if (mic.write(pcm)) engine.acceptMic(pcm);
      return;
    }
    try { void handle(JSON.parse(String(data)) as Cmd).catch((e) => log("error", "playground.cmd_failed", { err: String(e) })); }
    catch (e) { log("warn", "playground.bad_cmd", { err: String(e) }); }
  });
  ws.on("close", () => { if (browser === ws) browser = null; });
});

server.listen(PORT, () => {
  console.log(`\nJJ playground ${FAKE ? "(FAKE agent) " : ""}on http://localhost:${PORT}`);
  console.log(`model ${config.GEMINI_LIVE_MODEL}, voice ${config.JJ_VOICE || "(default)"}`);
  console.log(`event log: ${logFile}\n`);
});

process.on("SIGINT", () => { void engine.stop().finally(() => process.exit(0)); });
