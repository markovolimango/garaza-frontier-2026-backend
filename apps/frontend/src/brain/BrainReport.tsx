/**
 * BrainReport (Brain integration layer): the report screen under the brain. Two tabs:
 * - This run: the run digest (`GET /api/runs/:runId/report`, protocol RunDigest) for the run that
 *   just ended (or the last one after a reload): what the coach noticed, time per slide, the
 *   judges' questions, strengths and the next run;
 * - Progress: run 1 → 2 → 3 (`GET /api/progress`, SessionProgress, BrainProgress.tsx). The brain's
 *   final view opens on it; after two runs the run tab shows its headline.
 * The behaviour JJ is talking about (report.focus) lights up on both tabs.
 * The progress tab also has "Export report" (the brain's printable page, GET /api/session/export.html)
 * and "Delete and start over" (POST /api/session/reset: erases the session from the brain's disk).
 * The "Next run" bar comes from BrainBridge.
 */
import type { BehaviorKind, RunDigest, SessionProgress } from "@coach/protocol";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { NextButton } from "../components/NextButton";
import { activeSource } from "../signals";
import { ProgressView } from "./BrainProgress";
import { RunAnalysis, SessionAnalysis } from "./CoachAnalysis";
import { BrainSource } from "./BrainSource";
import { fmtMs, LEVEL_LABEL, MODE_LABEL } from "./format";

export const isBrainMode = () => activeSource instanceof BrainSource;

export function BrainReport() {
  // Client-only: the run is known only in the browser (no SSR mismatch on hydration).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!(activeSource instanceof BrainSource) || !mounted) return null;
  return <Report brain={activeSource} />;
}

export type ReportTab = "run" | "progress";

function Report({ brain }: { brain: BrainSource }) {
  const snap = useSyncExternalStore(brain.subscribe, brain.getSnapshot, brain.getSnapshot);
  const runId = snap.reportReady?.kind === "run" ? snap.reportReady.runId : snap.run?.runId;
  const final = snap.ui?.view === "final";
  const [tab, setTab] = useState<ReportTab>(final ? "progress" : "run");
  useEffect(() => { if (final) setTab("progress"); }, [final]);
  const [digest, setDigest] = useState<RunDigest | null>(null);
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!runId) return;
    let live = true;
    setError(null);
    const get = <T,>(path: string) => fetch(`${brain.httpBase}${path}`).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))));
    get<RunDigest>(`/api/runs/${encodeURIComponent(runId)}/report`)
      .then((d) => { if (live) setDigest(d); })
      .catch((e: unknown) => { if (live) setError(String(e)); });
    get<SessionProgress>("/api/progress").then((p) => { if (live) setProgress(p); }).catch(() => {});   // optional: the run tab works without it
    return () => { live = false; };
  }, [brain, runId, snap.reportReady]);
  if (!runId) return <Empty text="No run yet. Start one from JJ's screen." />;
  if (error) return <Empty text={`Couldn't load the report (${error}).`} />;
  if (!digest) return <Empty text="Loading the report…" />;
  return <ReportView d={digest} progress={progress} tab={tab} onTab={setTab} focus={snap.focus} actions={<SessionActions brain={brain} />}
    analysis={<RunAnalysis httpBase={brain.httpBase} runId={digest.runId} />} sessionAnalysis={<SessionAnalysis httpBase={brain.httpBase} />} />;
}

