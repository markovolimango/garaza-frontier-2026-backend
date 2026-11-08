/**
 * BrainReport (Brain integration layer): the report screen under the brain. Fetches the run
 * digest (`GET /api/runs/:runId/report`, protocol RunDigest) for the run that just ended (or the
 * last one after a reload) and shows what the coach noticed, time per slide, the judges'
 * questions, strengths and the next run. The "Next run" bar comes from BrainBridge.
 */
import type { RunDigest } from "@coach/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { NextButton } from "../components/NextButton";
import { activeSource } from "../signals";
import { BrainSource } from "./BrainSource";

export const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const MODE: Record<RunDigest["mode"], string> = { baseline: "Baseline run", training: "Training run", test: "Test run" };
const LEVEL: Record<RunDigest["level"], string> = { strong: "strong feedback", gentle: "gentle feedback", off: "no feedback" };

export const isBrainMode = () => activeSource instanceof BrainSource;

export function BrainReport() {
  // Client-only: the run is known only in the browser (no SSR mismatch on hydration).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!(activeSource instanceof BrainSource) || !mounted) return null;
  return <Report brain={activeSource} />;
}

function Report({ brain }: { brain: BrainSource }) {
  const snap = useSyncExternalStore(brain.subscribe, brain.getSnapshot, brain.getSnapshot);
  const runId = snap.reportReady?.kind === "run" ? snap.reportReady.runId : snap.run?.runId;
  const [digest, setDigest] = useState<RunDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!runId) return;
    let live = true;
    setError(null);
    fetch(`${brain.httpBase}/api/runs/${encodeURIComponent(runId)}/report`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: RunDigest) => { if (live) setDigest(d); })
      .catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [brain, runId, snap.reportReady]);
  if (!runId) return <Empty text="No run yet. Start one from JJ's screen." />;
  if (error) return <Empty text={`Couldn't load the report (${error}).`} />;
  if (!digest) return <Empty text="Loading the report…" />;
  return <ReportView d={digest} />;
}

function Empty({ text }: { text: string }) {
  return <main className="flex h-screen items-center justify-center text-lg text-muted-foreground">{text}</main>;
}

export function ReportView({ d }: { d: RunDigest }) {
  const total = d.durations.presentationMs + d.durations.qaMs;
  const maxDwell = Math.max(1, ...d.slides.map((s) => s.dwellMs));
  return (
    <main className="mx-auto flex h-screen max-w-[1760px] flex-col gap-6 overflow-y-auto px-10 pb-36 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Report · run {d.index}</p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">{MODE[d.mode]} · {LEVEL[d.level]}</h1>
        </div>
        <div className="flex items-center gap-6 font-mono text-sm text-muted-foreground">
          <NextButton to="/" label="Back to JJ" />
          <Stat label="Presentation" value={fmtMs(d.durations.presentationMs)} />
          <Stat label="Q&A" value={fmtMs(d.durations.qaMs)} />
          <Stat label="Total" value={fmtMs(total)} />
          <Stat label="Vignette" value={`${d.feedback.warnings}×`} />
          <Stat label="Talked to JJ" value={`${d.wakes}×`} />
        </div>
      </header>
      {d.targets.length > 0 && (
        <p className="text-sm text-muted-foreground">Working on: {d.targets.map((t) => <span key={t} className="ml-2 rounded-full border border-primary/50 px-2 py-0.5 text-foreground">{t.replace("_", " ")}</span>)}</p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-6">
        <Section title="What the coach noticed">
          {!d.sources.coach && <p className="text-sm text-muted-foreground">The camera coach wasn't connected during this run, so there are no body or speech observations.</p>}
          {d.sources.coach && d.observations.length === 0 && <p className="text-sm text-muted-foreground">Nothing flagged. A clean run.</p>}
          <ul className="space-y-3">
            {d.observations.map((o) => (
              <li key={o.rule} className="rounded-lg border border-border bg-background/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{o.label}</span>
                  <span className="flex items-center gap-2">
                    {o.isTarget && <span className="rounded-full border border-primary/60 px-2 text-xs text-primary">target</span>}
                    <span className="font-mono text-sm text-muted-foreground">{o.count}×</span>
                  </span>
                </div>
                {o.examples[0] && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {fmtMs(o.examples[0].tRunMs)}, {o.examples[0].segment === "qa" ? "Q&A" : `slide ${o.examples[0].slideIndex + 1}`}: {o.examples[0].text}
                  </p>
                )}
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
