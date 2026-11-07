/**
 * /ws/audio framing (spec: Transport). Byte 0 = source (0 JJ, 1–5 judge index, 9 system
 * sound), byte 1 = flags (bit 0 utterance start, bit 1 utterance end), bytes 2–3 = utterance
 * sequence number (uint16 LE), then mono Int16 LE PCM at 24 kHz. Browser- and Node-safe.
 */
export const AUDIO_SOURCE = { jj: 0, system: 9 } as const;
export const AUDIO_FLAG = { utteranceStart: 1, utteranceEnd: 2 } as const;
export const AUDIO_HEADER_BYTES = 4;
export const MIC_SAMPLE_RATE = 16_000;
export const OUT_SAMPLE_RATE = 24_000;
/** 20 ms of 16 kHz mono Int16. */
export const MIC_FRAME_BYTES = 640;

export const judgeSource = (judgeIndex: number): number => judgeIndex;   // judge_N uses source N

export interface AudioFrame { source: number; flags: number; seq: number; pcm: Int16Array }

export function encodeAudioFrame(source: number, flags: number, seq: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, source);
  dv.setUint8(1, flags);
  dv.setUint16(2, seq & 0xffff, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(AUDIO_HEADER_BYTES + i * 2, pcm[i]!, true);
  return out;
}

export function decodeAudioFrame(bytes: Uint8Array): AudioFrame {
  if (bytes.byteLength < AUDIO_HEADER_BYTES) throw new Error("audio frame shorter than its header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = (bytes.byteLength - AUDIO_HEADER_BYTES) >> 1;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(AUDIO_HEADER_BYTES + i * 2, true);
  return { source: dv.getUint8(0), flags: dv.getUint8(1), seq: dv.getUint16(2, true), pcm };
}

/** Little-endian Int16 view of a binary mic frame (copies when unaligned). */
export function micFrameToPcm(bytes: Uint8Array): Int16Array {
  const len = bytes.byteLength & ~1;
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, len / 2);
  return new Int16Array(bytes.slice(0, len).buffer);
}
