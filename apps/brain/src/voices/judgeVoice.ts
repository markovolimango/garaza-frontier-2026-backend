/**
 * Judge voices: ElevenLabs streaming TTS → /ws/audio, one judge at a time.
 *
 * speakJudge("judge_2", text) queues an utterance. When its turn comes:
 *   actor.gesture talk → actor.say {utteranceId, source: judgeSource(n)} →
 *   PCM chunks on /ws/audio (first frame utterance-start, then plain frames, then an empty
 *   utterance-end frame — same framing as JJ) → wait for the stage's audio.playback
 *   ended/stopped (or a timeout from the audio length) → actor.gesture idle.
 *
 * Without ELEVENLABS_API_KEY the audio is skipped (logged); say + gestures still go out.
 */
import { AUDIO_FLAG, OUT_SAMPLE_RATE, judgeSource, type DownlinkMessage, type JudgeId, type Uplink } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";

/** ElevenLabs premade voices: Rachel, Adam, Antoni, Sarah. */
export const DEFAULT_JUDGE_VOICE_IDS = ["21m00Tcm4TlvDq8ikWAM", "pNInz6obpgDQGcFmaJgB", "ErXwobaYiN019PkySvjV", "EXAVITQu4vr4xnSDxMaL"];
export const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const PLAYBACK_GRACE_MS = 1500;

export interface JudgeVoiceHub {
  send(role: "stage", msg: DownlinkMessage): boolean;
  sendAudio(source: number, flags: number, seq: number, pcm24k: Int16Array): void;
  on(type: "audio.playback", handler: (msg: Uplink<"audio.playback">) => void): void;
}

export interface JudgeVoicesOptions {
  hub: JudgeVoiceHub;
  clock: Clock;
  log?: Logger;
  apiKey?: string | undefined;
  /** voiceIds[0] is judge_1, … Missing entries fall back to DEFAULT_JUDGE_VOICE_IDS. */
  voiceIds?: string[];
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface JudgeUtterance { utteranceId: string; done: Promise<void> }

export class JudgeVoices {
  private queue: Promise<void> = Promise.resolve();
  private count = 0;
  private seq = 0;
  private readonly playbackWaiters = new Map<string, () => void>();
  private readonly log: Logger;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: JudgeVoicesOptions) {
    this.log = o.log ?? (() => {});
    this.fetch = o.fetch ?? globalThis.fetch;
    o.hub.on("audio.playback", (m) => {
      if (m.payload.state === "started") return;
      this.playbackWaiters.get(m.payload.utteranceId)?.();
    });
    if (!o.apiKey) this.log("warn", "judges.no_elevenlabs_key", { hint: "set ELEVENLABS_API_KEY for judge audio" });
  }

  voiceFor(actorId: JudgeId): string {
    const i = judgeIndex(actorId) - 1;
    return this.o.voiceIds?.[i] || DEFAULT_JUDGE_VOICE_IDS[i % DEFAULT_JUDGE_VOICE_IDS.length]!;
  }

  /** Queue a line for a judge. Resolves `done` when it has finished (never rejects). */
  speakJudge(actorId: JudgeId, text: string): JudgeUtterance {
    const utteranceId = `${actorId}_u${++this.count}`;
    const done = this.queue.then(() => this.run(actorId, utteranceId, text)).catch((err) => {
      this.log("error", "judges.say_failed", { actorId, utteranceId, err: String(err) });
    });
    this.queue = done;
    return { utteranceId, done };
  }

  private async run(actorId: JudgeId, utteranceId: string, text: string): Promise<void> {
    const source = judgeSource(judgeIndex(actorId));
    const hub = this.o.hub;
    hub.send("stage", { type: "actor.gesture", payload: { actorId, gesture: "talk" } });
    hub.send("stage", { type: "actor.say", payload: { actorId, utteranceId, source, text } });
    try {
      if (!this.o.apiKey) { this.log("info", "judges.audio_skipped", { actorId, utteranceId, reason: "no ELEVENLABS_API_KEY" }); return; }
      const played = await this.stream(actorId, utteranceId, source, text);
      if (played) await this.waitForPlayback(utteranceId, played);
    } finally {
      hub.send("stage", { type: "actor.gesture", payload: { actorId, gesture: "idle" } });
    }
  }

