/**
 * installSwarm(): the agent swarm JJ leads (see board.ts for the roles). Wires the shared board to
 * the stage (`swarm.activity` for the agents panel), persists it per session (swarm.json, erased by a
 * full reset with the session folder), clears it on reset, and installs each agent. Each agent lives
 * in its own module and only talks to the others through the board.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpRoute, SwarmContext } from "./context.ts";
import { AGENT_LABELS, SwarmBoard, type AgentStatus } from "./board.ts";
import { installListener } from "./listener.ts";
import { installDirector } from "./directorAgent.ts";
import { installBody } from "./body.ts";
import { installReporter } from "./reporter.ts";
import { installOrchestrator } from "./orchestrator.ts";

export { SwarmBoard } from "./board.ts";
export type { SwarmContext } from "./context.ts";

export interface Swarm { board: SwarmBoard; routes: HttpRoute[]; save(): void }

export function installSwarm(ctx: Omit<SwarmContext, "http" | "board" | "sessionFolder"> & { board?: SwarmBoard }): Swarm {
  const board = ctx.board ?? new SwarmBoard({ clock: ctx.clock, log: ctx.log });
  const routes: HttpRoute[] = [];
  const sessionFolder = () => join(ctx.sessionDir, ctx.brain.session.get().sessionId);
  const full: SwarmContext = { ...ctx, board, sessionFolder, http: (r) => { routes.push(r); } };
  const { hub, session } = ctx.brain;

  // ---- agents panel: swarm.activity to the stage and operator (coalesced) ----
  const payload = (all: AgentStatus[]) => ({ agents: all.map((a) => ({ ...a, label: AGENT_LABELS[a.id] })) });
  let pending: unknown = null;
  board.onStatus((all) => {
    if (pending) return;
    pending = ctx.clock.setTimeout(() => { pending = null; hub.broadcast(["stage", "operator"], { type: "swarm.activity", payload: payload(board.allStatuses()) }); void all; }, 150);
  });
  hub.onConnect("stage", () => hub.send("stage", { type: "swarm.activity", payload: payload(board.allStatuses()) }));
  hub.onConnect("operator", () => hub.send("operator", { type: "swarm.activity", payload: payload(board.allStatuses()) }));

  // ---- persistence: SESSION_DIR/<sessionId>/swarm.json ----
  const file = () => join(sessionFolder(), "swarm.json");
  try { if (existsSync(file())) board.restore(JSON.parse(readFileSync(file(), "utf8"))); }
  catch (err) { ctx.log("warn", "swarm.restore_failed", { err: String(err) }); }
  let saveTimer: unknown = null;
  const save = () => {
    if (saveTimer) { ctx.clock.clearTimeout(saveTimer); saveTimer = null; }
    try {
      mkdirSync(sessionFolder(), { recursive: true });
      writeFileSync(`${file()}.tmp`, JSON.stringify(board.toJSON()));
      renameSync(`${file()}.tmp`, file());
    } catch (err) { ctx.log("error", "swarm.save_failed", { err: String(err) }); }
  };
  board.onChanged(() => { if (!saveTimer) saveTimer = ctx.clock.setTimeout(() => { saveTimer = null; save(); }, 500); });
  session.subscribe((_s, cause) => { if (!Array.isArray(cause) && cause.type === "reset") board.clear(); });

  // ---- agents ----
  installOrchestrator(full);
  installListener(full);
  installDirector(full);
  installBody(full);
  installReporter(full);
  ctx.log("info", "swarm.installed", { models: { ...ctx.models, apiKey: ctx.models.apiKey ? "set" : null } });
  return { board, routes, save };
}
