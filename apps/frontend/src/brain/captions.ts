/**
 * JJ's live captions (Brain integration layer, pure + a tiny store; unit tested).
 *
 * The brain sends `jj.transcript` lines: the whole line so far, re-sent under the same lineId
 * as it grows, then `final`. Gemini's transcript runs ahead of JJ's audio, so JJ's lines are
 * revealed at speaking pace (CAPTIONS.charsPerSec, word by word, one line after the other);
 * the user's lines show as they come. The newest line is bright, older ones dim, and each one
 * fades out `holdMs` after it is complete.
 */
import type { DownlinkPayload } from "@coach/protocol";

export type TranscriptMsg = DownlinkPayload<"jj.transcript">;

export interface CaptionLine {
  lineId: string;
  who: "user" | "jj";
  text: string;
  final: boolean;
  firstAt: number;
  finalAt: number | null;
}

export interface Caption { lineId: string; who: "user" | "jj"; text: string; live: boolean; opacity: number }

export const CAPTIONS = {
  /** Lines on screen at once (newest last). */
  maxLines: 3,
  /** JJ's reveal pace: ~16 chars/s is about 170 words per minute. */
  charsPerSec: 16,
  /** A complete line stays this long, then fades over fadeMs. */
  holdMs: 7000,
  fadeMs: 1200,
  /** Opacity by age: newest, previous, the one before. */
  dim: [1, 0.5, 0.25],
  /** Lines kept in memory. */
  keep: 8,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Merges one jj.transcript message: a known lineId is replaced whole, a new one is appended. */
export function applyTranscript(lines: readonly CaptionLine[], m: TranscriptMsg, now: number): CaptionLine[] {
  const i = lines.findIndex((l) => l.lineId === m.lineId);
  if (i >= 0) {
    const old = lines[i]!;
    if (old.final) return [...lines];   // a late partial after the final changes nothing
    const next = [...lines];
    next[i] = { ...old, text: m.text, final: m.final, finalAt: m.final ? now : null };
    return next;
  }
  const line: CaptionLine = { lineId: m.lineId, who: m.who, text: m.text, final: m.final, firstAt: now, finalAt: m.final ? now : null };
  return [...lines, line].slice(-CAPTIONS.keep);
}

interface Timed { line: CaptionLine; text: string; revealedAt: number; fade: number }

function timeline(lines: readonly CaptionLine[], now: number): Timed[] {
  let jjFree = -Infinity;   // when the previous JJ line is fully revealed
  return lines.map((line) => {
    let text = line.text;
    let revealedAt = line.firstAt;
    if (line.who === "jj") {
      const start = Math.max(line.firstAt, jjFree);
      revealedAt = start + (line.text.length / CAPTIONS.charsPerSec) * 1000;
      jjFree = revealedAt;
      if (now < revealedAt) {
        const n = Math.max(0, Math.floor(((now - start) / 1000) * CAPTIONS.charsPerSec));
        const cut = line.text.lastIndexOf(" ", n);
        text = line.text.slice(0, cut > 0 ? cut : n);
      }
    }
    const doneAt = line.final ? Math.max(line.finalAt ?? now, revealedAt) : null;
    const fade = doneAt === null ? 1 : clamp01(1 - (now - doneAt - CAPTIONS.holdMs) / CAPTIONS.fadeMs);
    return { line, text, revealedAt, fade };
  });
}

/** What to draw now: the newest `maxLines` lines with text, dimmed by age and faded when old. */
export function visibleCaptions(lines: readonly CaptionLine[], now: number, maxLines = CAPTIONS.maxLines): Caption[] {
  const shown = timeline(lines, now).filter((t) => t.fade > 0 && t.text.trim()).slice(-maxLines);
  return shown.map((t, i) => ({
    lineId: t.line.lineId,
    who: t.line.who,
    text: t.text,
    live: !t.line.final || now < t.revealedAt,
    opacity: t.fade * (CAPTIONS.dim[shown.length - 1 - i] ?? 0),
  }));
}

/** Drops lines that have faded out completely. */
export function pruneCaptions(lines: readonly CaptionLine[], now: number): CaptionLine[] {
  const t = timeline(lines, now);
  return lines.filter((_, i) => t[i]!.fade > 0);
}

/** BrainSource's caption state; components read it with useSyncExternalStore. */
export class CaptionStore {
  private lines: CaptionLine[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly now: () => number = () => Date.now()) {}

  push(m: TranscriptMsg): void { this.update(applyTranscript(pruneCaptions(this.lines, this.now()), m, this.now())); }
  prune(): void { const next = pruneCaptions(this.lines, this.now()); if (next.length !== this.lines.length) this.update(next); }
  clear(): void { if (this.lines.length) this.update([]); }

  getLines = (): readonly CaptionLine[] => this.lines;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private update(lines: CaptionLine[]): void {
    this.lines = lines;
    for (const l of this.listeners) l();
  }
}
