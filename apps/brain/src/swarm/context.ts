/** What every swarm agent gets at install time (swarm/index.ts → install<Agent>(ctx)). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Brain } from "../brain.ts";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import type { MediaStore } from "../media.ts";
import type { RunLog } from "../runlog.ts";
import type { JudgeVoices } from "../voices/judgeVoice.ts";
import type { SwarmBoard } from "./board.ts";
import type { SwarmModels } from "./llm.ts";

export type HttpRoute = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

export interface SwarmContext {
  board: SwarmBoard;
  /** hub (send downlinks, onMic = every 16 kHz mic frame, onConnect), session (get/subscribe/dispatch),
   *  sync (setFeedback / forceVignette), tools (ToolRegistry: JJ's tools), jj (engine), mic, uploads. */
  brain: Brain;
  runLog: RunLog;
  judges: JudgeVoices;
  media: MediaStore;
  clock: Clock;
  log: Logger;
  models: SwarmModels;
  /** Mic RMS (Int16) that counts as speech (JJ_SPEECH_RMS). */
  speechRms: number;
  /** SESSION_DIR root. Store files under sessionFolder() so a full reset erases them. */
  sessionDir: string;
  sessionFolder(): string;
  /** Adds HTTP routes (checked in install order, before the brain's own). */
  http(route: HttpRoute): void;
}

export const sessionFolderOf = (sessionDir: string, sessionId: string) => join(sessionDir, sessionId);
