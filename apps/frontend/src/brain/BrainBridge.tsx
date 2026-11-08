/**
 * BrainBridge (Brain integration layer): mounted once in the root route. Renders nothing
 * unless the active source is the brain.
 *
 * - The brain decides the screen: ui.state.view → route.
 * - A user move away from it (Next buttons, keys 1–4) becomes the loop action it means
 *   (start run, slides done, end run); if nothing changes, it snaps back.
 * - After a run, JJ's screen is allowed too (JJ debriefs); other moves snap back with a hint.
 * - Hold J = push-to-talk ("Hey JJ" fallback); Esc or the chip resumes the run. First click or
 *   key unlocks audio + mic.
 * - Overlay: countdown, toasts, connection and wake state; after a run, next-run buttons.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { activeSource } from "../signals";
import { BrainSource, type BrainSnapshot } from "./BrainSource";
import { intentFor, viewToRoute, type ScreenPath } from "./mapping";

const SCREENS: ScreenPath[] = ["/", "/presenter", "/judges", "/report"];

export function BrainBridge() {
  if (!(activeSource instanceof BrainSource)) return null;
  return <Bridge brain={activeSource} />;
}

function Bridge({ brain }: { brain: BrainSource }) {
  const snap = useSyncExternalStore(brain.subscribe, brain.getSnapshot, brain.getSnapshot);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const expected = useRef<ScreenPath | null>(null);
  const snapBack = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferred = useRef<ScreenPath | null>(null);
  // Navigation waits until hydration has settled: moving the router while a lazy route is
  // still hydrating makes the server HTML mismatch (React hydration warning).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setHydrated(true), 300); return () => clearTimeout(t); }, []);
  const view = hydrated ? snap.ui?.view ?? null : null;

  /** A user move to `to`: perform the loop action it means, or snap back. Reads the live snapshot. */
  const handleMove = (to: string) => {
    const live = brain.getSnapshot();
    const liveView = live.ui?.view ?? null;
    if (!liveView) return;
    const want = viewToRoute(liveView);
    expected.current = want;
    if (to === want || !SCREENS.includes(to as ScreenPath)) return;
    const intent = intentFor(liveView, live.run?.phase ?? null, to as ScreenPath);
    if (intent.kind === "allow") { expected.current = to as ScreenPath; return; }
    const back = () => { snapBack.current = null; deferred.current = null; if (expected.current) void navigate({ to: expected.current }); };
    if (intent.kind === "hint") { brain.toast(intent.text); back(); return; }
    brain.unlockAudio();
    if (intent.kind === "send") brain.send(intent.type, {});
    else void brain.invoke(intent.tool, intent.args).then((r) => { if (!r.ok) brain.toast(r.hint ?? r.reason, "warn"); });
    snapBack.current = setTimeout(back, 1500);   // the brain moves us if the action worked
  };

  // brain view → route
  useEffect(() => {
    if (!view) return;
    const route = viewToRoute(view);
    expected.current = route;
    if (snapBack.current) { clearTimeout(snapBack.current); snapBack.current = null; }
    const d = deferred.current;
    deferred.current = null;
    if (d && d !== route) { handleMove(d); return; }   // a move made while the last action was in flight
    if (pathname !== route) void navigate({ to: route });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // user navigation away from the brain's view (Next buttons, keys 1-4)
  useEffect(() => {
    if (!hydrated) return;
    if (snapBack.current) { deferred.current = pathname as ScreenPath; return; }   // previous action still in flight
    handleMove(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // push-to-talk + audio unlock
  useEffect(() => {
    const isField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input,textarea,select");
    const down = (e: KeyboardEvent) => {
      brain.unlockAudio();
      if ((e.key === "j" || e.key === "J") && !e.repeat && !isField(e.target)) brain.ptt(true);
      if (e.key === "Escape" && brain.getSnapshot().run?.paused) brain.resume();
    };
    const up = (e: KeyboardEvent) => { if ((e.key === "j" || e.key === "J") && !isField(e.target)) brain.ptt(false); };
    const click = () => brain.unlockAudio();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerdown", click);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("pointerdown", click); };
  }, [brain]);

  // the overlay's state is client-only, so it renders after hydration (no SSR mismatch)
  return hydrated ? <Overlay snap={snap} brain={brain} /> : null;
}

function Overlay({ snap, brain }: { snap: BrainSnapshot; brain: BrainSource }) {
  const offline = snap.status !== "open";
  const woken = snap.run?.paused;
  const afterRun = !offline && (snap.ui?.view === "report" || snap.ui?.view === "final");
  const startRun = (args: Record<string, unknown>) => {
    brain.unlockAudio();
    void brain.invoke("start_run", args).then((r) => { if (!r.ok) brain.toast(r.hint ?? r.reason, "warn"); });
  };
  return (
    <div className="pointer-events-none fixed inset-0 z-[105] font-mono text-xs">
      <div className="absolute left-1/2 top-4 flex -translate-x-1/2 gap-2">
        {offline && <Chip tone="warn">{snap.status === "replaced" ? "Opened in another tab: reload this one to use it here" : "Brain offline — reconnecting"}</Chip>}
        {!offline && !snap.audioOn && <Chip>Click anywhere to enable JJ's voice</Chip>}
        {snap.uploading && <Chip>Uploading deck…</Chip>}
        {woken && (
          <button type="button" onClick={() => brain.resume()} className="pointer-events-auto">
            <Chip tone="jj">JJ is listening — run paused · Esc or click to resume</Chip>
          </button>
        )}
        {snap.jj && !snap.jj.connected && !offline && snap.sessionPhase !== "setup" && <Chip tone="warn">JJ voice offline</Chip>}
      </div>
      {snap.countdown !== null && snap.countdown > 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <span className="text-[12rem] font-semibold text-white/90">{snap.countdown}</span>
        </div>
      )}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {afterRun && (
          <div className="pointer-events-auto mb-16 flex items-center gap-2 rounded-full border border-border bg-card/90 p-1.5 pl-4 backdrop-blur">
            <span className="text-muted-foreground">Next run</span>
            <button type="button" onClick={() => startRun({})} className="rounded-full border border-border bg-secondary px-3 py-1 hover:bg-accent">Start run</button>
            <button type="button" onClick={() => startRun({ mode: "training", level: "strong" })} className="rounded-full bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90">With live feedback</button>
          </div>
        )}
        {snap.toasts.map((t) => <Chip key={t.id} tone={t.level === "warn" ? "warn" : undefined}>{t.text}</Chip>)}
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "warn" | "jj" | undefined }) {
  const cls = tone === "warn" ? "border-amber-500/60 text-amber-300" : tone === "jj" ? "border-violet-400/60 text-violet-200" : "border-border text-muted-foreground";
  return <span className={`rounded-full border bg-card/90 px-3 py-1 backdrop-blur ${cls}`}>{children}</span>;
}