/** Export the session report; erase the session and start over (asks first). */
function SessionActions({ brain }: { brain: BrainSource }) {
  const [busy, setBusy] = useState(false);
  const erase = () => {
    if (!window.confirm("Delete this practice session (runs, reports and anything you told JJ) from this computer and start over?")) return;
    setBusy(true);
    fetch(`${brain.httpBase}/api/session/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full: true }) })
      .then((r) => r.json() as Promise<{ ok: boolean; hint?: string; reason?: string }>)
      .then((r) => brain.toast(r.ok ? "Session deleted. Click on JJ's screen to start a new one." : (r.hint ?? r.reason ?? "Couldn't delete the session"), r.ok ? "info" : "warn"))
      .catch((err: unknown) => brain.toast(`Couldn't delete the session: ${String(err)}`, "warn"))
      .finally(() => setBusy(false));
  };
  const btn = "pointer-events-auto rounded-full border px-4 py-1.5 font-sans text-sm";
  return (
    <>
      <a href={`${brain.httpBase}/api/session/export.html`} target="_blank" rel="noreferrer" className={`${btn} border-primary/60 text-primary hover:bg-primary/10`}>
        Export report
      </a>
      <button type="button" disabled={busy} onClick={erase} className={`${btn} border-destructive/60 text-destructive hover:bg-destructive/10 disabled:opacity-50`}>
        Delete and start over
      </button>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <main className="flex h-screen items-center justify-center text-lg text-muted-foreground">{text}</main>;
}

export function ReportView({ d, progress = null, tab = "run", onTab, focus = null, actions = null, analysis = null, sessionAnalysis = null }: {
  d: RunDigest; progress?: SessionProgress | null; tab?: ReportTab; onTab?: (t: ReportTab) => void; actions?: ReactNode;
  /** The behaviour JJ is talking about (report.focus, JJ's highlight_pattern): its card lights up. */
  focus?: BehaviorKind | null;
  /** The swarm reporter's run / session analysis (CoachAnalysis.tsx). */
  analysis?: ReactNode; sessionAnalysis?: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) main.current?.querySelector("[data-focus]")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focus, tab]);
  const total = d.durations.presentationMs + d.durations.qaMs;
  const maxDwell = Math.max(1, ...d.slides.map((s) => s.dwellMs));
  const tabs = progress && progress.runs.length > 0 && onTab ? (
    <nav className="flex gap-1 rounded-full border border-border bg-card p-1 font-sans text-sm">
      {(["run", "progress"] as const).map((t) => (
        <button key={t} type="button" onClick={() => onTab(t)}
          className={`rounded-full px-4 py-1.5 ${tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}>
          {t === "run" ? `Run ${d.index}` : `Progress · ${progress.runs.length} run${progress.runs.length === 1 ? "" : "s"}`}
        </button>
      ))}
    </nav>
  ) : null;
  if (tab === "progress" && progress) {
    return (
      <main ref={main} className="mx-auto flex h-screen max-w-[1760px] flex-col gap-6 overflow-y-auto px-10 pb-36 pt-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Report · progress</p>
            <h1 className="mt-1 text-4xl font-semibold tracking-tight">How you changed, run by run</h1>
          </div>
          <div className="flex items-center gap-4">{tabs}{actions}<NextButton to="/" label="Back to JJ" /></div>
        </header>
        {sessionAnalysis}
        <ProgressView p={progress} focus={focus} />
      </main>
    );
  }
  return (
    <main ref={main} className="mx-auto flex h-screen max-w-[1760px] flex-col gap-6 overflow-y-auto px-10 pb-36 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Report · run {d.index}</p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">{MODE_LABEL[d.mode]} run · {LEVEL_LABEL[d.level]}</h1>
        </div>
        <div className="flex items-center gap-6 font-mono text-sm text-muted-foreground">
          {tabs}
          <NextButton to="/" label="Back to JJ" />
          <Stat label="Presentation" value={fmtMs(d.durations.presentationMs)} />
          <Stat label="Q&A" value={fmtMs(d.durations.qaMs)} />
          <Stat label="Total" value={fmtMs(total)} />
          <Stat label="Vignette" value={`${d.feedback.warnings}×`} />
          <Stat label="Talked to JJ" value={`${d.wakes}×`} />
        </div>
      </header>
      {progress?.headline && progress.runs.length >= 2 && (
        <button type="button" onClick={() => onTab?.("progress")} className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-left text-lg">
          <span className="text-muted-foreground">Since run {progress.runs[0]!.index}: </span>{progress.headline} <span className="text-sm text-muted-foreground">· see progress →</span>
        </button>
      )}
      {d.targets.length > 0 && (
        <p className="text-sm text-muted-foreground">Working on: {d.targets.map((t) => <span key={t} className="ml-2 rounded-full border border-primary/50 px-2 py-0.5 text-foreground">{t.replace("_", " ")}</span>)}</p>
      )}

      {analysis}

      <div className={`grid flex-1 grid-cols-3 gap-6 ${analysis ? "min-h-[28rem]" : "min-h-0"}`}>
        <Section title="What the coach noticed">
          {!d.sources.coach && <p className="text-sm text-muted-foreground">The camera coach wasn't connected during this run, so there are no body or speech observations.</p>}
          {d.sources.coach && d.observations.length === 0 && <p className="text-sm text-muted-foreground">Nothing flagged. A clean run.</p>}
          <ul className="space-y-3">
            {d.observations.map((o) => (
              <li key={o.rule} data-focus={focus !== null && o.kind === focus ? "" : undefined}
                className={`rounded-lg border p-3 transition-shadow ${focus !== null && o.kind === focus ? "border-primary bg-primary/10 ring-2 ring-primary" : "border-border bg-background/40"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{o.label}</span>
                  <span className="flex items-center gap-2">
                    {o.isTarget && <span className="rounded-full border border-primary/60 px-2 text-xs text-primary">target</span>}
                    <span className="font-mono text-sm text-muted-foreground">{o.count}×</span>
                  </span>
                </div>
                {o.time && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {Math.round(o.time.totalMs / 1000)} s in total · {o.time.pct}% of the run · longest {Math.round(o.time.longestMs / 1000)} s
                  </p>
                )}
                {/* episodes: up to three exact moments; rule observations: the first one */}
                {(o.time ? o.examples : o.examples.slice(0, 1)).map((e) => (
                  <p key={e.tRunMs} className="mt-1 text-sm text-muted-foreground">
                    {fmtMs(e.tRunMs)}, {e.segment === "qa" ? "Q&A" : `slide ${e.slideIndex + 1}`}: {e.text}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {d.strengths.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">Went well</h3>
              <ul className="space-y-1 text-sm">{d.strengths.map((s) => <li key={s}>✓ {s}</li>)}</ul>
            </div>
          )}
        </Section>

        <Section title="Time per slide">
          {d.slides.length === 0 && <p className="text-sm text-muted-foreground">No slides were presented.</p>}
          <ul className="space-y-2">
            {d.slides.map((s) => (
              <li key={s.index} className="flex items-center gap-3 font-mono text-sm">
                <span className="w-16 text-muted-foreground">Slide {s.index + 1}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${(s.dwellMs / maxDwell) * 100}%` }} />
                </span>
                <span className="w-12 text-right">{fmtMs(s.dwellMs)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="The judges asked">
          {d.qa.length === 0 && <p className="text-sm text-muted-foreground">No questions this run.</p>}
          <ol className="space-y-3">
            {d.qa.map((q, i) => (
              <li key={i} className="rounded-lg border border-border bg-background/40 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{q.judgeTitle}</p>
                <p className="mt-1">{q.question}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{q.answerMs > 0 ? `answered for ${fmtMs(q.answerMs)}` : "no answer heard"}</p>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      {d.next && (
        <p className="rounded-lg border border-border bg-card/60 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Next: </span>{d.next.reason}
        </p>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="text-right"><div className="text-xl text-foreground">{value}</div><div className="text-xs">{label}</div></div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-h-0 overflow-y-auto rounded-xl border border-border bg-card p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
