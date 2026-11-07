/** Int16 LE PCM <-> base64 (Gemini Live inlineData). */
export function pcm16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function base64ToPcm16(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  const n = buf.byteLength >> 1;          // drop a trailing odd byte
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Root-mean-square level of a frame, 0 … 32768. Used as a simple voice-activity signal. */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i]!; sum += v * v; }
  return Math.sqrt(sum / pcm.length);
}
