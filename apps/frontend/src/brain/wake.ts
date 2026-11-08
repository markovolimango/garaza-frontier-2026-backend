/**
 * "Hey JJ" by voice (Brain integration layer), until the brain has its own STT + wake detector.
 * Uses the browser's speech recognition (Chrome: webkitSpeechRecognition, no API key; the audio
 * goes to the browser vendor's service) and calls onWake when a wake phrase is heard. BrainSource
 * turns that into the same `ptt` uplink as holding J. Fails quietly where unsupported or denied.
 */

const WAKE = /\b(hey|hi|okay|ok|hej)[\s,.!]+(j\.?\s?j\.?|jay[\s-]?jay|jayjay|jj|g\.?\s?g|djej\s?djej|džej\s?džej)(?![a-z])/i;

export function isWakePhrase(text: string): boolean { return WAKE.test(text); }

interface Recognition {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void;
}
type RecognitionCtor = new () => Recognition;

export class WakeListener {
  private rec: Recognition | null = null;
  private stopped = false;
  private failures = 0;
  private lastWake = 0;

  constructor(private readonly onWake: () => void, private readonly lang = "en-US") {}

  static supported(): boolean {
    const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    return typeof window !== "undefined" && !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  }

  start(): void {
    if (this.rec || !WakeListener.supported()) return;
    const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onresult = (e) => {
      this.failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i]?.[0]?.transcript ?? "";
        if (isWakePhrase(text) && Date.now() - this.lastWake > 3000) { this.lastWake = Date.now(); this.onWake(); }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.stopped = true;
      else if (e.error !== "no-speech" && e.error !== "aborted") this.failures++;
    };
    // Recognition ends by itself after silence or a network hiccup: restart, backing off on repeated failures.
    rec.onend = () => {
      if (this.stopped || this.failures >= 5) return;
      setTimeout(() => { try { if (!this.stopped) rec.start(); } catch { /* already started */ } }, this.failures ? 2000 * this.failures : 300);
    };
    this.rec = rec;
    try { rec.start(); } catch { /* already started */ }
  }

  stop(): void {
    this.stopped = true;
    try { this.rec?.stop(); } catch { /* not started */ }
    this.rec = null;
  }
}
