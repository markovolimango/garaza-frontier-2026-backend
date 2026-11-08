/**
 * PreRunCheck (Brain integration layer): "Before you start" between runs. Polls the brain's
 * GET /api/sensors/check (camera coach + microphone; between runs the coach bridge keeps a standby
 * session so the camera status is live) and shows the microphone level and whether runs are recorded.
 * It never blocks a run: JJ also hears what won't be measured (start_run → not_measured).
 */
import { useEffect, useState } from "react";
import type { BrainSource } from "./BrainSource";

interface SensorCheck {
  coach: boolean; camera: "ok" | "no_person" | "error" | "unknown"; inFrame: boolean; fps: number | null;
  mic: boolean; ready: boolean; hints: string[];
}

export function PreRunCheck({ brain, recording }: { brain: BrainSource; recording: "yes" | "no" | null }) {
  const [check, setCheck] = useState<SensorCheck | null>(null);
  const [level, setLevel] = useState(0);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    const poll = () => fetch(`${brain.httpBase}/api/sensors/check`).then((r) => r.json() as Promise<SensorCheck>)
      .then((c) => { if (live) setCheck(c); }).catch(() => {});
    void poll();
    const slow = setInterval(poll, 1000);
    const fast = setInterval(() => setLevel(brain.micLevel() ?? 0), 100);
    return () => { live = false; clearInterval(slow); clearInterval(fast); };
  }, [brain]);
  if (hidden || !check) return null;

  const camera: [Mark, string] = !check.coach ? ["bad", "camera coach not connected"]
    : check.camera === "ok" && check.inFrame ? ["ok", `sees you${check.fps ? ` · ${Math.round(check.fps)} fps` : ""}`]
    : check.camera === "no_person" ? ["warn", "doesn't see you: step into the frame"]
    : check.camera === "error" ? ["bad", "camera problem"] : ["warn", "no frames yet"];
  const heard = level > 0.02;
  const mic: [Mark, string] = !check.mic ? ["bad", "not streaming: click anywhere"] : heard ? ["ok", "hears you"] : ["ok", "on · say something"];
  const rec: [Mark, string] = recording === "yes" ? ["ok", "on (camera + mic)"] : ["off", recording === "no" ? "off" : "not chosen yet"];

  return (
    <div data-testid="pre-run-check" className="pointer-events-auto absolute left-6 top-16 w-[min(90vw,22rem)] rounded-xl border border-border bg-card/90 p-3 font-sans text-sm shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">{check.ready ? "Ready to present" : "Before you start"}</span>
        <button type="button" onClick={() => setHidden(true)} aria-label="Hide" className="text-muted-foreground hover:text-foreground">×</button>
      </div>
      <Row mark={camera[0]} label="Camera" text={camera[1]} />
      <Row mark={mic[0]} label="Microphone" text={mic[1]}>
        <span className="ml-2 h-1.5 w-16 overflow-hidden rounded-full bg-secondary">
          <span className="block h-full rounded-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${Math.min(100, level * 600)}%` }} />
        </span>
      </Row>
      <Row mark={rec[0]} label="Recording" text={rec[1]} />
      {!check.ready && check.hints.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">{check.hints.map((h) => <li key={h}>{h}</li>)}</ul>
      )}
    </div>
  );
}

type Mark = "ok" | "warn" | "bad" | "off";
const MARK: Record<Mark, { icon: string; cls: string }> = {
  ok: { icon: "✓", cls: "text-emerald-400" }, warn: { icon: "!", cls: "text-amber-400" },
  bad: { icon: "✗", cls: "text-red-400" }, off: { icon: "–", cls: "text-muted-foreground" },
};

function Row({ mark, label, text, children }: { mark: Mark; label: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`w-4 text-center font-mono ${MARK[mark].cls}`}>{MARK[mark].icon}</span>
      <span className="w-24 text-muted-foreground">{label}</span>
      <span className="flex-1">{text}</span>
      {children}
    </div>
  );
}
