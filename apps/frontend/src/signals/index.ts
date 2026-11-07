import { MockSource } from "./sources/MockSource";
import type { SignalSource } from "./sources/types";
// import { WebSocketSource } from "./sources/WebSocketSource";

export * from "./bus";

/** The single place that picks the active data source. */
export const activeSource: SignalSource = new MockSource();
// export const activeSource: SignalSource = new WebSocketSource("wss://example/signals");

let started = false;
export function startSignals() {
  if (started) return;
  started = true;
  activeSource.start();
}
