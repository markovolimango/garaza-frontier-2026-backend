import { useEffect, useState } from "react";

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
  const [running, setRunning] = useState(false);

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
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <span className={`font-mono text-5xl tabular-nums ${tone}`}>{fmt(remaining)}</span>
        <span className="font-mono text-sm text-muted-foreground">elapsed {fmt(elapsed)}</span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <label className="text-muted-foreground">Total (min)</label>
        <input
          type="number"
          min={1}
          value={Math.round(totalSec / 60)}
          onChange={(e) => onTotalChange(Math.max(1, Number(e.target.value)) * 60)}
          className="w-16 rounded border border-input bg-background px-2 py-1"
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
    <button
      onClick={onClick}
      className={`rounded-md border border-border px-3 py-1 text-sm transition-colors hover:bg-accent ${active ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-secondary"}`}
    >
      {children}
    </button>
  );
}
