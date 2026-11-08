/**
 * Orchestrator: JJ leads the swarm.
 *
 *   JJ → agents: JJ's swarm tools (jj/tools.ts `createSwarmTools`: direct_judges, set_feedback_policy,
 *     make_report, ask_agent), registered here on the brain's ToolRegistry, issue board commands
 *     (`director.brief` merged with the latest, `feedback.policy`, `report.make`); `ask_agent` answers
 *     at once from the board (no LLM): filler counts, the judges' brief and lines, video notes, report.
 *   agents → JJ: board `agent.note`s reach JJ's live context as "[DIRECTOR] …" system notes
 *     (JJEngine.agentNote: held during runs and while JJ talks, delivered with the debrief).
 *   JJ's own row on the agents panel follows `jj.state` (speaking / listening / idle / off).
 */
import type { RunId } from "@coach/protocol";
import { mmss } from "../format.ts";
import { behaviorCounts } from "../runlog.ts";
import { agentNoteText } from "../jj/messages.ts";
import { briefSummary, createSwarmTools, type AskableAgent } from "../jj/tools.ts";
import type { AgentId, AgentStatus } from "./board.ts";
import type { SwarmContext } from "./context.ts";

/** How long JJ's row shows what it just told an agent before going back to its state. */
const COMMAND_DETAIL_MS = 8000;

export function installOrchestrator(ctx: SwarmContext): void {
  const { board, brain } = ctx;
  const status = (id: AgentId): Pick<AgentStatus, "state" | "detail"> => {
    const st = board.allStatuses().find((a) => a.id === id)!;
    return { state: st.state, detail: st.detail };
  };
  /** The run JJ talks about: the current one, else the last finished one. */
  const focusRun = (): { runId: RunId | null; index: number | null } => {
    const s = brain.session.get();
    const runId = (s.run?.runId ?? s.completedRuns.at(-1) ?? null) as RunId | null;
    const rec = runId ? ctx.runLog.get(runId) : null;
    return { runId, index: rec?.run.index ?? (s.run?.runId === runId ? s.run?.index ?? null : null) };
  };

  // ---------------- ask_agent: facts from the board ----------------
  const facts = (agent: AskableAgent, question?: string): Record<string, unknown> => {
    const { runId, index } = focusRun();
    ctx.log("info", "swarm.ask", { agent, question: question?.slice(0, 120) ?? null, runId });
    const base = { run: index, status: status(agent) };
    if (!runId && agent !== "director") return { ...base, note: "no run yet" };
    switch (agent) {
      case "listener": {
        const phrases = board.phrases(runId!);
        const words = phrases.flatMap((p) => p.fillers.map((f) => f.toLowerCase().trim()).filter(Boolean));
        const tally = new Map<string, number>();
        for (const w of words) tally.set(w, (tally.get(w) ?? 0) + 1);
        const spanMs = phrases.length ? phrases.at(-1)!.endAt - phrases[0]!.startAt : 0;
        const rec = ctx.runLog.get(runId!);
        const bursts = rec ? behaviorCounts(rec).get("filler_burst") ?? 0 : null;
        return {
          ...base,
          filler_count: words.length,
          top_fillers: [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word, count]) => ({ word, count })),
          ...(spanMs >= 30_000 ? { fillers_per_min: Math.round((words.length / (spanMs / 60_000)) * 10) / 10 } : {}),
          phrases: phrases.length,
          fillers_by_segment: {
            presentation: phrases.filter((p) => p.segment === "presentation").reduce((n, p) => n + p.fillers.length, 0),
            qa: phrases.filter((p) => p.segment === "qa").reduce((n, p) => n + p.fillers.length, 0),
          },
          last_phrases: phrases.slice(-3).map((p) => p.text),
          ...(bursts !== null ? { filler_bursts_measured: bursts } : {}),
          ...(phrases.length ? {} : { note: "no transcript from the listener for this run" }),
        };
      }
      case "director": {
        const brief = board.latest("director.brief");
        const titles = new Map(brain.session.get().scene.judges.map((j) => [j.id as string, j.title]));
        const lines = runId ? board.judgeLines(runId) : [];
        return {
          ...base,
          brief: brief ? briefSummary(brief) : "none: the judges follow the panel as set",
          panel: brain.session.get().scene.judges.map((j) => ({ id: j.id, title: j.title, toughness: j.toughness })),
          judge_lines: lines.slice(-8).map((l) => ({ judge: titles.get(l.judgeId) ?? l.judgeId, kind: l.kind, text: l.text })),
          questions_asked: lines.filter((l) => l.kind === "question" || l.kind === "followup").length,
        };
      }
      case "body": {
        const notes = board.videoNotes(runId!);
        const rec = ctx.runLog.get(runId!);
        return {
          ...base,
          video_notes: notes.slice(-8).map((n) => ({ at: mmss(n.atMs), kind: n.kind, text: n.text })),
          episodes: rec ? Object.fromEntries(behaviorCounts(rec)) : {},
          camera: rec ? (rec.coachConnected ? "on" : "off during this run") : "unknown",
        };
      }
      case "reporter": {
        const report = board.runReport(runId!) as Record<string, unknown> | null;
        const session = board.sessionReport() as Record<string, unknown> | null;
        const headline = [report?.["headline"], report?.["summary"], session?.["headline"]].find((h) => typeof h === "string") ?? null;
        return { ...base, run_report: report ? "ready" : "not yet", session_report: session ? "ready" : "not yet", headline };
      }
    }
  };

  // ---------------- JJ → agents: the tools ----------------
  let commandUntil = 0;
  let commandDetail = "";
  let refresh: unknown = null;
  createSwarmTools({
    session: brain.session,
    swarm: { command: (c) => board.command(c), latest: (t) => board.latest(t), facts },
    onCommand: (agent, summary) => {
      commandDetail = `→ ${agent}: ${summary}`;
      commandUntil = ctx.clock.now() + COMMAND_DETAIL_MS;
      jjStatus();
      if (refresh) ctx.clock.clearTimeout(refresh);
      refresh = ctx.clock.setTimeout(() => { refresh = null; jjStatus(); }, COMMAND_DETAIL_MS + 50);
    },
  }, brain.tools);

  // ---------------- agents → JJ ----------------
  board.on("agent.note", (e) => {
    if (e.from === "jj") return;
    brain.jj.agentNote(agentNoteText(e.from, e.text), e.speak === true);
    jjStatus();
  });

  // ---------------- JJ's row on the agents panel ----------------
  const jjStatus = () => {
    const st = brain.jj.status();
    const phase = brain.session.get().phase;
    const pending = brain.jj.pendingNotes();
    const notes = pending ? ` · ${pending} note${pending === 1 ? "" : "s"} for the debrief` : "";
    if (ctx.clock.now() < commandUntil) { board.status("jj", st.speaking ? "speaking" : "working", commandDetail); return; }
    if (!st.connected) board.status("jj", "off", phase === "setup" ? "waiting for the session" : "reconnecting");
    else if (st.speaking) board.status("jj", "speaking", "talking to you");
    else if (st.listening) board.status("jj", "listening", `your turn: JJ hears you${notes}`);
    else board.status("jj", "idle", phase === "running" ? `quiet during the run${notes}` : `ready${notes}`);
  };
  brain.hub.onOutbound((m) => { if (m.type === "jj.state") jjStatus(); });
  brain.session.subscribe(() => jjStatus());
  jjStatus();
}
