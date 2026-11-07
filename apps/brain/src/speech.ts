/**
 * Speech pipeline contracts (spec: "Speech pipeline"). INTERFACES ONLY: the sensing lane
 * implements DeepgramStt / FixtureStt and the WakeDetector (using matchWake from
 * packages/rules). The brain wires whatever implements these; with none, the run still
 * works and wake is push-to-talk / operator only.
 */
import type { WordToken } from "@coach/protocol";

export interface SttStream {
  /** startedAt = brain time of the first audio frame sent. */
  open(startedAt: number): Promise<void>;
  write(pcm16k: Int16Array): void;
  /** Sends {"type":"CloseStream"} and waits for final results. */
  close(): Promise<void>;
  onWords(cb: (words: WordToken[]) => void): void;
  onInterim(cb: (text: string, t: number) => void): void;
  onSpeechStarted(cb: (t: number) => void): void;
  onUtteranceEnd(cb: (t: number) => void): void;
}

export interface WakeDetector {
  onTranscript(text: string, isFinal: boolean, t: number): void;
  onWake(cb: (phraseStart: number) => void): void;
}

/** Opens one STT stream per run (factory so each run gets a fresh connection). */
export type SttFactory = () => SttStream;
