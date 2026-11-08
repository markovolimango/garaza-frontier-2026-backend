/**
 * Progress across runs (Brain integration layer): `GET /api/progress` (protocol SessionProgress).
 * The report screen shows it as a tab after the first run and opens on it in the brain's final
 * view: each run as a column, each behaviour the coach noticed as a row with its count per run,
 * per minute and the share of the run it took, the trend from the first measured run to the last
 * (per minute), and the targets' status.
 */
import type { BehaviorKind, ProgressRow, SessionProgress } from "@coach/protocol";
import { fmtMs, LEVEL_LABEL, MODE_LABEL } from "./format";

const STAGE: Record<SessionProgress["coach"]["stage"], string> = {
  baseline: "Getting a baseline", training: "Training with live feedback", fading: "Fading the feedback out", test: "Test without feedback", done: "Done",
};
const TREND: Record<ProgressRow["trend"], { icon: string; text: string; cls: string }> = {
  better: { icon: "↓", text: "better", cls: "text-emerald-400" },
  same: { icon: "→", text: "same", cls: "text-muted-foreground" },
  worse: { icon: "↑", text: "worse", cls: "text-amber-400" },
};

/** `focus`: the behaviour JJ is talking about (report.focus): its row lights up. */
export function ProgressView({ p, focus = null }: { p: SessionProgress; focus?: BehaviorKind | null }) {
  if (p.runs.length === 0) return <p className="text-muted-foreground">No finished run yet. Progress appears after the first run.</p>;
  const max = Math.max(1, ...p.rows.flatMap((r) => r.counts.map((c) => c ?? 0)));
  const cols = { gridTemplateColumns: `minmax(14rem, 1.4fr) repeat(${p.runs.length}, minmax(6rem, 1fr)) 7rem` };
  return (
    <div className="flex flex-col gap-6">
      {p.headline && (
        <p className="rounded-xl border border-primary/40 bg-primary/10 px-5 py-4 text-2xl font-medium tracking-tight">
          {p.headline}
        </p>
      )}

      <section className="overflow-x-auto rounded-xl border border-border bg-card p-5">
        <div className="grid min-w-fit items-end gap-x-4 gap-y-1" style={cols}>
          <span className="pb-2 text-sm text-muted-foreground">Run</span>
          {p.runs.map((r) => (
            <div key={r.runId} className="pb-2">
              <div className="text-lg font-semibold">Run {r.index}</div>
              <div className="text-xs text-muted-foreground">{MODE_LABEL[r.mode]} · {LEVEL_LABEL[r.level]}</div>
              <div className="font-mono text-xs text-muted-foreground">{fmtMs(r.presentationMs + r.qaMs)}{r.warnings > 0 ? ` · vignette ${r.warnings}×` : ""}</div>
            </div>
          ))}
          <span className="pb-2 text-right text-sm text-muted-foreground">Trend</span>

          {p.rows.length === 0 && (
            <p className="col-span-full border-t border-border py-4 text-sm text-muted-foreground">
              {p.runs.some((r) => r.coach) ? "The coach flagged nothing in any run." : "The camera coach wasn't connected, so there is nothing to compare."}
            </p>
          )}
          {p.rows.map((row) => (
            <Row key={row.rule} row={row} max={max} lit={focus !== null && row.kind === focus} />
          ))}

          <span className="border-t border-border pt-3 text-sm text-muted-foreground">Coach score</span>
          {p.runs.map((r) => (
            <div key={r.runId} className="border-t border-border pt-3">
              {r.score === null ? <span className="text-muted-foreground">—</span> : <Bar value={r.score} max={1} label={`${Math.round(r.score * 100)}`} tone="score" />}
            </div>
          ))}
          <span className="border-t border-border pt-3" />
        </div>
      </section>

      <p className="rounded-lg border border-border bg-card/60 px-4 py-3 text-sm">
        <span className="text-muted-foreground">Coach: </span>{STAGE[p.coach.stage]}
        {p.coach.recommendation && <><span className="text-muted-foreground"> · Next: </span>{p.coach.recommendation.reason}</>}
      </p>
    </div>
  );
}

function Row({ row, max, lit }: { row: ProgressRow; max: number; lit: boolean }) {
  const trend = TREND[row.trend];
  return (
    <>
      <div data-focus={lit ? "" : undefined} className={`flex items-center gap-2 border-t py-3 ${lit ? "rounded-md border-primary bg-primary/10 px-2 ring-2 ring-primary" : "border-border"}`}>
        <span className="font-medium">{row.label}</span>
        {row.isTarget && <span className="rounded-full border border-primary/60 px-2 text-xs text-primary">target</span>}
        {row.status === "fixed" && <span className="rounded-full border border-emerald-500/60 px-2 text-xs text-emerald-400">fixed</span>}
      </div>
      {row.counts.map((c, i) => (
        <div key={i} className="border-t border-border py-3">
          {c === null ? <span className="text-muted-foreground" title="camera coach not connected">—</span> : <Bar value={c} max={max} label={`${c}×`} tone={c === 0 ? "clean" : "count"} />}
          {c !== null && c > 0 && <Rate perMin={row.perMin?.[i] ?? null} pct={row.timePct?.[i] ?? null} />}
        </div>
      ))}
      <div className={`border-t border-border py-3 text-right font-mono text-sm ${trend.cls}`}>{trend.icon} {trend.text}</div>
    </>
  );
}

/** Per minute (runs of different length compare fairly) and share of the run (episodes). */
function Rate({ perMin, pct }: { perMin: number | null; pct: number | null }) {
  if (perMin === null && pct === null) return null;
  return (
    <div className="mt-1 font-mono text-xs text-muted-foreground">
      {perMin !== null && `${perMin}/min`}{perMin !== null && pct !== null && " · "}{pct !== null && `${pct}% of the time`}
    </div>
  );
}

function Bar({ value, max, label, tone }: { value: number; max: number; label: string; tone: "count" | "clean" | "score" }) {
  const fill = tone === "score" ? "bg-primary" : tone === "clean" ? "bg-emerald-500/70" : "bg-amber-500/80";
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <span className={`block h-full rounded-full ${fill}`} style={{ width: `${tone === "clean" ? 100 : Math.max(4, (value / max) * 100)}%` }} />
      </span>
      <span className="w-10 text-right font-mono text-sm">{tone === "clean" ? "0" : label}</span>
    </div>
  );
}
