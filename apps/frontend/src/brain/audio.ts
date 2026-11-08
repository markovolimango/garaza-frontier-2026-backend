/**
 * Browser audio for the brain (Brain integration layer).
 *   AudioOut: /ws/audio frames (4-byte header + 24 kHz Int16) → gapless playback per source,
 *             flushed instantly on audio.stop; reports audio.playback.
 *   MicIn:    getUserMedia → AudioWorklet → 16 kHz Int16 20 ms frames → /ws/mic.
 * Both need a user gesture first (browser autoplay rules): call start() from a click/key.
 */
import { AUDIO_FLAG, CLOSE_CODES, MIC_SAMPLE_RATE, OUT_SAMPLE_RATE, decodeAudioFrame } from "@coach/protocol";

type Playback = { source: number; utteranceId: string; state: "started" | "ended" | "stopped" };

export class AudioOut {
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly nodes = new Map<number, { next: number; playing: AudioBufferSourceNode[]; analyser: AnalyserNode; utteranceId: string | null; endTimer: ReturnType<typeof setTimeout> | null }>();
  private readonly buf = new Uint8Array(256);
  /** Utterance ids by source, from actor.say (the audio stream itself carries only a seq). */
  readonly utterances = new Map<number, string>();

  constructor(private readonly url: string, private readonly onPlayback: (p: Playback) => void) {}

  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    this.ctx = new AudioContext({ sampleRate: OUT_SAMPLE_RATE });
    void this.ctx.resume();
    this.connect();
  }

  close(): void { this.stopped = true; this.ws?.close(); void this.ctx?.close(); this.ctx = null; }

  /** 0..1 RMS level of a source, for the orb. */
  level(source: number): number {
    const n = this.nodes.get(source);
    if (!n) return 0;
    n.analyser.getByteTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) { const x = (v - 128) / 128; s += x * x; }
    return Math.sqrt(s / this.buf.length);
  }

  stop(source: number): void {
    const n = this.nodes.get(source);
    if (!n) return;
    for (const p of n.playing) { try { p.stop(); } catch { /* already stopped */ } }
    n.playing = [];
    n.next = 0;
    if (n.endTimer) clearTimeout(n.endTimer);
    if (n.utteranceId) this.onPlayback({ source, utteranceId: n.utteranceId, state: "stopped" });
    n.utteranceId = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) this.push(new Uint8Array(ev.data)); };
    ws.onclose = (e) => {   // 4001: another tab took the brain; don't fight it for the socket
      if (e.code === CLOSE_CODES.replaced) this.stopped = true;
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    };
    this.ws = ws;
  }

  private node(source: number) {
    let n = this.nodes.get(source);
    if (!n) {
      const analyser = this.ctx!.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(this.ctx!.destination);
      n = { next: 0, playing: [], analyser, utteranceId: null, endTimer: null };
      this.nodes.set(source, n);
    }
    return n;
  }

  private push(bytes: Uint8Array): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const f = decodeAudioFrame(bytes);
    const n = this.node(f.source);
    if (f.flags & AUDIO_FLAG.utteranceStart) {
      n.utteranceId = this.utterances.get(f.source) ?? `${f.source}:${f.seq}`;
      this.onPlayback({ source: f.source, utteranceId: n.utteranceId, state: "started" });
    }
    if (f.pcm.length) {
      const data = new Float32Array(f.pcm.length);
      for (let i = 0; i < f.pcm.length; i++) data[i] = f.pcm[i]! / 32768;
      const ab = ctx.createBuffer(1, data.length, OUT_SAMPLE_RATE);
      ab.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = ab;
      src.connect(n.analyser);
      const at = Math.max(n.next, ctx.currentTime + 0.1);   // 100 ms jitter buffer
      src.start(at);
      n.next = at + ab.duration;
      n.playing.push(src);
      src.onended = () => { n.playing = n.playing.filter((x) => x !== src); };
    }
    if (f.flags & AUDIO_FLAG.utteranceEnd && n.utteranceId) {
      const id = n.utteranceId;
      const wait = Math.max(0, (n.next - ctx.currentTime) * 1000);
      n.endTimer = setTimeout(() => { if (n.utteranceId === id) { this.onPlayback({ source: f.source, utteranceId: id, state: "ended" }); n.utteranceId = null; } }, wait);
    }
  }
}

const WORKLET = `
class MicFrames extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${MIC_SAMPLE_RATE}; this.pos = 0; this.sum = 0; this.cnt = 0; this.buf = new Int16Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767; this.sum = 0; this.cnt = 0;
        if (this.n === 320) { const out = this.buf.slice(); this.port.postMessage(out.buffer, [out.buffer]); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("mic-frames", MicFrames);`;

export class MicIn {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private stopped = false;
  level = 0;

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    const node = new AudioWorkletNode(this.ctx, "mic-frames");
    this.ctx.createMediaStreamSource(this.stream).connect(node);
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const pcm = new Int16Array(e.data);
      let s = 0;
      for (const v of pcm) s += v * v;
      this.level = Math.sqrt(s / pcm.length) / 32768;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    this.connect();
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    ws.onopen = () => ws.send(JSON.stringify({ type: "mic.hello", sampleRate: MIC_SAMPLE_RATE }));
    ws.onclose = (e) => {   // 4001: another tab took the brain; don't fight it for the socket
      if (e.code === CLOSE_CODES.replaced) this.stopped = true;
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    };
    this.ws = ws;
  }
}
