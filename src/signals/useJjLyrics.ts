import { useEffect, useState } from "react";
import { getLast, subscribe } from "./bus";

export const JJ_SAMPLE_LINES = [
  "Hi, I'm JJ. Let's find your flow.",
  "Big ideas start with a clear story.",
  "Take a breath. You've got this.",
] as const;

export function useJjLyrics() {
  const [lyrics, setLyrics] = useState({ line: String(JJ_SAMPLE_LINES[0]), previous: "", sequence: 0 });

  useEffect(() => {
    let live = false;
    let index = 0;
    const show = (line: string) => {
      setLyrics((current) => ({ line, previous: current.line, sequence: current.sequence + 1 }));
    };
    const receive = (line: string) => {
      if (!line.trim()) return;
      live = true;
      show(line.trim());
    };
    const unsubscribe = subscribe("jjLine", receive);
    const existing = getLast("jjLine");
    if (existing) receive(existing);
    const timer = window.setInterval(() => {
      if (live) return;
      index = (index + 1) % JJ_SAMPLE_LINES.length;
      const line = JJ_SAMPLE_LINES[index];
      if (line) show(line);
    }, 3500);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  return lyrics;
}