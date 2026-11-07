export type FeedbackColor = "red" | "green" | "neutral";
export interface Feedback {
  color: FeedbackColor;
  intensity: number; // 0..1
}

export interface Channels {
  orbLevel: number;
  feedback: Feedback;
  slide: number;
  /** Live mood for JJ: 0 = red, 1 = green. Drifts while the app runs. */
  jjMood: number;
  /** The jjMood value JJ's screen sampled the last time it loaded. */
  jjMoodSampled: number;
  /** Explicit debug request to reload JJ with a selected mood. */
  jjReload: number;
  /** brain integration: the brain asks the presenter to show this slide. */
  slideCommand: number;
  /** brain integration: the PDF the presenter loaded (uploaded to the brain). */
  deckFile: File;
}

export type Channel = keyof Channels;
type Listener<C extends Channel> = (value: Channels[C]) => void;

const listeners: { [C in Channel]: Set<Listener<C>> } = {
  orbLevel: new Set(),
  feedback: new Set(),
  slide: new Set(),
  jjMood: new Set(),
  jjMoodSampled: new Set(),
  jjReload: new Set(),
  slideCommand: new Set(),
  deckFile: new Set(),
};
const last: Partial<Channels> = {};

export function publish<C extends Channel>(channel: C, value: Channels[C]): void {
  last[channel] = value;
  listeners[channel].forEach((cb) => cb(value));
}

/** Subscribe to a channel. Returns an unsubscribe function. */
export function subscribe<C extends Channel>(channel: C, cb: Listener<C>): () => void {
  listeners[channel].add(cb);
  return () => {
    listeners[channel].delete(cb);
  };
}

export function getLast<C extends Channel>(channel: C): Channels[C] | undefined {
  return last[channel] as Channels[C] | undefined;
}
