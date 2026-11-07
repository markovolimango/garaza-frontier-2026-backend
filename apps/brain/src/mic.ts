/**
 * MicRouter (spec: "Speech pipeline"): one mic stream, two consumers. The brain decides,
 * so the browser never needs to know.
 *
 * | setup                               | nothing                       |
 * | intro, calibrating, debrief, final  | jj (always listening)         |
 * | running: countdown                  | nothing (STT stream opening)  |
 * | running: presentation or qa         | stt                           |
 * | running, woken                      | jj and stt                    |
 */
import type { SessionState } from "@coach/protocol";
import type { Clock } from "./clock.ts";

export type MicSink = "stt" | "jj";

export interface MicRouterOptions {
  clock: Clock;
  session: { get(): Readonly<SessionState> };
  jj: { acceptMic(pcm16k: Int16Array): void };
  /** The current run's STT stream, if any (speech lane). */
  stt?: () => { write(pcm16k: Int16Array): void } | null;
  bufferMs?: number;   // 3000
}

export function sinksFor(s: Readonly<SessionState>): MicSink[] {
  switch (s.phase) {
    case "setup": return [];
    case "intro": case "calibrating": case "debrief": case "final": return ["jj"];
    case "running": {
      const p = s.run?.phase;
      if (p === "presentation" || p === "qa") return s.wake.active ? ["jj", "stt"] : ["stt"];
      if (p === "ended" || p === "aborted") return ["jj"];
      return [];
    }
  }
}

export class MicRouter {
  private frames: { t: number; pcm: Int16Array }[] = [];
  framesIn = 0;

  constructor(private readonly o: MicRouterOptions) {}

  sinks(): MicSink[] { return sinksFor(this.o.session.get()); }

  /** Called per 20 ms frame from /ws/mic. */
  write(pcm16k: Int16Array): void {
    const t = this.o.clock.now();
    const pcm = pcm16k.slice();          // the socket buffer is reused
    this.framesIn++;
    this.frames.push({ t, pcm });
    const keep = t - (this.o.bufferMs ?? 3000);
    while (this.frames.length && this.frames[0]!.t < keep) this.frames.shift();
    const sinks = this.sinks();
    if (sinks.includes("stt")) this.o.stt?.()?.write(pcm);
    if (sinks.includes("jj")) this.o.jj.acceptMic(pcm);
  }

  /** Ring buffer of the last 3 s, for the words right after "Hey JJ". */
  replaySince(t: number): Int16Array {
    const picked = this.frames.filter((f) => f.t >= t);
    const out = new Int16Array(picked.reduce((n, f) => n + f.pcm.length, 0));
    let o = 0;
    for (const f of picked) { out.set(f.pcm, o); o += f.pcm.length; }
    return out;
  }
}
