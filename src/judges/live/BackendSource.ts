/**
 * Browser-only client for the brain (../backend, protocol v1).
 *   /ws/control: JSON envelopes {v,type,id,ts,replyTo?,payload}. Sends hello as role "stage",
 *                answers ping with pong, acks every scene.apply, reports audio.playback.
 *   /ws/audio:   binary frames, byte0 source (1..5 = judge_N), byte1 flags (1 start, 2 end),
 *                bytes2-3 seq uint16 LE, then Int16 LE PCM @ 24 kHz.
 */
import { AudioPlayer, decodeAudioFrame } from "./AudioPlayer";

const PROTOCOL = 1;

export type ActorId = "judge_1" | "judge_2" | "judge_3" | "judge_4" | "judge_5" | "jj" | "audience";
export type BackendGesture = "idle" | "nod" | "note" | "lean_in" | "lean_back" | "cross_arms" | "check_watch" | "talk" | "shift";

export interface ActorSay {
  actorId: ActorId;
  utteranceId: string;
  source: number;
  text: string;
}
export interface ActorGesture {
  actorId: ActorId;
  gesture: BackendGesture;
  durationMs?: number;
}

export type BackendStatus = "connecting" | "open" | "closed" | "replaced";

interface Envelope {
  v: number;
  type: string;
  id: string;
  ts: number;
  replyTo?: string;
  payload: { batchId?: string; version?: number; source?: number; utteranceId?: string };
}

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export interface BackendHandlers {
  onSay?(p: ActorSay): void;
  onGesture?(p: ActorGesture): void;
  onAudioStop?(source: number, utteranceId?: string): void;
  onStatus?(s: BackendStatus): void;
}

export class BackendSource {
  private control: WebSocket | null = null;
  private audio: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly clientId = `stage-judges-${rid()}`;
  status: BackendStatus = "connecting";

  constructor(
    readonly baseUrl: string,
    /** Null until the user enables audio; frames are dropped until then. */
    private getPlayer: () => AudioPlayer | null,
    private h: BackendHandlers,
  ) {}

  connect() {
    this.closed = false;
    this.open();
    return this;
  }

  send(type: string, payload: object, replyTo?: string) {
    if (this.control?.readyState !== WebSocket.OPEN) return;
    const env = { v: PROTOCOL, type, id: rid(), ts: Date.now(), ...(replyTo ? { replyTo } : {}), payload };
    this.control.send(JSON.stringify(env));
  }

  private setStatus(s: BackendStatus) {
    this.status = s;
    this.h.onStatus?.(s);
  }

  private open() {
    this.setStatus("connecting");
    const control = new WebSocket(`${this.baseUrl}/ws/control`);
    this.control = control;
    control.onopen = () => {
      this.retry = 0;
      this.send("hello", { role: "stage", clientId: this.clientId, protocol: PROTOCOL });
      this.setStatus("open");
      this.openAudio();
    };
    control.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let env: Envelope;
      try {
        env = JSON.parse(e.data) as Envelope;
      } catch {
        return;
      }
      this.handle(env);
    };
    control.onclose = (e) => {
      if (this.control !== control) return;
      this.audio?.close();
      this.audio = null;
      if (e.code === 4001) return this.setStatus("replaced");
      this.setStatus("closed");
      if (!this.closed) this.timer = setTimeout(() => this.open(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }

  private openAudio() {
    const audio = new WebSocket(`${this.baseUrl}/ws/audio`);
    audio.binaryType = "arraybuffer";
    audio.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const f = decodeAudioFrame(e.data);
      if (f) this.getPlayer()?.push(f);
    };
    this.audio = audio;
  }

  private handle(env: Envelope) {
    const p = env.payload;
    switch (env.type) {
      case "ping":
        this.send("pong", {});
        break;
      case "scene.apply":
        // No room to apply ops to in the judges view; ack so the brain commits instead of rolling back.
        this.send("ack", { batchId: p.batchId, version: p.version, ok: true });
        break;
      case "actor.say":
        this.h.onSay?.(p as unknown as ActorSay);
        break;
      case "actor.gesture":
        this.h.onGesture?.(p as unknown as ActorGesture);
        break;
      case "audio.stop":
        this.getPlayer()?.stop(p.source ?? -1);
        this.h.onAudioStop?.(p.source ?? -1, p.utteranceId);
        break;
    }
  }

  playback(source: number, utteranceId: string, state: "started" | "ended" | "stopped") {
    this.send("audio.playback", { source, utteranceId, state });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.control?.close(1000);
    this.audio?.close(1000);
    this.control = this.audio = null;
  }
}
