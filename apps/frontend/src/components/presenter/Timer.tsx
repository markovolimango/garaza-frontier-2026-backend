import { useEffect, useState } from "react";
import { getLast, subscribe } from "@/signals/bus";
import { Button } from "@/components/ui/button";

export function fmt(sec: number) {
  const s = Math.max(0, Math.round(Math.abs(sec)));
  return `${sec < 0 ? "-" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface TimerProps {
  totalSec: number;
  onTotalChange: (s: number) => void;
}

export function Timer({ totalSec, onTotalChange }: TimerProps) {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(() => getLast("runClock") === "start" || getLast("runClock") === "resume");

  // brain integration: the timer starts with the presentation and pauses while JJ is woken.
  useEffect(() => subscribe("runClock", (c) => {
    if (c === "start") setElapsed(0);
    setRunning(c === "start" || c === "resume");
  }), []);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      setElapsed((e) => e + (now - last) / 1000);
      last = now;
    }, 200);
    return () => clearInterval(id);
  }, [running]);

  const remaining = totalSec - elapsed;
  const tone = remaining <= 0 ? "text-destructive" : remaining <= 60 ? "text-warning" : "text-foreground";

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={`font-sans text-5xl tabular-nums ${tone}`}>{fmt(remaining)}</span>
        <span className="text-sm tabular-nums text-muted-foreground">elapsed {fmt(elapsed)}</span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <label className="text-muted-foreground">Total (min)</label>
        <input
          type="number"
          min={1}
          value={Math.round(totalSec / 60)}
          onChange={(e) => onTotalChange(Math.max(1, Number(e.target.value)) * 60)}
          className="w-16 rounded-md border border-input bg-background px-2 py-1 text-center tabular-nums"
        />
        <div className="ml-auto flex gap-1">
          <Btn onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Start"}</Btn>
          <Btn onClick={() => { setRunning(false); setElapsed(0); }}>Reset</Btn>
        </div>
      </div>
    </div>
  );
}

export function Btn({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <Button variant={active ? "default" : "ghost"} size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}
