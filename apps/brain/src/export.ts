/**
 * Session report export: one self-contained, printable HTML page (open it, print to PDF, or send
 * the file) with what the presenter practised and how it changed, run by run.
 *
 *   GET /api/session/export.html              → the page (inline)
 *   GET /api/session/export.html?download=1   → the same page as a file download
 *
 * Measured behaviour only. The presenter's personal goals (brief.presenterGoals) are never in it:
 * they stay in the session and a reset erases them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionState } from "@coach/protocol";
import { buildDigest } from "./digest.ts";
import { buildProgress } from "./progress.ts";
import type { RunLog, RunRecord } from "./runlog.ts";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mmss = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const MODE = { baseline: "Baseline", training: "Training", test: "Test (no feedback)" } as const;

export function buildExportHtml(s: Readonly<SessionState>, records: RunRecord[], now: number): string {
  const p = buildProgress(records, s);
  const runs = records.filter((r) => r.run.phase === "ended").sort((a, b) => a.run.index - b.run.index);
  const brief = s.context.brief;
  const title = brief?.title ? `Presentation practice: ${brief.title}` : "Presentation practice report";
  const totalMs = p.runs.reduce((n, r) => n + r.presentationMs + r.qaMs, 0);
  const date = new Date(now).toISOString().slice(0, 10);

  const cell = (row: (typeof p.rows)[number], i: number) => {
    const c = row.counts[i];
    if (c === null || c === undefined) return `<td class="na">not measured</td>`;
    const extra = [row.perMin?.[i] != null ? `${row.perMin[i]}/min` : "", row.timePct?.[i] != null ? `${row.timePct[i]}% of time` : ""].filter(Boolean).join(" · ");
    return `<td><b>${c}×</b>${extra ? `<br><small>${esc(extra)}</small>` : ""}</td>`;
  };
  const progressTable = p.rows.length === 0 ? `<p class="muted">Nothing was flagged in any measured run.</p>` : `
    <table>
      <thead><tr><th>Behaviour</th>${p.runs.map((r) => `<th>Run ${r.index}<br><small>${esc(MODE[r.mode])} · ${mmss(r.presentationMs + r.qaMs)}</small></th>`).join("")}<th>Trend</th></tr></thead>
      <tbody>${p.rows.map((row) => `<tr><td>${esc(row.label)}${row.isTarget ? ` <span class="tag">target${row.status === "fixed" ? " · fixed" : ""}</span>` : ""}</td>${p.runs.map((_, i) => cell(row, i)).join("")}<td>${row.trend === "better" ? "better ↓" : row.trend === "worse" ? "worse ↑" : "same"}</td></tr>`).join("")}</tbody>
    </table>`;

  const runSections = runs.map((rec) => {
    const d = buildDigest(rec, null);
    const moments = d.observations.flatMap((o) => o.examples.slice(0, o.time ? 3 : 1).map((e) => ({ o, e }))).sort((a, b) => a.e.tRunMs - b.e.tRunMs).slice(0, 8);
    return `
    <section class="run">
      <h3>Run ${d.index} · ${esc(MODE[d.mode])} · ${mmss(d.durations.presentationMs + d.durations.qaMs)}</h3>
      ${d.targets.length ? `<p>Working on: ${d.targets.map((t) => esc(t.replace(/_/g, " "))).join(", ")}</p>` : ""}
      ${!d.sources.coach ? `<p class="muted">The camera coach was not connected in this run.</p>`
        : moments.length ? `<ul>${moments.map(({ o, e }) => `<li>${mmss(e.tRunMs)}, ${e.segment === "qa" ? "Q&amp;A" : `slide ${e.slideIndex + 1}`}: ${esc(o.label)}${e.durationMs ? ` (${Math.round(e.durationMs / 1000)} s)` : ""}</li>`).join("")}</ul>`
        : `<p>Nothing flagged: a clean run.</p>`}
      ${d.strengths.length ? `<p class="muted">Went well: ${d.strengths.map(esc).join(" · ")}</p>` : ""}
    </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; } h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .25rem; } .muted, small { color: #666; } .na { color: #999; }
  .headline { font-size: 1.15rem; background: #f3f6ff; border: 1px solid #d5ddf5; border-radius: 8px; padding: .75rem 1rem; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid #eee; }
  .tag { font-size: .75rem; border: 1px solid #8aa0e6; border-radius: 999px; padding: 0 .4rem; color: #3352b8; }
  .note { margin-top: 2.5rem; font-size: .85rem; color: #666; } @media print { body { margin: 0 auto; } }
</style></head><body>
  <h1>${esc(title)}</h1>
  <p class="muted">${esc(date)}${brief?.audience ? ` · Audience: ${esc(brief.audience)}` : ""}${brief?.setting ? ` · ${esc(brief.setting)}` : ""} · ${p.runs.length} run${p.runs.length === 1 ? "" : "s"}, ${mmss(totalMs)} of practice</p>
  ${p.headline ? `<p class="headline">${esc(p.headline)}</p>` : ""}
  <h2>Progress, run by run</h2>
  ${p.runs.length ? progressTable : `<p class="muted">No finished run yet.</p>`}
  ${p.coach.recommendation ? `<p><b>Coach:</b> ${esc(p.coach.recommendation.reason)}</p>` : ""}
  <h2>Runs</h2>
  ${runSections || `<p class="muted">No finished run yet.</p>`}
  <p class="note">Measured behaviour only (camera and microphone heuristics, not validated norms); it says what the
  presenter did, not how they felt. Counts per minute make runs of different length comparable. Personal notes from
  the practice session are not included. Recordings, if any, stay on the practice computer.</p>
</body></html>`;
}

/** HTTP route for the createBrain `http` option. */
export function exportHttp(log: RunLog, session: () => Readonly<SessionState>, now: () => number = Date.now) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const [path, query = ""] = (req.url ?? "/").split("?");
    if (req.method !== "GET" || path !== "/api/session/export.html") return false;
    const s = session();
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (new URLSearchParams(query).get("download") === "1") {
      const name = (s.context.brief?.title ?? "practice").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "practice";
      headers["content-disposition"] = `attachment; filename="report-${name}.html"`;
    }
    res.writeHead(200, headers);
    res.end(buildExportHtml(s, log.list(), now()));
    return true;
  };
}
