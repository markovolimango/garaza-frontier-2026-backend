/**
 * Body agent: the camera's eye in the swarm.
 *
 * Live: keeps its status current from the RunLog (episodes, observations) and the sensor role
 *   (services/coach bridge): "off · no camera", "watching · crossed arms now · 2 episodes so far".
 * After a run (RunLog.onRunEnded): when the run has a recording (media.ts), a key and
 *   SWARM_VIDEO_ANALYSIS=1, Gemini (ctx.models.video) watches the recording (Files API: uploaded,
 *   asked once, deleted right after) and writes one sentence per body episode (≤ 8, the longest) plus
 *   ≤ 3 things it noticed by itself → board `video.note`s + one "[BODY] …" note to JJ (who can offer
 *   `show_moments`). Without a key, a recording or Gemini: deterministic notes from the episodes.
 * Times: the model sees recording time (0 = recording.startedAt); `VideoNote.atMs` is from the run
 *   start (presentationStartedAt, the digest's tRunMs), so "1:20" means the same everywhere.
 * The vignette for body behaviours is the bridge's job, not this agent's.
 */
import { existsSync, statSync } from "node:fs";
import { SENSOR_BEHAVIORS, type BehaviorKind, type RunId } from "@coach/protocol";
import type { Recording } from "../media.ts";
import { BEHAVIOR_WORDS } from "../observedCoach.ts";
import type { EpisodeRecord, RunRecord } from "../runlog.ts";
import type { VideoNote } from "./board.ts";
import type { SwarmContext } from "./context.ts";
import { geminiVideoClient, type VideoClient, type VideoFile } from "./bodyVideo.ts";

/** The camera's behaviours (the sensor role's `behavior` kinds). */
const isBodyKind = (k: unknown): k is (typeof SENSOR_BEHAVIORS)[number] => (SENSOR_BEHAVIORS as readonly unknown[]).includes(k);
const words = (k: BehaviorKind | null) => (k ? BEHAVIOR_WORDS[k] : "body language");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const secs = (ms: number) => Math.max(1, Math.round(ms / 1000));

export interface BodyOptions {
  /** The video client for a key (tests inject a fake). Default: Gemini Files API. */
  client?: (apiKey: string) => VideoClient;
  /** SWARM_VIDEO_ANALYSIS: send recordings to Gemini at all. Default: env, "1". */
  enabled?: boolean;
  /** How long to wait for the stage to finish the recording after the run ended. */
  waitDoneMs?: number;
  pollMs?: number;
  maxEpisodes?: number;
  /** Upload processing and the answer, each. */
  activeTimeoutMs?: number;
  askTimeoutMs?: number;
}

export function videoAnalysisEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SWARM_VIDEO_ANALYSIS ?? "1").trim() !== "0";
}

export interface Found { notes: VideoNote[]; extras: VideoNote[]; source: "gemini" | "episodes" }

