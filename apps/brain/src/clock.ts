/** Spec "Brain core": injected clock. RealClock in production; VirtualClock in tests and replay. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export class RealClock implements Clock {
  now(): number { return Date.now(); }
  setTimeout(fn: () => void, ms: number): unknown { return setTimeout(fn, ms); }
  clearTimeout(h: unknown): void { clearTimeout(h as NodeJS.Timeout); }
}

/** advance(ms) runs due timers in time order (ties in scheduling order), moving now() to each. */
export class VirtualClock implements Clock {
  t: number;
  private timers: { at: number; id: number; fn: () => void }[] = [];
  private nextId = 1;
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.nextId++; this.timers.push({ at: this.t + Math.max(0, ms), id, fn }); return id; }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter((x) => x.id !== h); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  pending(): number { return this.timers.length; }
}
