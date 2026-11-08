/**
 * Gapless 24 kHz Int16 PCM player, one queue + AnalyserNode per /ws/audio source id.
 * Emits `onUtteranceStart` / `onUtteranceDrained` per (source, seq) so speakers know when to stop.
 */
export const OUT_SAMPLE_RATE = 24_000;
export const AUDIO_FLAG = { start: 1, end: 2 } as const;

export interface AudioFrame {
  source: number;
  flags: number;
  seq: number;
  pcm: Int16Array;
}

export function decodeAudioFrame(buf: ArrayBuffer): AudioFrame | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  const n = (buf.byteLength - 4) >> 1;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(4 + i * 2, true);
  return { source: dv.getUint8(0), flags: dv.getUint8(1), seq: dv.getUint16(2, true), pcm };
}

interface Utterance {
  pending: number;
  endSeen: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Channel {
  analyser: AnalyserNode;
  gain: GainNode;
  nextTime: number;
  nodes: Set<AudioBufferSourceNode>;
  utterances: Map<number, Utterance>;
  buf: Float32Array<ArrayBuffer>;
}

/** If the end flag never comes, treat an utterance as done this long after its last chunk finished. */
const IDLE_DRAIN_MS = 1200;
const LEAD_S = 0.06;

export class AudioPlayer {
  readonly ctx: AudioContext;
  private channels = new Map<number, Channel>();
  onUtteranceStart: (source: number, seq: number) => void = () => {};
  onUtteranceDrained: (source: number, seq: number) => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ sampleRate: OUT_SAMPLE_RATE });
  }

  resume() {
    return this.ctx.resume();
  }

  private channel(source: number): Channel {
    let ch = this.channels.get(source);
    if (!ch) {
      const gain = this.ctx.createGain();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      gain.connect(analyser).connect(this.ctx.destination);
      ch = { analyser, gain, nextTime: 0, nodes: new Set(), utterances: new Map(), buf: new Float32Array(analyser.fftSize) };
      this.channels.set(source, ch);
    }
    return ch;
  }

  push(frame: AudioFrame) {
    const ch = this.channel(frame.source);
    let u = ch.utterances.get(frame.seq);
    if (!u) {
      u = { pending: 0, endSeen: false, idleTimer: null };
      ch.utterances.set(frame.seq, u);
      this.onUtteranceStart(frame.source, frame.seq);
    }
    if (u.idleTimer) clearTimeout(u.idleTimer);
    if (frame.flags & AUDIO_FLAG.end) u.endSeen = true;

    if (frame.pcm.length > 0) {
      const ab = this.ctx.createBuffer(1, frame.pcm.length, OUT_SAMPLE_RATE);
      const data = ab.getChannelData(0);
      for (let i = 0; i < frame.pcm.length; i++) data[i] = frame.pcm[i]! / 32768;
      const node = this.ctx.createBufferSource();
      node.buffer = ab;
      node.connect(ch.gain);
      const at = Math.max(ch.nextTime, this.ctx.currentTime + LEAD_S);
      node.start(at);
      ch.nextTime = at + ab.duration;
      ch.nodes.add(node);
      u.pending++;
      const utt = u;
      node.onended = () => {
        ch.nodes.delete(node);
        utt.pending--;
        this.maybeDrain(frame.source, frame.seq);
      };
    } else {
      this.maybeDrain(frame.source, frame.seq);
    }
  }

  private maybeDrain(source: number, seq: number) {
    const ch = this.channels.get(source);
    const u = ch?.utterances.get(seq);
    if (!ch || !u || u.pending > 0) return;
    const finish = () => {
      ch.utterances.delete(seq);
      this.onUtteranceDrained(source, seq);
    };
    if (u.endSeen) finish();
    else u.idleTimer = setTimeout(finish, IDLE_DRAIN_MS);
  }

  /** Hard stop (audio.stop): cut playback and drain every open utterance on that source. */
  stop(source: number) {
    const ch = this.channels.get(source);
    if (!ch) return;
    for (const n of ch.nodes) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    ch.nodes.clear();
    ch.nextTime = 0;
    for (const [seq, u] of ch.utterances) {
      if (u.idleTimer) clearTimeout(u.idleTimer);
      ch.utterances.delete(seq);
      this.onUtteranceDrained(source, seq);
    }
  }

  /** Live RMS level 0..1 for a source (0 when silent or unknown). */
  level(source: number): number {
    const ch = this.channels.get(source);
    if (!ch || ch.nodes.size === 0) return 0;
    ch.analyser.getFloatTimeDomainData(ch.buf);
    let s = 0;
    for (let i = 0; i < ch.buf.length; i++) s += ch.buf[i]! * ch.buf[i]!;
    return Math.min(1, Math.sqrt(s / ch.buf.length) * 4);
  }

  close() {
    for (const s of this.channels.keys()) this.stop(s);
    void this.ctx.close();
  }
}