export function installBody(ctx: SwarmContext, opts: BodyOptions = {}): void {
  const o = {
    client: opts.client ?? geminiVideoClient, enabled: opts.enabled ?? videoAnalysisEnabled(),
    waitDoneMs: opts.waitDoneMs ?? 6_000, pollMs: opts.pollMs ?? 500, maxEpisodes: opts.maxEpisodes ?? 8,
    activeTimeoutMs: opts.activeTimeoutMs ?? 60_000, askTimeoutMs: opts.askTimeoutMs ?? 60_000,
  };
  const { board, runLog, media, clock, log } = ctx;
  const hub = ctx.brain.hub;
  let busy: string | null = null;        // analysis under way (status detail)
  let last: string | null = null;        // the latest result (idle status detail)

  // ---------------- live status ----------------
  const refresh = () => {
    const sensor = hub.connections().sensor;
    const live = runLog.live();
    if (live) {
      if (!sensor) { board.status("body", "off", "no camera"); return; }
      board.status("body", "watching", liveDetail(live));
      return;
    }
    if (busy) { board.status("body", "thinking", busy); return; }
    if (!sensor) { board.status("body", "off", last ? `no camera · ${last}` : "no camera"); return; }
    board.status("body", "idle", last ?? "camera coach ready");
  };
  runLog.onChanged(refresh);
  hub.onConnect("sensor", refresh);
  hub.onDisconnect(() => refresh());
  ctx.brain.session.subscribe((_s, cause) => { if (!Array.isArray(cause) && cause.type === "reset") { last = null; refresh(); } });
  refresh();

  // ---------------- after a run ----------------
  let queue: Promise<void> = Promise.resolve();
  runLog.onRunEnded((rec) => {
    if (rec.run.phase === "aborted") return;
    queue = queue.then(() => afterRun(rec)).catch((err) => { log("error", "swarm.body.failed", { runId: rec.runId, err: String(err) }); busy = null; refresh(); });
  });

  const sleep = (ms: number) => new Promise<void>((r) => clock.setTimeout(r, ms));

  /** The run's recording once the stage finished it (or after `waitDoneMs`); null = none. */
  async function recordingOf(runId: RunId): Promise<Recording | null> {
    const t0 = clock.now();
    let r = media.get(runId);
    while (!r?.done && clock.now() - t0 < o.waitDoneMs) {
      if (!r && clock.now() - t0 >= 1_500) break;   // no recording at all (no consent, or a very short run)
      await sleep(o.pollMs);
      r = media.get(runId);
    }
    return r && r.bytes > 0 && existsSync(media.file(runId)) ? r : null;
  }

  async function afterRun(rec: RunRecord): Promise<void> {
    const runId = rec.runId;
    busy = `${runId}: waiting for the recording`;
    refresh();
    const recording = await recordingOf(runId);
    const episodes = pickEpisodes(rec, recording, o.maxEpisodes);
    let found: Found | null = null;
    const key = ctx.models.apiKey;
    if (recording && key && o.enabled) {
      busy = `${runId}: Gemini is watching the recording`;
      refresh();
      const t0 = Date.now();
      try {
        found = await askGemini(o.client(key), rec, recording, episodes);
        log("info", "swarm.body.analyzed", { runId, ms: Date.now() - t0, notes: found.notes.length, extras: found.extras.length });
      } catch (err) {
        log("warn", "swarm.body.gemini_failed", { runId, ms: Date.now() - t0, err: String(err) });
      }
    }
    busy = null;
    if (runLog.get(runId) !== rec) { refresh(); return; }   // a reset (new session) while we were busy
    found ??= { notes: fallbackNotes(rec, episodes, recording), extras: [], source: "episodes" };
    for (const note of [...found.notes, ...found.extras].sort((a, b) => a.atMs - b.atMs)) board.emit({ type: "video.note", note });
    const jj = jjNote(rec, found, recording);
    if (jj) board.note("body", jj);
    const n = found.notes.length + found.extras.length;
    last = `${runId}: ${n} video note${n === 1 ? "" : "s"}${found.source === "gemini" ? " (Gemini)" : rec.coachConnected ? " (camera coach)" : ""}`;
    refresh();
  }

  async function askGemini(client: VideoClient, rec: RunRecord, recording: Recording, episodes: EpisodeRecord[]): Promise<Found> {
    const mimeType = recording.mimeType.split(";")[0]!.trim() || "video/webm";
    let file: VideoFile | null = null;
    try {
      file = await client.upload(media.file(rec.runId), mimeType);
      const active = await client.waitActive(file, o.activeTimeoutMs);
      const q = videoQuestion(rec, recording, episodes);
      const answer = await client.ask({ model: ctx.models.video, file: active, ...q, timeoutMs: o.askTimeoutMs });
      return readAnswer(answer, rec, recording, episodes);
    } finally {
      if (file) {
        const name = file.name;
        await client.remove(name).then(
          () => log("info", "swarm.body.deleted", { runId: rec.runId, file: name }),
          (err) => log("warn", "swarm.body.delete_failed", { runId: rec.runId, file: name, err: String(err) }));
      }
    }
  }
}

// ---------------------------------------------------------------- pure parts (exported for tests)

/** "crossed arms now · 2 episodes so far" for the run under way. */
export function liveDetail(rec: RunRecord): string {
  const open = [...new Set(rec.episodes.filter((e) => e.endAt === null).map((e) => words(e.kind)))];
  const n = rec.episodes.length;
  const body = rec.observations.filter((x) => isBodyKind(x.kind)).length;
  const parts: string[] = [];
  if (open.length) parts.push(`${open.join(" + ")} now`);
  parts.push(n ? `${n} episode${n === 1 ? "" : "s"} so far` : body ? `${body} coach note${body === 1 ? "" : "s"} so far` : "nothing so far");
  return parts.join(" · ");
}

const runStartOf = (rec: RunRecord, recording: Recording | null) => rec.run.presentationStartedAt ?? rec.run.startedAt ?? recording?.startedAt ?? 0;
const endOf = (e: EpisodeRecord, rec: RunRecord) => e.endAt ?? rec.endedAt ?? e.startAt;

