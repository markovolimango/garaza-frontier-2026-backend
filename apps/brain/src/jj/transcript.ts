/**
 * TranscriptRelay: the voice agent's transcript chunks → `jj.transcript` caption lines.
 *
 * Gemini Live sends transcripts as small deltas ("Nice", " opening.", …), often many per
 * second, and rarely marks them finished. The relay keeps one open line per speaker, appends
 * the deltas, and sends the whole line so far (same lineId) at most every `throttleMs`, so a
 * dropped or merged update never loses text. A line becomes final when the provider says so,
 * after `idleMs` without new text, when it grows past `maxChars` (it splits at the last
 * sentence end, or a space), or on end() (run start, barge-in).
 */
import type { DownlinkPayload } from "@coach/protocol";
import type { JJClock } from "./ports.ts";

export type TranscriptLine = DownlinkPayload<"jj.transcript">;
type Who = TranscriptLine["who"];

export interface TranscriptRelayOptions {
  send: (line: TranscriptLine) => void;
  clock: JJClock;
  /** Partial updates of one line at most this often. Default 250 ms. */
  throttleMs?: number;
  /** A line without new text for this long is final. Default 1500 ms. */
  idleMs?: number;
  /** Lines longer than this split at a sentence end (caption-sized lines). Default 140. */
  maxChars?: number;
}

interface OpenLine {
  lineId: string;
  who: Who;
  raw: string;
  utteranceId?: string;
  sent: string | null;
  lastSentAt: number;
  throttle: unknown;
  idle: unknown;
}

const MIN_SPLIT = 30;
const SENTENCE_END = /[.!?…]["'”’)\]]*\s/g;
const tidy = (raw: string) => raw.replace(/\s+/g, " ").trim();

export class TranscriptRelay {
  private readonly open = new Map<Who, OpenLine>();
  private count = 0;
  private readonly throttleMs: number;
  private readonly idleMs: number;
  private readonly maxChars: number;

  constructor(private readonly o: TranscriptRelayOptions) {
    this.throttleMs = o.throttleMs ?? 250;
    this.idleMs = o.idleMs ?? 1500;
    this.maxChars = o.maxChars ?? 140;
  }

  /** True while `who` has a line in progress (its continuation is always relayed). */
  isOpen(who: Who): boolean { return this.open.has(who); }

  /** One transcript chunk from the voice agent. */
  push(who: Who, delta: string, final: boolean, utteranceId?: string): void {
    let line = this.open.get(who);
    if (!line) {
      if (!delta.trim() && !final) return;
      line = { lineId: `${who}_t${++this.count}`, who, raw: "", sent: null, lastSentAt: -Infinity, throttle: null, idle: null };
      this.open.set(who, line);
    }
    if (utteranceId && !line.utteranceId) line.utteranceId = utteranceId;
    line.raw += delta;
    line = this.split(line);
    if (final) { this.end(who); return; }
    this.schedule(line);
    if (line.idle !== null) this.o.clock.clearTimeout(line.idle);
    const l = line;
    line.idle = this.o.clock.setTimeout(() => { if (this.open.get(who) === l) this.end(who); }, this.idleMs);
  }

  /** Finalizes the open line of `who` (both when omitted). */
  end(who?: Who): void {
    for (const w of who ? [who] : (["user", "jj"] as const)) {
      const line = this.open.get(w);
      if (!line) continue;
      this.open.delete(w);
      this.stopTimers(line);
      this.emit(line, true);
    }
  }

  /** Drops open lines without sending anything (shutdown). */
  clear(): void {
    for (const line of this.open.values()) this.stopTimers(line);
    this.open.clear();
  }

  /** Splits an overlong line: the head goes out final, the rest continues as a new line. */
  private split(line: OpenLine): OpenLine {
    for (;;) {
      const text = tidy(line.raw);
      if (text.length <= this.maxChars) return line;
      let cut = -1;
      for (const m of text.matchAll(SENTENCE_END)) {
        const at = m.index + m[0].length - 1;
        if (at > this.maxChars) break;
        if (at >= MIN_SPLIT) cut = at;
      }
      if (cut < 0) {
        const hard = Math.round(this.maxChars * 1.5);
        if (text.length <= hard) return line;
        cut = text.lastIndexOf(" ", hard);
        if (cut < MIN_SPLIT) cut = hard;
      }
      const head = text.slice(0, cut).trim();
      const tail = text.slice(cut).trimStart() + (/\s$/.test(line.raw) ? " " : "");
      this.stopTimers(line);
      line.raw = head;
      this.emit(line, true);
      const next: OpenLine = {
        lineId: `${line.who}_t${++this.count}`, who: line.who, raw: tail, sent: null, lastSentAt: -Infinity, throttle: null, idle: null,
        ...(line.utteranceId ? { utteranceId: line.utteranceId } : {}),
      };
      this.open.set(line.who, next);
      line = next;
    }
  }

  private schedule(line: OpenLine): void {
    if (line.throttle !== null) return;   // a trailing update is already due
    const wait = line.lastSentAt + this.throttleMs - this.o.clock.now();
    if (wait <= 0) { this.emit(line, false); return; }
    line.throttle = this.o.clock.setTimeout(() => { line.throttle = null; if (this.open.get(line.who) === line) this.emit(line, false); }, wait);
  }

  private emit(line: OpenLine, final: boolean): void {
    const text = tidy(line.raw).slice(0, 1000);
    if (!text || (!final && text === line.sent)) return;
    line.sent = text;
    line.lastSentAt = this.o.clock.now();
    this.o.send({ lineId: line.lineId, who: line.who, text, final, ...(line.utteranceId ? { utteranceId: line.utteranceId } : {}) });
  }

  private stopTimers(line: OpenLine): void {
    if (line.throttle !== null) this.o.clock.clearTimeout(line.throttle);
    if (line.idle !== null) this.o.clock.clearTimeout(line.idle);
    line.throttle = null;
    line.idle = null;
  }
}
