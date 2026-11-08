/** Browser speechSynthesis fallback. Level is synthetic (pulses on word boundaries). */
export class WebSpeechVoice {
  private levels = new Map<number, number>();
  private voices: SpeechSynthesisVoice[] = [];

  static available() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  constructor() {
    if (!WebSpeechVoice.available()) return;
    const load = () => (this.voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")));
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
  }

  /** Speaks as judge `index` (0..3, distinct pitch/voice). Resolves when speech ends. */
  speak(index: number, text: string): Promise<void> {
    if (!WebSpeechVoice.available()) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voices[index % Math.max(1, this.voices.length)];
      if (v) u.voice = v;
      u.pitch = [0.85, 1.0, 1.15, 0.95][index % 4]!;
      u.rate = 1.02;
      u.onstart = () => this.levels.set(index, 0.6);
      u.onboundary = () => this.levels.set(index, 0.9);
      const done = () => {
        this.levels.delete(index);
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  /** Decaying pseudo-level so glow/head bob still move. */
  level(index: number): number {
    const l = this.levels.get(index);
    if (l === undefined) return 0;
    this.levels.set(index, Math.max(0.35, l * 0.9));
    return l;
  }

  cancel() {
    if (WebSpeechVoice.available()) speechSynthesis.cancel();
    this.levels.clear();
  }
}