/** The episodes worth a look: on the recording, the longest `max`, in time order. */
export function pickEpisodes(rec: RunRecord, recording: Recording | null, max: number): EpisodeRecord[] {
  const eps = (rec.episodes ?? []).filter((e) => !recording || endOf(e, rec) > recording.startedAt);
  return [...eps].sort((a, b) => (endOf(b, rec) - b.startAt) - (endOf(a, rec) - a.startAt)).slice(0, max).sort((a, b) => a.startAt - b.startAt);
}

/** Deterministic notes: one per episode ("Crossed arms for 7 s at 1:20 (slide 3)."). */
export function fallbackNotes(rec: RunRecord, episodes: EpisodeRecord[], recording: Recording | null): VideoNote[] {
  const start = runStartOf(rec, recording);
  return episodes.map((e) => {
    const durationMs = Math.max(0, endOf(e, rec) - e.startAt);
    const atMs = Math.max(0, e.startAt - start);
    const where = e.segment === "qa" ? "during Q&A" : `slide ${e.slideIndex + 1}`;
    return { runId: rec.runId, kind: e.kind, atMs, durationMs, text: `${cap(words(e.kind))} for ${secs(durationMs)} s at ${mmss(atMs)} (${where}).` };
  });
}

/** "crossed arms 3×, longest 7 s at 1:20" per kind, the most frequent (then longest in total) first. */
export function kindSummaries(rec: RunRecord, recording: Recording | null): { kind: BehaviorKind; text: string; longest: EpisodeRecord }[] {
  const start = runStartOf(rec, recording);
  const by = new Map<BehaviorKind, EpisodeRecord[]>();
  for (const e of rec.episodes ?? []) by.set(e.kind, [...(by.get(e.kind) ?? []), e]);
  const dur = (e: EpisodeRecord) => Math.max(0, endOf(e, rec) - e.startAt);
  return [...by.entries()]
    .map(([kind, eps]) => ({ kind, eps, total: eps.reduce((s, e) => s + dur(e), 0), longest: eps.reduce((a, b) => (dur(b) > dur(a) ? b : a)) }))
    .sort((a, b) => b.eps.length - a.eps.length || b.total - a.total)
    .map(({ kind, eps, longest }) => ({ kind, longest, text: `${words(kind)} ${eps.length}×, longest ${secs(dur(longest))} s at ${mmss(longest.startAt - start)}` }));
}

const EXTRA_KINDS = [...SENSOR_BEHAVIORS, "other"] as const;
export const VIDEO_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    moments: { type: "array", items: { type: "object", properties: {
      n: { type: "integer", description: "the moment's number from the list" },
      text: { type: "string", description: "one concrete sentence: what the presenter's body did then" },
    }, required: ["n", "text"] } },
    extra: { type: "array", maxItems: 3, items: { type: "object", properties: {
      atS: { type: "number", description: "seconds from the start of the recording" },
      durationS: { type: "number" },
      kind: { type: "string", enum: [...EXTRA_KINDS] },
      text: { type: "string", description: "one concrete sentence, with what happened and why it matters to the audience" },
    }, required: ["atS", "kind", "text"] } },
  },
  required: ["moments", "extra"],
};

const SYSTEM = [
  "You watch the recording of one practice run of a presentation (a camera on the presenter, with sound) for a presentation coach.",
  "Describe only body language and stage presence you can actually see: arms, hands, face touching, posture, gaze (camera/audience vs. floor or slides), facing direction, swaying or pacing, gestures.",
  "Be concrete and short: one plain sentence each, addressed to the presenter as \"you\", with no score and no lecture.",
  "Never comment on looks, clothing, body shape, age, gender, ethnicity or the room. If a moment is not visible (out of frame, dark), say so in a few words.",
  "Times are seconds from the start of the recording.",
].join(" ");

