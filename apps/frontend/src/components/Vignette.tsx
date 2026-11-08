import { useEffect, useState } from "react";
import { subscribe, type Feedback } from "@/signals";

const MAX = { red: 0.35, green: 0.45 } as const;

export function Vignette({ active }: { active: boolean }) {
  const [fb, setFb] = useState<Feedback>({ color: "neutral", intensity: 0 });
  useEffect(() => subscribe("feedback", setFb), []);

  const op = (c: "red" | "green") =>
    active && fb.color === c ? Math.min(1, fb.intensity) * MAX[c] : 0;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]" aria-hidden>
      <div className="vignette vignette-red" style={{ opacity: op("red") }} />
      <div className="vignette vignette-green" style={{ opacity: op("green") }} />
    </div>
  );
}