  /** Streams TTS to /ws/audio. Returns playback info when any audio was sent. */
  private async stream(actorId: JudgeId, utteranceId: string, source: number, text: string): Promise<{ startedAt: number; samples: number } | null> {
    const voiceId = this.voiceFor(actorId);
    const url = `${this.o.baseUrl ?? "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${OUT_SAMPLE_RATE}`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.o.apiKey!, "content-type": "application/json", accept: "audio/pcm" },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      this.log("error", "judges.tts_failed", { actorId, utteranceId, status: res.status, detail: detail.slice(0, 300) });
      return null;
    }

    const seq = this.seq = (this.seq + 1) & 0xffff;
    let started = false;
    let startedAt = 0;
    let samples = 0;
    let carry: number | null = null;   // odd trailing byte from the previous chunk
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        const pcm = toPcm(value, carry);
        carry = pcm.carry;
        if (!pcm.samples.length) continue;
        if (!started) { started = true; startedAt = this.o.clock.now(); }
        this.o.hub.sendAudio(source, samples === 0 ? AUDIO_FLAG.utteranceStart : 0, seq, pcm.samples);
        samples += pcm.samples.length;
      }
    } finally {
      if (started) this.o.hub.sendAudio(source, AUDIO_FLAG.utteranceEnd, seq, new Int16Array(0));
    }
    this.log("info", "judges.spoke", { actorId, utteranceId, voiceId, ms: Math.round((samples / OUT_SAMPLE_RATE) * 1000) });
    return started ? { startedAt, samples } : null;
  }

  /** Waits for the stage's audio.playback ended/stopped, or until the audio must be over. */
  private waitForPlayback(utteranceId: string, p: { startedAt: number; samples: number }): Promise<void> {
    const durationMs = (p.samples / OUT_SAMPLE_RATE) * 1000;
    const remaining = Math.max(0, p.startedAt + durationMs - this.o.clock.now()) + PLAYBACK_GRACE_MS;
    return new Promise((resolve) => {
      const finish = () => { this.o.clock.clearTimeout(timer); this.playbackWaiters.delete(utteranceId); resolve(); };
      const timer = this.o.clock.setTimeout(finish, remaining);
      this.playbackWaiters.set(utteranceId, finish);
    });
  }
}

export const judgeIndex = (actorId: JudgeId): number => Number(actorId.slice("judge_".length));

/** Little-endian Int16 from a byte chunk, carrying an odd trailing byte to the next chunk. */
function toPcm(chunk: Uint8Array, carry: number | null): { samples: Int16Array; carry: number | null } {
  let bytes = chunk;
  if (carry !== null) { bytes = new Uint8Array(chunk.byteLength + 1); bytes[0] = carry; bytes.set(chunk, 1); }
  const n = bytes.byteLength >> 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, true);
  return { samples, carry: bytes.byteLength & 1 ? bytes[bytes.byteLength - 1]! : null };
}

// ---------------- debug HTTP ----------------

/** POST /debug/judge-say {judge: 1-4, text}. Pass as (part of) createBrain's `http` option. */
export function judgeVoicesHttp(voices: JudgeVoices) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/debug/judge-say") return false;
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST") { json(405, { ok: false, reason: "method_not_allowed" }); return true; }
    let body: { judge?: unknown; text?: unknown };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch { json(400, { ok: false, reason: "invalid_json" }); return true; }
    const judge = Number(body.judge);
    if (!Number.isInteger(judge) || judge < 1 || judge > 4 || typeof body.text !== "string" || !body.text.trim()) {
      json(400, { ok: false, reason: "invalid_args", hint: "body: {judge: 1-4, text: string}" });
      return true;
    }
    const actorId = `judge_${judge}` as JudgeId;
    const { utteranceId } = voices.speakJudge(actorId, body.text.trim());
    json(202, { ok: true, actorId, utteranceId, voiceId: voices.voiceFor(actorId) });
    return true;
  };
}