const stamp = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s (${mmss(ms)})`;

/** The question for the model: the episodes in recording time, then up to 3 extra findings. */
export function videoQuestion(rec: RunRecord, recording: Recording, episodes: EpisodeRecord[]): { system: string; prompt: string; schema: Record<string, unknown> } {
  const t0 = recording.startedAt;
  const length = (recording.endedAt ?? rec.endedAt ?? t0) - t0;
  const pres = rec.run.presentationStartedAt;
  const lines = episodes.map((e, i) => {
    const where = e.segment === "qa" ? "during Q&A" : `slide ${e.slideIndex + 1}`;
    return `${i + 1}. ${e.kind} (${words(e.kind)}) from ${stamp(e.startAt - t0)} to ${stamp(endOf(e, rec) - t0)}, ${where}`;
  });
  const prompt = [
    `The recording is about ${Math.round(length / 1000)} s long.${pres ? ` The presentation itself starts at ${stamp(pres - t0)} (before that: a countdown).` : ""}${rec.qaStartedAt ? ` The judges' Q&A starts at ${stamp(rec.qaStartedAt - t0)}.` : ""}`,
    episodes.length
      ? `A pose detector flagged these moments:\n${lines.join("\n")}\nFor each numbered moment, look at that exact time and write one concrete sentence on what your body did (e.g. "You crossed your arms and leaned back while the slide was up."). If the detector looks wrong there, say what you see instead.`
      : "The pose detector flagged nothing (or was not running). Return an empty \"moments\" list.",
    "Then add up to 3 other things you notice about body language and stage presence that the list does not cover (e.g. \"You turned your back to the audience to read the slide.\"), each with its start time and duration in seconds; kind = the closest behaviour or \"other\". Fewer is fine: only what is clearly visible.",
  ].join("\n\n");
  return { system: SYSTEM, prompt, schema: VIDEO_SCHEMA };
}

/** The model's answer → video notes (episodes it skipped keep their deterministic note). */
export function readAnswer(answer: unknown, rec: RunRecord, recording: Recording, episodes: EpisodeRecord[]): Found {
  const a = (answer ?? {}) as { moments?: { n?: unknown; text?: unknown }[]; extra?: { atS?: unknown; durationS?: unknown; kind?: unknown; text?: unknown }[] };
  const base = fallbackNotes(rec, episodes, recording);
  const said = new Map<number, string>();
  for (const m of Array.isArray(a.moments) ? a.moments : []) {
    const n = Number(m?.n), text = typeof m?.text === "string" ? m.text.trim() : "";
    if (Number.isInteger(n) && n >= 1 && n <= episodes.length && text) said.set(n - 1, text.slice(0, 300));
  }
  const notes = base.map((note, i) => (said.has(i) ? { ...note, text: said.get(i)! } : note));
  const offset = recording.startedAt - runStartOf(rec, recording);   // recording time → run time
  const lengthS = ((recording.endedAt ?? rec.endedAt ?? recording.startedAt) - recording.startedAt) / 1000;
  const extras: VideoNote[] = [];
  for (const x of (Array.isArray(a.extra) ? a.extra : []).slice(0, 3)) {
    const atS = Number(x?.atS), text = typeof x?.text === "string" ? x.text.trim() : "";
    if (!Number.isFinite(atS) || atS < 0 || atS > lengthS + 5 || !text) continue;
    const kind = isBodyKind(x.kind) ? x.kind : null;
    const d = Number(x.durationS);
    extras.push({ runId: rec.runId, kind, atMs: Math.max(0, Math.round(atS * 1000 + offset)), ...(Number.isFinite(d) && d > 0 ? { durationMs: Math.round(d * 1000) } : {}), text: text.slice(0, 300) });
  }
  return { notes, extras, source: said.size || extras.length ? "gemini" : "episodes" };
}

/** One note for JJ with the two most useful findings (the top habit with its replay, then an extra). */
export function jjNote(rec: RunRecord, f: Found, recording: Recording | null): string | null {
  const recorded = recording !== null;
  const kinds = kindSummaries(rec, recording);
  const items: string[] = [];
  const top = kinds[0];
  if (top) {
    const said = f.source === "gemini" ? f.notes.find((n) => n.kind === top.kind && n.atMs === Math.max(0, top.longest.startAt - runStartOf(rec, recording)))?.text : undefined;
    items.push(`${top.text}${said ? ` — ${said}` : ""}`);
  }
  if (f.extras[0]) items.push(`at ${mmss(f.extras[0].atMs)}: ${f.extras[0].text}`);
  else if (kinds[1]) items.push(kinds[1].text);
  if (!items.length) return rec.coachConnected || recorded ? `[BODY] ${rec.runId}: no body habits seen${f.source === "gemini" ? " on the recording" : ""}.` : null;
  const replay = recorded && top ? ` Recording available: offer show_moments ${top.kind}.` : "";
  return `[BODY] ${rec.runId}${f.source === "gemini" ? " (Gemini watched the recording)" : ""}: 1) ${items[0]}${items[1] ? ` 2) ${items[1]}` : ""}.${replay}`.replace(/\.\./g, ".");
}
