/**
 * Body agent (stub, to be built): the camera coach's episodes (RunLog) live, and after a run Gemini
 * watches the recording (media.ts) around the episodes → board `video.note` events + a note to JJ.
 */
import type { SwarmContext } from "./context.ts";

export function installBody(ctx: SwarmContext): void {
  ctx.board.status("body", "idle", "camera coach");
}
