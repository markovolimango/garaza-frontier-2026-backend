/**
 * Pitch mode (Brain integration layer), route /pitch: the stage demo. JJ stays silent; the presenter
 * clicks Start and just talks (mic, and the camera when the coach runs); one click shows the dashboard
 * of the talk: duration, pace, filler words and body language on one timeline, and the reporter's
 * written analysis when it is ready.
 *
 * Brain: POST /api/pitch/start | stop | exit, GET /api/pitch/dashboard/:runId (PitchDashboard),
 * GET /api/swarm/report/run/:runId (the analysis), GET /api/sensors/check (camera, mic).
 */
import type { PitchDashboard, RunNarrative } from "@coach/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { activeSource } from "../signals";
import { BrainSource } from "./BrainSource";
import { useNarrative, Writing, type Reply } from "./CoachAnalysis";
import { fmtMs } from "./format";

type View = { kind: "ready" } | { kind: "live"; runId: string } | { kind: "dashboard"; runId: string };

export function PitchMode() {
  if (!(activeSource instanceof BrainSource)) {
    return <main className="flex h-screen items-center justify-center text-xl text-muted-foreground">Pitch mode needs the brain (VITE_SIGNAL_SOURCE=brain).</main>;
  }
  return <Pitch brain={activeSource} />;
}

async function post(brain: BrainSource, path: string): Promise<{ ok: boolean; runId?: string; hint?: string; reason?: string }> {
  try {
    const r = await fetch(`${brain.httpBase}${path}`, { method: "POST" });
    return (await r.json()) as { ok: boolean; runId?: string; hint?: string };
  } catch (err) {
    return { ok: false, hint: `the brain is not reachable (${String(err)})` };
  }
}

function Pitch({ brain }: { brain: BrainSource }) {
  const snap = useSyncExternalStore(brain.subscribe, brain.getSnapshot, brain.getSnapshot);
  const [view, setView] = useState<View>({ kind: "ready" });
  const [busy, setBusy] = useState(false);
  const run = snap.run;

  // a reload during a pitch picks the talk up again
  useEffect(() => {
    if (view.kind === "ready" && run?.pitch && run.phase === "presentation") setView({ kind: "live", runId: run.runId });
  }, [run?.pitch, run?.phase, run?.runId, view.kind]);
  // leaving the page gives JJ back its voice (the brain refuses while a pitch is recorded)
  useEffect(() => () => { void fetch(`${brain.httpBase}/api/pitch/exit`, { method: "POST", keepalive: true }).catch(() => {}); }, [brain]);

  const start = async (record: boolean) => {
    brain.unlockAudio();   // the click turns the microphone on
    setBusy(true);
    const r = await post(brain, "/api/pitch/start");
    setBusy(false);
    // after the start: in setup (no run yet) the stage forgets a consent, as after a reset
    brain.setRecordConsent(record ? "yes" : "no");
    if (r.ok && r.runId) setView({ kind: "live", runId: r.runId });
    else brain.toast(`Couldn't start: ${r.hint ?? r.reason ?? "unknown error"}`, "warn");
  };
  const stop = async () => {
    setBusy(true);
    const r = await post(brain, "/api/pitch/stop");
    setBusy(false);
    if (r.ok && r.runId) setView({ kind: "dashboard", runId: r.runId });
    else brain.toast(`Couldn't stop: ${r.hint ?? r.reason ?? "unknown error"}`, "warn");
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      {snap.status !== "open" && <p className="fixed left-1/2 top-4 -translate-x-1/2 rounded-full border border-amber-500/60 bg-card px-3 py-1 font-mono text-xs text-amber-300">Brain offline — reconnecting</p>}
      {view.kind === "ready" && <Ready brain={brain} busy={busy} onStart={start} />}
      {view.kind === "live" && <Live brain={brain} runId={view.runId} startedAt={run?.runId === view.runId ? run.presentationStartedAt ?? null : null} busy={busy} onStop={stop} />}
      {view.kind === "dashboard" && <Dashboard brain={brain} runId={view.runId} onAgain={() => setView({ kind: "ready" })} />}
    </main>
  );
}

// ---------------------------------------------------------------- ready / live

interface SensorCheck { coach: boolean; camera: string; inFrame: boolean; fps: number | null; mic: boolean }

function useSensors(brain: BrainSource, everyMs = 1500): SensorCheck | null {
  const [check, setCheck] = useState<SensorCheck | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => fetch(`${brain.httpBase}/api/sensors/check`, { cache: "no-store" })
      .then((r) => r.json() as Promise<SensorCheck>).then((c) => { if (live) setCheck(c); }).catch(() => {});
    void tick();
    const t = setInterval(tick, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [brain, everyMs]);
  return check;
}

