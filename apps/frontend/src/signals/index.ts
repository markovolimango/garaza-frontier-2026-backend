import { MockSource } from "./sources/MockSource";
import type { SignalSource } from "./sources/types";
import { BrainSource, brainOptionsFromEnv } from "../brain/BrainSource";

export * from "./bus";

/**
 * The single place that picks the active data source.
 * brain integration: VITE_SIGNAL_SOURCE=brain connects to the coach brain (VITE_BRAIN_URL,
 * default http://localhost:8787); anything else keeps the mock (Lovable preview).
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const activeSource: SignalSource = env["VITE_SIGNAL_SOURCE"] === "brain" ? new BrainSource(brainOptionsFromEnv()) : new MockSource();

let started = false;
export function startSignals() {
  if (started) return;
  started = true;
  activeSource.start();
}
