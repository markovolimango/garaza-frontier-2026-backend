/**
 * Coach's analysis (Brain integration layer): the swarm reporter's written report, on the report
 * screen (BrainReport.tsx).
 * - Run tab: `GET /api/swarm/report/run/:runId` (protocol RunNarrative), polled every 1.5 s while
 *   the reporter writes: headline, what to improve (evidence + drill), filler words, Q&A verdicts,
 *   body notes, strengths, next run.
 * - Progress / final tab: `GET /api/swarm/report/session` (SessionNarrative). Its PDF
 *   (`GET /api/swarm/report/session.pdf?download=1`) is the report screen's "Export report".
 * The report screen polls (useNarrative) and leaves out its own sections the narrative covers better.
 */
import type { NarrativeStatus, QaVerdict, RunNarrative, SessionNarrative } from "@coach/protocol";
import { Fragment, useEffect, useState, type ReactNode } from "react";

export type Reply<T> = { status: NarrativeStatus | "loading" | "error"; report: T | null };
const LOADING: Reply<never> = { status: "loading", report: null };

/** Polls a reporter endpoint while it answers "pending" (and retries after errors), up to ~2 min. Null: no polling. */
export function useNarrative<T>(url: string | null, everyMs = 1500): Reply<T> {
  const [reply, setReply] = useState<Reply<T> & { url: string | null }>({ ...LOADING, url: null });
  useEffect(() => {
    if (!url) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    setReply({ ...LOADING, url });
    const again = (ms: number) => { if (live && ++tries < 80) timer = setTimeout(tick, ms); };
    const tick = () => {
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ status: NarrativeStatus; report: T | null }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((r) => {
          if (!live) return;
          setReply({ status: r.status, report: r.report, url });
          if (r.status === "pending") again(everyMs);
        })
        .catch(() => { if (!live) return; setReply((prev) => ({ ...prev, status: prev.report ? prev.status : "error" })); again(everyMs * 2); });
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [url, everyMs]);
  return reply.url === url ? reply : LOADING;   // never another run's report while the new one loads
}

// ---------------------------------------------------------------- run

export function RunAnalysis({ httpBase, runId }: { httpBase: string; runId: string }) {
  return <RunReply r={useNarrative<RunNarrative>(`${httpBase}/api/swarm/report/run/${encodeURIComponent(runId)}`)} />;
}

export function RunReply({ r }: { r: Reply<RunNarrative> }) {
  if (r.report) return <RunNarrativeView n={r.report} />;
  if (r.status === "none" || r.status === "error") return null;   // aborted run / no reporter: the digest below still works
  return <Writing what="this run" />;
}

export function Writing({ what }: { what: string }) {
  return (
    <section className="shrink-0 rounded-xl border border-primary/40 bg-card p-6" aria-busy="true">
      <h2 className="text-lg font-semibold">Coach's analysis</h2>
      <p className="mt-3 animate-pulse text-xl text-muted-foreground">The reporter is writing the analysis of {what}…</p>
    </section>
  );
}

const VERDICT: Record<QaVerdict, { text: string; cls: string }> = {
  strong: { text: "strong", cls: "border-emerald-400/60 text-emerald-400" },
  ok: { text: "ok", cls: "border-primary/60 text-primary" },
  weak: { text: "weak", cls: "border-amber-400/60 text-amber-400" },
  "no answer": { text: "no answer", cls: "border-destructive/60 text-destructive" },
};

/** "so [[um]] we" → so <mark>um</mark> we */
export function Marked({ text }: { text: string }) {
  const parts = text.split(/\[\[(.+?)\]\]/g);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-amber-300/80 px-0.5 text-black">{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

function Source({ source }: { source: RunNarrative["source"] }) {
  return <span className="font-mono text-xs text-muted-foreground">{source === "llm" ? "written by the reporter" : "from the measurements"}</span>;
}

export function RunNarrativeView({ n }: { n: RunNarrative }) {
  const f = n.fillers;
  return (
    <section className="shrink-0 rounded-xl border border-primary/40 bg-card p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">Coach's analysis</h2>
        <Source source={n.source} />
      </div>
      <p className="mt-2 text-3xl font-medium tracking-tight">{n.headline}</p>
      <p className="mt-2 max-w-[80ch] text-lg text-muted-foreground">{n.summary}</p>

      {n.improvements.length > 0 && (
        <ol className="mt-5 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))" }}>
          {n.improvements.map((x, i) => (
            <li key={i} className="rounded-lg border border-border bg-background/40 p-4">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-2xl font-bold text-primary">{i + 1}</span>
                <span className="text-xl font-semibold">{x.title}</span>
              </div>
              <p className="mt-2 text-base">{x.why}</p>
              {x.evidence && <p className="mt-2 text-sm italic text-muted-foreground"><Marked text={x.evidence} /></p>}
              {x.drill && <p className="mt-2 text-base text-emerald-400"><span className="font-semibold">Drill: </span>{x.drill}</p>}
            </li>
          ))}
        </ol>
      )}

      <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))" }}>
        <Box title="Filler words">
          {f.measured === false ? <p className="text-sm text-muted-foreground">No transcript for this run.</p> : (
            <>
              <p className="flex items-baseline gap-3"><span className="text-4xl font-semibold">{f.count}</span><span className="font-mono text-sm text-muted-foreground">{f.perMin}/min</span></p>
              {f.top.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-2">
                  {f.top.map((t) => <span key={t.word} className="rounded-full border border-border px-2 py-0.5 text-sm">“{t.word}” {t.count}×</span>)}
                </p>
              )}
              {f.examples.slice(0, 2).map((e, i) => <p key={i} className="mt-2 text-sm text-muted-foreground"><Marked text={e} /></p>)}
            </>
          )}
        </Box>

        <Box title="The judges' questions">
          {n.qa.length === 0 && <p className="text-sm text-muted-foreground">No questions this run.</p>}
          <ul className="space-y-3">
            {n.qa.map((q, i) => (
              <li key={i}>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 font-mono text-xs uppercase ${VERDICT[q.verdict].cls}`}>{VERDICT[q.verdict].text}</span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{q.judge}</span>
                </div>
                <p className="mt-1 font-medium">{q.question}</p>
                <p className="text-sm text-muted-foreground">{q.answerSummary}</p>
                {q.tip && <p className="text-sm text-emerald-400">{q.tip}</p>}
              </li>
            ))}
          </ul>
        </Box>

        <Box title="Body">
          {n.body.length === 0 && <p className="text-sm text-muted-foreground">Nothing noted about your body language.</p>}
          <ul className="space-y-2">
            {n.body.map((b, i) => <li key={i}><span className="font-medium">{b.kind}</span> <span className="font-mono text-sm text-muted-foreground">{b.count}×</span><p className="text-sm text-muted-foreground">{b.note}</p></li>)}
          </ul>
          {n.strengths.length > 0 && (
            <>
              <h4 className="mb-1 mt-4 text-sm font-medium text-muted-foreground">Went well</h4>
              <ul className="space-y-1">{n.strengths.map((s, i) => <li key={i}>✓ {s.text} {s.evidence && <span className="text-sm text-muted-foreground">(<Marked text={s.evidence} />)</span>}</li>)}</ul>
            </>
          )}
        </Box>
      </div>

      {n.nextRun && <p className="mt-4 text-lg"><span className="text-muted-foreground">Next run: </span>{n.nextRun}</p>}
    </section>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4">
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- session

export function SessionAnalysis({ httpBase }: { httpBase: string }) {
  return <SessionReply r={useNarrative<SessionNarrative>(`${httpBase}/api/swarm/report/session`)} />;
}

/** `progressTable`: the progress table is on screen too, so the "first run → last" lines are left to it. */
export function SessionReply({ r, progressTable = false }: { r: Reply<SessionNarrative>; progressTable?: boolean }) {
  if (r.report) return <SessionNarrativeView n={r.report} updating={r.status === "pending"} progressTable={progressTable} />;
  if (r.status === "none" || r.status === "error") return null;
  return <Writing what="the session" />;
}

export function SessionNarrativeView({ n, updating = false, progressTable = false }: { n: SessionNarrative; updating?: boolean; progressTable?: boolean }) {
  return (
    <section className="shrink-0 rounded-xl border border-primary/40 bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Coach's analysis · {n.runs.length} run{n.runs.length === 1 ? "" : "s"}{updating && <span className="ml-3 animate-pulse text-sm font-normal text-muted-foreground">updating…</span>}</h2>
        <Source source={n.source} />
      </div>
      <p className="mt-2 text-3xl font-medium tracking-tight">{n.headline}</p>
      <p className="mt-2 max-w-[80ch] text-lg text-muted-foreground">{n.summary}</p>

      {n.focus.length > 0 && (
        <>
          <h3 className="mb-2 mt-5 text-sm font-medium uppercase tracking-wide text-muted-foreground">Focus next</h3>
          <ol className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))" }}>
            {n.focus.map((x, i) => (
              <li key={i} className="rounded-lg border border-border bg-background/40 p-4">
                <div className="flex items-baseline gap-3"><span className="font-mono text-2xl font-bold text-primary">{i + 1}</span><span className="text-xl font-semibold">{x.title}</span></div>
                <p className="mt-2">{x.why}</p>
                <p className="mt-2 text-emerald-400"><span className="font-semibold">Drill: </span>{x.drill}</p>
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))" }}>
        {n.progress.length > 0 && !progressTable && (
          <Box title="First run → last">
            <ul className="space-y-1 text-lg">{n.progress.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </Box>
        )}
        {n.strengths.length > 0 && (
          <Box title="What went well">
            <ul className="space-y-1 text-lg">{n.strengths.map((s, i) => <li key={i}>✓ {s}</li>)}</ul>
          </Box>
        )}
        {n.runs.length > 0 && (
          <Box title="Run by run">
            <ul className="space-y-1">{n.runs.map((r) => <li key={r.runId}><span className="font-mono text-sm text-muted-foreground">Run {r.index} · </span>{r.headline}</li>)}</ul>
          </Box>
        )}
      </div>
    </section>
  );
}