function cameraText(c: SensorCheck | null): { ok: boolean; text: string } {
  if (!c) return { ok: false, text: "checking…" };
  if (!c.coach) return { ok: false, text: "off (no camera coach): speech only" };
  if (c.inFrame) return { ok: true, text: `sees you${c.fps ? ` · ${Math.round(c.fps)} fps` : ""}` };
  return { ok: false, text: c.camera === "ok" ? "doesn't see you: step into the frame" : "no frames yet" };
}

function Ready({ brain, busy, onStart }: { brain: BrainSource; busy: boolean; onStart: (record: boolean) => void }) {
  const sensors = useSensors(brain);
  const [record, setRecord] = useState(true);
  const cam = cameraText(sensors);
  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-10 px-6 text-center">
      <div>
        <p className="font-mono text-sm uppercase tracking-[0.3em] text-muted-foreground">Pitch mode</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-tight md:text-6xl">Give your pitch. We'll listen.</h1>
        <p className="mt-4 text-lg text-muted-foreground">JJ stays quiet. Click start, talk, then show the dashboard.</p>
      </div>
      <ul className="grid w-full max-w-md gap-2 text-left text-sm">
        <Status ok={!!sensors?.mic || brain.micLevel() !== null} label="Microphone" text={sensors?.mic || brain.micLevel() !== null ? "on" : "turns on with the start click"} />
        <Status ok={cam.ok} label="Camera" text={cam.text} />
        <li className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2">
          <input id="pitch-record" type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} className="h-4 w-4 accent-primary" />
          <label htmlFor="pitch-record" className="text-muted-foreground">Record camera + mic for the body-language analysis (stays on this computer; a copy goes to Gemini only if video analysis is on)</label>
        </li>
      </ul>
      <button type="button" disabled={busy} onClick={() => onStart(record)}
        className="rounded-full bg-primary px-10 py-5 text-2xl font-semibold text-primary-foreground shadow-lg transition hover:bg-primary/90 disabled:opacity-60">
        {busy ? "Starting…" : "Start listening"}
      </button>
    </section>
  );
}

function Status({ ok, label, text }: { ok: boolean; label: string; text: string }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2">
      <span aria-hidden className={ok ? "text-emerald-400" : "text-amber-400"}>{ok ? "✓" : "!"}</span>
      <span className="w-28 text-muted-foreground">{label}</span>
      <span>{text}</span>
    </li>
  );
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

