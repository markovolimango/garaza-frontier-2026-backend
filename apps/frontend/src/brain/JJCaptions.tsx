/**
 * JJCaptions (Brain integration layer): a rolling caption of what JJ and the user say, from
 * the brain's `jj.transcript` lines (captions.ts). Without the brain it renders its children
 * (the JJ screen's static greeting). `compact` is the small version the overlay shows over the
 * slides while JJ is woken mid-run.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { activeSource } from "../signals";
import { BrainSource } from "./BrainSource";
import { visibleCaptions, type CaptionLine, type CaptionStore } from "./captions";

const NO_LINES: readonly CaptionLine[] = [];

export function JJCaptions({ children, compact = false }: { children?: ReactNode; compact?: boolean }) {
  if (!(activeSource instanceof BrainSource)) return <>{children}</>;
  return <Captions store={activeSource.captions} compact={compact}>{children}</Captions>;
}

function Captions({ store, compact, children }: { store: CaptionStore; compact: boolean; children?: ReactNode }) {
  const lines = useSyncExternalStore(store.subscribe, store.getLines, () => NO_LINES);   // empty on the server and while hydrating
  const [, tick] = useState(0);
  const active = lines.length > 0;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { store.prune(); tick((n) => n + 1); }, 100);   // reveal and fade run on time
    return () => clearInterval(t);
  }, [active, store]);
  const view = active ? visibleCaptions(lines, store.now(), compact ? 2 : undefined) : [];

  if (compact) {
    if (!view.length) return null;
    return (
      <div className="flex flex-col gap-1 rounded-2xl bg-black/75 px-5 py-3 text-center font-sans text-lg leading-snug text-white backdrop-blur" aria-live="polite">
        {view.map((c) => (
          <p key={c.lineId} style={{ opacity: Math.max(c.opacity, 0.35) }} className={c.who === "user" ? "italic text-white/70" : undefined}>
            {c.who === "user" && <span className="mr-2 font-mono text-xs uppercase not-italic tracking-widest text-white/50">You</span>}
            {c.text}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex h-48 w-full max-w-5xl flex-col items-center gap-3 overflow-hidden px-6 text-center ${view.length ? "justify-end [mask-image:linear-gradient(to_bottom,transparent,black_35%)]" : "justify-center"}`}
      aria-live="polite"
    >
      {view.length === 0
        ? children
        : view.map((c, i) => {
            const latest = i === view.length - 1;
            const size = latest ? "text-3xl md:text-4xl font-medium" : "text-xl";
            const tone = c.who === "user" ? "italic text-muted-foreground" : "text-foreground";
            return (
              <p key={c.lineId} className={`leading-snug transition-opacity duration-500 ${size} ${tone}`} style={{ opacity: c.opacity }}>
                {c.who === "user" && <span className="mr-3 align-middle font-mono text-xs uppercase not-italic tracking-widest text-muted-foreground">You</span>}
                {c.text}
              </p>
            );
          })}
    </div>
  );
}
