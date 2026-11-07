/**
 * JJ's mood: one number on a red → green scale.
 * Browser-safe (no imports from src/signals/sources).
 */

export const DEFAULT_JJ_MOOD = 0.5;

/** oklch hues of the two ends of the scale. */
export const MOOD_HUE_RED = 20;
export const MOOD_HUE_GREEN = 145;

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** The color for a mood: 0 = red, 1 = green, through amber. */
export function moodColor(mood: number): string {
  const t = clamp01(mood);
  const hue = Math.round(MOOD_HUE_RED + t * (MOOD_HUE_GREEN - MOOD_HUE_RED));
  return `oklch(0.72 0.19 ${hue})`;
}

/** Human-readable end of the scale the mood sits on. */
export function moodLabel(mood: number): "red" | "amber" | "green" {
  const t = clamp01(mood);
  if (t < 0.34) return "red";
  if (t > 0.66) return "green";
  return "amber";
}

type Oklch = [l: number, c: number, h: number];
interface MoodPalette {
  a: Oklch;
  b: Oklch;
  c: Oklch;
  hi: Oklch;
}
type MoodStop = { at: number } & MoodPalette;

/**
 * The orb's four colors at each point of the scale. Keyed on the mood itself
 * rather than mixed into the default plasma, so a low mood really reads red
 * instead of picking up the plasma's violet and going pink.
 */
const MOOD_STOPS: MoodStop[] = [
  { at: 0, a: [0.8, 0.16, 30], b: [0.52, 0.22, 15], c: [0.48, 0.22, 5], hi: [0.95, 0.06, 40] },
  { at: 0.5, a: [0.84, 0.16, 80], b: [0.6, 0.18, 60], c: [0.55, 0.18, 45], hi: [0.96, 0.05, 85] },
  { at: 1, a: [0.84, 0.16, 150], b: [0.58, 0.18, 165], c: [0.52, 0.18, 175], hi: [0.96, 0.05, 150] },
];

function mix(from: Oklch, to: Oklch, t: number): string {
  const at = (i: 0 | 1 | 2) => (from[i] + (to[i] - from[i]) * t).toFixed(i === 2 ? 1 : 3);
  return `oklch(${at(0)} ${at(1)} ${at(2)})`;
}

/** The orb colors JJ wears for a mood: red family at 0, green family at 1. */
export function moodOrbPalette(mood: number): Record<"a" | "b" | "c" | "hi", string> {
  const t = clamp01(mood);
  let i = 0;
  while (i < MOOD_STOPS.length - 2 && t > MOOD_STOPS[i + 1]!.at) i++;
  const lo = MOOD_STOPS[i]!;
  const up = MOOD_STOPS[i + 1]!;
  const k = (t - lo.at) / (up.at - lo.at || 1);
  return {
    a: mix(lo.a, up.a, k),
    b: mix(lo.b, up.b, k),
    c: mix(lo.c, up.c, k),
    hi: mix(lo.hi, up.hi, k),
  };
}
