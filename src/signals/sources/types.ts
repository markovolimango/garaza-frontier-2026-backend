/** A signal source pushes values onto the bus. Swap implementations in src/signals/index.ts. */
export interface SignalSource {
  start(): void;
  stop(): void;
  setPaused?(paused: boolean): void;
  isPaused?(): boolean;
}
