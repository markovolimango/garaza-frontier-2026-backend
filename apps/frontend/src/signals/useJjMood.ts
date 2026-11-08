import { useEffect, useState } from "react";
import { getLast, publish } from "./bus";
import { DEFAULT_JJ_MOOD } from "./mood";

/**
 * The color JJ wears on this visit.
 *
 * `jjMood` keeps drifting while the app runs, but JJ only picks it up when the
 * screen loads: the value is sampled once on mount and then held, so the orb
 * never changes color under someone who is already looking at it.
 */
export function useJjMood(): number {
  const [mood, setMood] = useState<number | null>(null);

  useEffect(() => {
    const sampled = getLast("jjMood") ?? DEFAULT_JJ_MOOD;
    setMood(sampled);
    publish("jjMoodSampled", sampled);
  }, []);

  return mood ?? DEFAULT_JJ_MOOD;
}