function useDashboard(brain: BrainSource, runId: string, everyMs: number, until?: () => boolean): PitchDashboard | null {
  const [d, setD] = useState<PitchDashboard | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      fetch(`${brain.httpBase}/api/pitch/dashboard/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<PitchDashboard>) : null))
        .then((x) => { if (live && x) setD(x); })
        .catch(() => {})
        .finally(() => { if (live && !(until?.() ?? false)) timer = setTimeout(tick, everyMs); });
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brain, runId, everyMs]);
  return d;
}

function Live({ brain, runId, startedAt, busy, onStop }: { brain: BrainSource; runId: string; startedAt: number | null; busy: boolean; onStop: () => void }) {
  const now = useNow(250);
  const d = useDashboard(brain, runId, 2000);
  const [level, setLevel] = useState(0);
  useEffect(() => { const t = setInterval(() => setLevel(brain.micLevel() ?? 0), 100); return () => clearInterval(t); }, [brain]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.key === "d" || e.key === "D") && !e.repeat) onStop(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onStop]);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : d?.durationMs ?? 0;
  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-10 px-6 text-center">
      <div className="flex items-center gap-3 font-mono text-sm uppercase tracking-[0.3em] text-muted-foreground">
        <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-primary" /></span>
        Listening
      </div>
      <p className="font-mono text-8xl font-semibold tabular-nums md:text-9xl">{fmtMs(elapsed)}</p>
      <div className="h-2 w-64 overflow-hidden rounded-full bg-muted" aria-label="microphone level">
        <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
      </div>
      <p className="text-lg text-muted-foreground tabular-nums">
        {/* the listener reports a phrase once it ends, so the counters may lag the talk by a few seconds */}
        {d?.speech.measured ? `${d.speech.words} words · ${d.speech.fillers.count} filler word${d.speech.fillers.count === 1 ? "" : "s"}` : "Talk whenever you're ready."}
        {d?.body.measured ? ` · ${d.body.rows.reduce((n, r) => n + r.count, 0)} body moments` : ""}
      </p>
      <button type="button" disabled={busy} onClick={onStop}
        className="rounded-full bg-primary px-10 py-5 text-2xl font-semibold text-primary-foreground shadow-lg transition hover:bg-primary/90 disabled:opacity-60">
        {busy ? "Stopping…" : "Show dashboard"}
      </button>
      <p className="font-mono text-xs text-muted-foreground">or press D</p>
    </section>
  );
}

// ---------------------------------------------------------------- dashboard

const FILLER_COLOR = "#d95926";   // categorical slot 2 (dark), validated with the body color on the dark surface
const BODY_COLOR = "#3987e5";     // categorical slot 1 (dark)

function Dashboard({ brain, runId, onAgain }: { brain: BrainSource; runId: string; onAgain: () => void }) {
  const narrative = useNarrative<RunNarrative>(`${brain.httpBase}/api/swarm/report/run/${encodeURIComponent(runId)}`);
  const [since] = useState(() => Date.now());
  // the listener's last phrase lands a few seconds after the stop
  const d = useDashboard(brain, runId, 2000, () => Date.now() - since > 20_000);
  if (!d) return <p className="flex min-h-screen items-center justify-center text-xl text-muted-foreground animate-pulse">Building your dashboard…</p>;
  const s = d.speech;
  const bodyMoments = d.body.rows.reduce((n, r) => n + r.count, 0);
  const bodyPct = Math.min(100, Math.round(d.body.rows.reduce((n, r) => n + r.pct, 0)));
  return (
    <section className="mx-auto max-w-6xl space-y-6 px-6 py-8" data-testid="pitch-dashboard">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-sm uppercase tracking-[0.3em] text-muted-foreground">Pitch dashboard · run {d.index}</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">How the pitch went</h1>
        </div>
        <button type="button" onClick={onAgain} className="rounded-full border border-border px-5 py-2 text-sm hover:bg-accent">New pitch</button>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Duration" value={fmtMs(d.durationMs)} note={d.live ? "still running" : "talk time"} />
        <Tile label="Pace" value={s.wpm !== null ? `${s.wpm}` : "—"} unit={s.wpm !== null ? "wpm" : undefined}
          note={s.wpm === null ? (s.measured ? "too short to tell" : "no transcript") : s.wpm < 110 ? "slow (aim for 120–160)" : s.wpm > 170 ? "fast (aim for 120–160)" : "comfortable (120–160)"} />
        <Tile label="Filler words" value={s.measured ? `${s.fillers.count}` : "—"}
          note={!s.measured ? "no transcript" : s.fillers.perMin !== null ? `${s.fillers.perMin} per minute` : "in the talk"} />
        <Tile label="Body language" value={d.body.measured ? `${bodyMoments}` : "—"} unit={d.body.measured ? (bodyMoments === 1 ? "moment" : "moments") : undefined}
          note={d.body.measured ? `${bodyPct}% of the talk` : "camera off"} />
      </div>

      <Timeline d={d} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-6">
          <Card title="Filler words">
            {!s.measured ? <p className="text-muted-foreground">No transcript for this talk (the listener needs a Gemini key and the microphone).</p>
              : s.fillers.top.length === 0 ? <p className="text-muted-foreground">None heard.</p>
              : <ul className="space-y-2">{s.fillers.top.map((f) => (
                <li key={f.word} className="grid grid-cols-[5rem_1fr_2rem] items-center gap-3">
                  <span className="font-medium">“{f.word}”</span>
                  <span className="h-2 rounded-full bg-muted"><span className="block h-2 rounded-full" style={{ width: `${(f.count / s.fillers.top[0]!.count) * 100}%`, background: FILLER_COLOR }} /></span>
                  <span className="text-right tabular-nums text-muted-foreground">{f.count}</span>
                </li>))}</ul>}
          </Card>
          <Card title="Body language">
            {!d.body.measured ? <p className="text-muted-foreground">The camera coach wasn't connected.</p>
              : d.body.rows.length === 0 ? <p className="text-muted-foreground">Nothing to flag: open posture, steady, head up.</p>
              : <table className="w-full text-sm"><thead className="text-left text-muted-foreground"><tr><th className="pb-2 font-normal">Behaviour</th><th className="pb-2 text-right font-normal">Times</th><th className="pb-2 text-right font-normal">Time</th><th className="pb-2 text-right font-normal">Of talk</th></tr></thead>
                <tbody>{d.body.rows.map((r) => (
                  <tr key={r.kind} className="border-t border-border"><td className="py-2">{r.label}</td><td className="py-2 text-right tabular-nums">{r.count}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMs(r.totalMs)}</td><td className="py-2 text-right tabular-nums">{r.pct}%</td></tr>))}</tbody></table>}
          </Card>
        </div>
        <PitchAnalysis r={narrative} />
      </div>

      {s.phrases.length > 0 && (
        <details className="rounded-xl border border-border bg-card p-6">
          <summary className="cursor-pointer text-lg font-semibold">Transcript</summary>
          <ol className="mt-4 space-y-2">{s.phrases.map((p, i) => (
            <li key={i} className="grid grid-cols-[3.5rem_1fr] gap-3"><span className="font-mono text-xs leading-6 text-muted-foreground">{fmtMs(p.tMs)}</span><span><Highlight text={p.text} fillers={p.fillers} /></span></li>))}</ol>
        </details>
      )}
    </section>
  );
}

/** The reporter's analysis, short: the dashboard already shows the numbers, the fillers and the body table. */
function PitchAnalysis({ r }: { r: Reply<RunNarrative> }) {
  const n = r.report;
  if (!n) return r.status === "none" || r.status === "error" ? null : <Writing what="your pitch" />;
  return (
    <section className="rounded-xl border border-primary/40 bg-card p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Coach's analysis</h2>
        <span className="font-mono text-xs text-muted-foreground">{n.source === "llm" ? "written by the reporter" : "from the measurements"}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold leading-snug">{n.headline}</p>
      <p className="mt-2 text-muted-foreground">{n.summary}</p>
      {n.improvements.length > 0 && (
        <ol className="mt-5 space-y-3">{n.improvements.slice(0, 3).map((m, i) => (
          <li key={i} className="rounded-lg border border-border p-4">
            <p className="font-medium"><span className="mr-2 font-mono text-primary">{i + 1}</span>{m.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{m.why}</p>
            <p className="mt-2 text-sm"><span className="font-medium text-emerald-400">Try: </span>{m.drill}</p>
          </li>))}</ol>
      )}
      {n.strengths.length > 0 && (
        <div className="mt-5">
          <p className="text-sm text-muted-foreground">Went well</p>
          <ul className="mt-1 space-y-1">{n.strengths.slice(0, 4).map((x, i) => <li key={i}><span aria-hidden className="mr-2 text-emerald-400">✓</span>{x.text}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, unit, note }: { label: string; value: string; unit?: string | undefined; note: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-4xl font-semibold tabular-nums">{value}{unit && <span className="ml-1 text-lg font-normal text-muted-foreground">{unit}</span>}</p>
      <p className="mt-1 text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-border bg-card p-6"><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;
}

function Highlight({ text, fillers }: { text: string; fillers: string[] }) {
  if (!fillers.length) return <>{text}</>;
  const set = new Set(fillers.map((f) => f.toLowerCase()));
  return <>{text.split(/(\s+)/).map((w, i) => set.has(w.toLowerCase().replace(/[^\p{L}']/gu, ""))
    ? <mark key={i} className="rounded px-0.5 text-black" style={{ background: FILLER_COLOR }}>{w}</mark> : w)}</>;
}

/** One time axis for the talk: filler words as dots, each camera behaviour as a lane of episodes. */
function Timeline({ d }: { d: PitchDashboard }) {
  const total = Math.max(d.durationMs, 1000);
  const x = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
  // at most 8 ticks: 0:00, 0:05 … for a short talk, minutes for a long one
  const step = [1000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000].find((s) => total / s <= 8) ?? 600_000;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  const lanes = [
    ...(d.speech.measured ? [{ key: "fillers", label: "Filler words", content: d.speech.fillers.at.map((f, i) => (
      <span key={i} title={`${fmtMs(f.tMs)} · ${f.words.join(", ")}`} className="absolute top-1/2 -ml-[7px] -mt-[7px] h-[14px] w-[14px] rounded-full ring-2 ring-card"
        style={{ left: x(f.tMs), background: FILLER_COLOR }} />)) }] : []),
    ...d.body.rows.map((r) => ({ key: r.kind, label: r.label, content: r.episodes.map((e, i) => (
      <span key={i} title={`${r.label} · ${fmtMs(e.fromMs)}–${fmtMs(e.toMs)} (${Math.max(1, Math.round((e.toMs - e.fromMs) / 1000))} s)`}
        className="absolute top-1/2 -mt-[6px] h-3 min-w-[6px] rounded-[4px]" style={{ left: x(e.fromMs), width: `calc(${x(e.toMs)} - ${x(e.fromMs)} - 2px)`, background: BODY_COLOR }} />)) })),
  ];
  return (
    <Card title="Timeline">
      {lanes.length === 0 ? <p className="text-muted-foreground">Nothing measured yet.</p> : (
        <div className="grid grid-cols-[9rem_1fr] gap-x-4">
          {lanes.map((l) => (
            <div key={l.key} className="contents">
              <span className="py-2 text-sm text-muted-foreground">{l.label}</span>
              <div className="relative my-1 h-7 border-b border-border/50">{l.content}</div>
            </div>
          ))}
          <span />
          <div className="relative mt-1 h-5 font-mono text-xs text-muted-foreground">
            {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: x(t) }}>{fmtMs(t)}</span>)}
          </div>
        </div>
      )}
    </Card>
  );
}
