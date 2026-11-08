/**
 * The reporter's printable session report: one self-contained HTML page (session narrative, the
 * progress table, each run's highlights) and its PDF, rendered with playwright-core + a local Chrome.
 * Same rule as export.ts: measured behaviour and the coach's words only, never the presenter's
 * personal goals.
 */
import { existsSync } from "node:fs";
import type { RunNarrative, SessionNarrative, SessionState } from "@coach/protocol";
import { buildProgress } from "../progress.ts";
import type { RunRecord } from "../runlog.ts";
import { mmss } from "./reportData.ts";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Fillers marked [[um]] → highlighted. */
const marked = (s: string) => esc(s).replace(/\[\[(.+?)\]\]/g, '<mark>$1</mark>');
const MODE = { baseline: "Baseline", training: "Training", test: "Test" } as const;
const VERDICT: Record<RunNarrative["qa"][number]["verdict"], string> = { strong: "strong", ok: "ok", weak: "weak", "no answer": "no answer" };

export function buildReportHtml(o: { s: Readonly<SessionState>; records: RunRecord[]; session: SessionNarrative; runs: RunNarrative[]; now: number }): string {
  const { s, session: n } = o;
  const p = buildProgress(o.records, s);
  const brief = s.context.brief;
  const title = brief?.title ? `Presentation practice: ${brief.title}` : "Presentation practice report";
  const totalMs = p.runs.reduce((t, r) => t + r.presentationMs + r.qaMs, 0);
  const date = new Date(o.now).toISOString().slice(0, 10);

  const table = p.rows.length && p.runs.length ? `
    <table>
      <thead><tr><th>Behaviour</th>${p.runs.map((r) => `<th>Run ${r.index}<br><small>${esc(MODE[r.mode])} · ${mmss(r.presentationMs + r.qaMs)}</small></th>`).join("")}<th>Trend</th></tr></thead>
      <tbody>${p.rows.map((row) => `<tr><td>${esc(row.label)}${row.isTarget ? ` <span class="tag">target${row.status === "fixed" ? " · fixed" : ""}</span>` : ""}</td>${
        p.runs.map((_, i) => { const c = row.counts[i]; return c == null ? `<td class="na">—</td>` : `<td><b>${c}×</b>${row.perMin?.[i] != null ? `<br><small>${row.perMin[i]}/min</small>` : ""}</td>`; }).join("")
      }<td class="trend ${row.trend}">${row.trend === "better" ? "↓ better" : row.trend === "worse" ? "↑ worse" : "→ same"}</td></tr>`).join("")}</tbody>
    </table>` : "";

  const runCard = (r: RunNarrative) => `
    <section class="run">
      <h3>Run ${r.index}</h3>
      <p class="rh">${esc(r.headline)}</p>
      <p>${esc(r.summary)}</p>
      ${r.improvements.length ? `<h4>To improve</h4><ol>${r.improvements.map((x) => `<li><b>${esc(x.title)}</b> · ${esc(x.why)}${x.evidence ? `<br><span class="ev">${marked(x.evidence)}</span>` : ""}${x.drill ? `<br><span class="drill">Drill: ${esc(x.drill)}</span>` : ""}</li>`).join("")}</ol>` : ""}
      ${r.strengths.length ? `<h4>Went well</h4><ul class="ok">${r.strengths.map((x) => `<li>${esc(x.text)}${x.evidence ? ` <span class="ev">(${marked(x.evidence)})</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${r.fillers.measured ? `<p class="kv"><b>Filler words:</b> ${r.fillers.count} (${r.fillers.perMin}/min)${r.fillers.top.length ? ` · ${r.fillers.top.slice(0, 4).map((t) => `“${esc(t.word)}” ${t.count}×`).join(", ")}` : ""}</p>` : ""}
      ${r.qa.length ? `<h4>Q&amp;A</h4><table class="qa">${r.qa.map((q) => `<tr><td class="v ${q.verdict.replace(" ", "-")}">${VERDICT[q.verdict]}</td><td><small>${esc(q.judge)}</small><br><b>${esc(q.question)}</b><br>${esc(q.answerSummary)}<br><span class="drill">${esc(q.tip)}</span></td></tr>`).join("")}</table>` : ""}
      ${r.body.length ? `<h4>Body</h4><ul>${r.body.map((b) => `<li><b>${esc(b.kind)}</b> ${b.count}× · ${esc(b.note)}</li>`).join("")}</ul>` : ""}
    </section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; --ink: #16181d; --muted: #5f6673; --line: #e3e6ec; --accent: #3d5afe; --soft: #f2f4ff; --good: #12805c; --bad: #b4511f; }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--ink); background: #fff; max-width: 52rem; margin: 0 auto; padding: 2rem 1.5rem; }
  header { border-bottom: 3px solid var(--accent); padding-bottom: .75rem; margin-bottom: 1.25rem; }
  .eyebrow { font: 600 11px/1 ui-monospace, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
  h1 { font-size: 1.75rem; margin: .35rem 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.1rem; margin: 1.75rem 0 .6rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.05rem; margin: 0 0 .25rem; } h4 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: .9rem 0 .3rem; }
  .muted, small { color: var(--muted); } .na { color: #aab; }
  .headline { font-size: 1.3rem; font-weight: 600; background: var(--soft); border-left: 5px solid var(--accent); border-radius: 6px; padding: .8rem 1rem; margin: 0 0 .75rem; }
  .focus { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: .75rem .85rem; break-inside: avoid; }
  .card .n { font: 700 1.4rem/1 ui-monospace, Menlo, monospace; color: var(--accent); }
  .card b { display: block; margin: .25rem 0; } .drill { color: var(--good); }
  ul, ol { margin: .25rem 0; padding-left: 1.2rem; } li { margin: .2rem 0; }
  ul.ok li::marker { content: "✓  "; color: var(--good); }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
  th { font-size: .8rem; } .tag { font-size: .7rem; border: 1px solid #8aa0e6; border-radius: 999px; padding: 0 .4rem; color: #3352b8; }
  .trend.better { color: var(--good); } .trend.worse { color: var(--bad); }
  .run { border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; margin: .9rem 0; break-inside: avoid-page; }
  .rh { font-weight: 600; font-size: 1.05rem; margin: 0 0 .35rem; } .ev { color: var(--muted); font-style: italic; } .kv { margin: .5rem 0; }
  mark { background: #ffe58a; padding: 0 2px; border-radius: 3px; }
  table.qa td.v { width: 5.5rem; font: 700 .72rem/1.4 ui-monospace, Menlo, monospace; text-transform: uppercase; }
  .v.strong { color: var(--good); } .v.ok { color: #3352b8; } .v.weak, .v.no-answer { color: var(--bad); }
  .note { margin-top: 2rem; font-size: .78rem; color: var(--muted); }
  @page { size: A4; margin: 14mm 12mm; } @media print { body { padding: 0; } }
</style></head><body>
  <header>
    <div class="eyebrow">Coach's report${n.source === "fallback" ? " · from the measurements" : ""}</div>
    <h1>${esc(title)}</h1>
    <div class="muted">${esc(date)}${brief?.audience ? ` · Audience: ${esc(brief.audience)}` : ""} · ${p.runs.length} run${p.runs.length === 1 ? "" : "s"}, ${mmss(totalMs)} of practice</div>
  </header>
  <p class="headline">${esc(n.headline)}</p>
  <p>${esc(n.summary)}</p>
  ${n.focus.length ? `<h2>Focus next</h2><div class="focus">${n.focus.map((f, i) => `<div class="card"><span class="n">${i + 1}</span><b>${esc(f.title)}</b><span class="muted">${esc(f.why)}</span><p class="drill">Drill: ${esc(f.drill)}</p></div>`).join("")}</div>` : ""}
  ${n.progress.length ? `<h2>Progress, first run → last</h2><ul>${n.progress.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
  ${table}
  ${n.strengths.length ? `<h2>What went well</h2><ul class="ok">${n.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  <h2>Run by run</h2>
  ${o.runs.length ? o.runs.map(runCard).join("") : `<p class="muted">No finished run yet.</p>`}
  <p class="note">Measured behaviour (camera and microphone heuristics, not validated norms) and an AI coach's reading of the transcript;
  it says what the presenter did, not how they felt. Personal notes from the practice session are not included.
  Recordings, if any, stay on the practice computer.</p>
</body></html>`;
}

const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
];
/** CHROME env, else a usual install path; null = none found. */
export function findChrome(): string | null {
  const env = process.env.CHROME;
  if (env && existsSync(env)) return env;
  return CHROMES.find((p) => existsSync(p)) ?? null;
}

/** HTML → A4 PDF with a headless Chrome (playwright-core). */
export async function renderPdf(html: string, chromePath: string): Promise<Buffer> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  } finally {
    await browser.close().catch(() => {});
  }
}
