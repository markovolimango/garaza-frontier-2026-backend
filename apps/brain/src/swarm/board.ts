/**
 * SwarmBoard: the blackboard the agent swarm shares. JJ leads; the other agents are peers that read
 * and write the board and never call each other directly:
 *
 *   listener  (Gemini Live, audio)  → `phrase` events: what the presenter said, verbatim, with fillers
 *   director  (LLM)                 → judges' questions/reactions; obeys `director.brief` commands
 *   body      (camera coach + LLM)  → `video.note` events about movements seen on the recording
 *   reporter  (LLM)                 → `report.ready` once a run / session report JSON is built
 *   feedback  (rules)               → the only one that turns the vignette on (fillers, body)
 *   jj        (Gemini Live, voice)  → issues `command`s through its tools; hears `agent.note`s
 *
 * Every agent reports its state (`status`), shown live on the stage (`swarm.activity` downlink).
 * Commands carry JJ's (or the operator's) intent; the latest of each kind is kept (`latest`).
 * Board data per run lives in memory and in SESSION_DIR/<sessionId>/swarm.json (index.ts saves it),
 * so a full reset (which deletes that folder) erases it.
 */
import type { BehaviorKind, JudgeId, RunId } from "@coach/protocol";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";

export const AGENT_IDS = ["jj", "listener", "director", "body", "reporter", "feedback"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type AgentState = "off" | "idle" | "listening" | "watching" | "thinking" | "working" | "speaking" | "error";
export interface AgentStatus { id: AgentId; state: AgentState; detail: string; at: number }

export const AGENT_LABELS: Record<AgentId, string> = {
  jj: "JJ · coach", listener: "Listener · transcript + fillers", director: "Director · judges",
  body: "Body · camera", reporter: "Reporter · report", feedback: "Feedback · vignette",
};

/** One phrase the presenter said (listener). Times are brain clock ms. */
export interface Phrase {
  runId: RunId; segment: "presentation" | "qa"; text: string; fillers: string[];
  startAt: number; endAt: number; slideIndex: number;
}
/** A line or reaction of a judge (director). */
export interface JudgeLine {
  runId: RunId; judgeId: JudgeId; kind: "question" | "followup" | "closing" | "reaction"; text: string; at: number;
}
/** Something the body agent saw on a run's recording. `atMs` from the run start (recording time). */
export interface VideoNote { runId: RunId; kind: BehaviorKind | null; atMs: number; durationMs?: number; text: string }

export type Strictness = "kind" | "neutral" | "tough";
export type SwarmCommand =
  /** JJ → director: how the judges should behave in the next Q&A. */
  | { type: "director.brief"; strictness?: Strictness; perJudge?: Partial<Record<JudgeId, Strictness>>; focus?: string[];
      questions?: number; followUps?: boolean; interrupts?: boolean; note?: string }
  /** JJ → feedback: what may turn the vignette on during runs. */
  | { type: "feedback.policy"; fillers: "off" | "burst" | "every"; body: "off" | "targets" | "all" }
  /** JJ → reporter: build a report now. */
  | { type: "report.make"; scope: "run" | "session"; runId?: RunId; focus?: string };
export type SwarmCommandType = SwarmCommand["type"];

export type SwarmEvent =
  | { type: "phrase"; phrase: Phrase }
  | { type: "filler"; runId: RunId; words: string[]; at: number }
  | { type: "judge.line"; line: JudgeLine }
  | { type: "video.note"; note: VideoNote }
  | { type: "report.ready"; scope: "run" | "session"; runId?: RunId }
  /** An agent tells JJ something (JJ hears it as "[DIRECTOR] …" in its context). */
  | { type: "agent.note"; from: AgentId; text: string; speak?: boolean };
export type SwarmEventType = SwarmEvent["type"];

export interface BoardData {
  phrases: Phrase[]; judgeLines: JudgeLine[]; videoNotes: VideoNote[];
  reports: { runs: Record<string, unknown>; session: unknown | null };
  commands: Partial<Record<SwarmCommandType, SwarmCommand>>;
}
const emptyData = (): BoardData => ({ phrases: [], judgeLines: [], videoNotes: [], reports: { runs: {}, session: null }, commands: {} });

export class SwarmBoard {
  private data: BoardData = emptyData();
  private readonly statuses = new Map<AgentId, AgentStatus>();
  private readonly statusFns: ((all: AgentStatus[]) => void)[] = [];
  private readonly changeFns: (() => void)[] = [];
  private readonly eventFns = new Map<SwarmEventType, ((e: SwarmEvent) => void)[]>();
  private readonly commandFns = new Map<SwarmCommandType, ((c: SwarmCommand) => void)[]>();
  private readonly log: Logger;

  constructor(private readonly o: { clock: Clock; log?: Logger }) {
    this.log = o.log ?? (() => {});
    for (const id of AGENT_IDS) this.statuses.set(id, { id, state: "off", detail: "", at: o.clock.now() });
  }

  // ---------------- status (the agents panel) ----------------
  status(id: AgentId, state: AgentState, detail = ""): void {
    const prev = this.statuses.get(id);
    if (prev && prev.state === state && prev.detail === detail) return;
    this.statuses.set(id, { id, state, detail: detail.slice(0, 160), at: this.o.clock.now() });
    const all = this.allStatuses();
    for (const fn of this.statusFns) fn(all);
  }
  allStatuses(): AgentStatus[] { return AGENT_IDS.map((id) => this.statuses.get(id)!); }
  onStatus(fn: (all: AgentStatus[]) => void): void { this.statusFns.push(fn); }

  // ---------------- events ----------------
  emit(e: SwarmEvent): void {
    switch (e.type) {
      case "phrase": this.data.phrases.push(e.phrase); break;
      case "judge.line": this.data.judgeLines.push(e.line); break;
      case "video.note": this.data.videoNotes.push(e.note); break;
    }
    for (const fn of this.eventFns.get(e.type) ?? []) {
      try { fn(e); } catch (err) { this.log("error", "swarm.event_handler_failed", { type: e.type, err: String(err) }); }
    }
    if (e.type !== "agent.note" && e.type !== "filler") this.changed();
  }
  on<T extends SwarmEventType>(type: T, fn: (e: Extract<SwarmEvent, { type: T }>) => void): void {
    const list = this.eventFns.get(type) ?? [];
    list.push(fn as (e: SwarmEvent) => void);
    this.eventFns.set(type, list);
  }
  /** Shorthand for an `agent.note` to JJ. */
  note(from: AgentId, text: string, speak = false): void { this.emit({ type: "agent.note", from, text, speak }); }

  // ---------------- commands (JJ's intent) ----------------
  command(c: SwarmCommand): void {
    this.data.commands[c.type] = c;
    this.log("info", "swarm.command", { ...c });
    for (const fn of this.commandFns.get(c.type) ?? []) {
      try { fn(c); } catch (err) { this.log("error", "swarm.command_handler_failed", { type: c.type, err: String(err) }); }
    }
    this.changed();
  }
  onCommand<T extends SwarmCommandType>(type: T, fn: (c: Extract<SwarmCommand, { type: T }>) => void): void {
    const list = this.commandFns.get(type) ?? [];
    list.push(fn as (c: SwarmCommand) => void);
    this.commandFns.set(type, list);
  }
  latest<T extends SwarmCommandType>(type: T): Extract<SwarmCommand, { type: T }> | null {
    return (this.data.commands[type] as Extract<SwarmCommand, { type: T }> | undefined) ?? null;
  }

  // ---------------- reads ----------------
  phrases(runId?: RunId, segment?: Phrase["segment"]): Phrase[] {
    return this.data.phrases.filter((p) => (!runId || p.runId === runId) && (!segment || p.segment === segment));
  }
  judgeLines(runId?: RunId): JudgeLine[] { return this.data.judgeLines.filter((l) => !runId || l.runId === runId); }
  videoNotes(runId?: RunId): VideoNote[] { return this.data.videoNotes.filter((n) => !runId || n.runId === runId); }
  /** Transcript of a run (or one segment) as plain text, one phrase per line. */
  transcript(runId: RunId, segment?: Phrase["segment"]): string { return this.phrases(runId, segment).map((p) => p.text).join("\n"); }

  // ---------------- reports (reporter's JSON) ----------------
  setRunReport(runId: RunId, report: unknown): void { this.data.reports.runs[runId] = report; this.changed(); }
  runReport(runId: RunId): unknown | null { return this.data.reports.runs[runId] ?? null; }
  setSessionReport(report: unknown): void { this.data.reports.session = report; this.changed(); }
  sessionReport(): unknown | null { return this.data.reports.session; }

  // ---------------- persistence ----------------
  onChanged(fn: () => void): void { this.changeFns.push(fn); }
  private changed(): void { for (const fn of this.changeFns) fn(); }
  toJSON(): BoardData { return this.data; }
  restore(d: Partial<BoardData> | null): void { this.data = { ...emptyData(), ...(d ?? {}) }; }
  clear(): void { this.data = emptyData(); this.changed(); }
}
