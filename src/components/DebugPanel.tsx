import { useState } from "react";
import { activeSource, getLast, publish } from "@/signals";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSignal } from "@/signals/useSignal";
import { MOOD_HUE_GREEN, MOOD_HUE_RED, clamp01, moodColor, moodLabel } from "@/signals/mood";

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const orb = useSignal("orbLevel");
  const fb = useSignal("feedback");
  const slide = useSignal("slide");
  const mood = useSignal("jjMood");
  const loadMood = useSignal("jjMoodSampled");
  const [selectedMood, setSelectedMood] = useState<number | null>(null);
  const chosenMood = selectedMood ?? loadMood ?? mood ?? 0.5;

  return (
    <div className="fixed bottom-4 right-4 z-[110] w-64 rounded-lg border border-border bg-card/90 font-mono text-xs text-card-foreground backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-muted-foreground hover:text-foreground"
      >
        <span>DEBUG</span>
        <span>{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          <Row k="orbLevel" v={orb?.toFixed(3) ?? "—"} />
          <Row k="feedback" v={fb ? `${fb.color} ${fb.intensity.toFixed(2)}` : "—"} />
          <Row k="slide" v={slide ?? "—"} />
          <Row
            k="jjMood"
            v={mood === undefined ? "—" : `${mood.toFixed(3)} ${moodLabel(mood)}`}
            swatch={mood === undefined ? undefined : moodColor(mood)}
          />
          <Row
            k="jj on load"
            v={loadMood === undefined ? "—" : `${loadMood.toFixed(3)} ${moodLabel(loadMood)}`}
            swatch={loadMood === undefined ? undefined : moodColor(loadMood)}
          />
          <MoodBar live={mood} load={loadMood} />
          <div className="space-y-2 border-t border-border pt-2">
            <label htmlFor="jj-load-color" className="flex justify-between text-muted-foreground">
              <span>JJ reload color</span>
              <span>{chosenMood.toFixed(3)}</span>
            </label>
            <input
              id="jj-load-color"
              aria-label="JJ reload color"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={chosenMood}
              onChange={(e) => setSelectedMood(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                publish("jjMood", chosenMood);
                publish("jjReload", (getLast("jjReload") ?? 0) + 1);
              }}
            >
              <RotateCw /> Reload JJ
            </Button>
          </div>
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => {
                setPaused(e.target.checked);
                activeSource.setPaused?.(e.target.checked);
              }}
            />
            Pause mock
          </label>
          <div className="flex gap-1">
            {(["red", "green", "neutral"] as const).map((c) => (
              <button
                key={c}
                onClick={() => publish("feedback", { color: c, intensity: c === "neutral" ? 0 : 1 })}
                className="flex-1 rounded border border-border px-1 py-1 hover:bg-accent"
              >
                {c}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground">Keys 1–4 switch screens</p>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, swatch }: { k: string; v: string | number; swatch?: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="flex items-center gap-1.5">
        {swatch && <span className="h-2.5 w-2.5 rounded-sm ring-1 ring-input" style={{ background: swatch }} />}
        <span>{v}</span>
      </span>
    </div>
  );
}

/** The red → green scale, with the live mood and the value JJ loaded. */
function MoodBar({ live, load }: { live?: number | undefined; load?: number | undefined }) {
  return (
    <div className="pt-1">
      <div
        className="relative h-1.5 rounded-full"
        style={{
          background: `linear-gradient(90deg, oklch(0.72 0.19 ${MOOD_HUE_RED}), oklch(0.72 0.19 ${(MOOD_HUE_RED + MOOD_HUE_GREEN) / 2}), oklch(0.72 0.19 ${MOOD_HUE_GREEN}))`,
        }}
      >
        {live !== undefined && (
          <span
            title="live jjMood"
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background/80 ring-1 ring-foreground/70"
            style={{ left: `${clamp01(live) * 100}%` }}
          />
        )}
        {load !== undefined && (
          <span
            title="jjMood when JJ's screen loaded"
            className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-background/60"
            style={{ left: `${clamp01(load) * 100}%`, background: moodColor(load) }}
          />
        )}
      </div>
      <p className="pt-1 text-muted-foreground">red → green · ring live, bar on load</p>
    </div>
  );
}
