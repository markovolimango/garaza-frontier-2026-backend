/**
 * RunRecorder (Brain integration layer): records the camera and microphone during a run, with the
 * presenter's consent, and streams it to the brain in 4 s chunks (POST /api/media/:runId/chunk). The
 * brain keeps it in the session folder; JJ replays moments from it (moments.show) and "Delete and
 * start over" erases it. Nothing is kept in the browser.
 *
 * The recording starts at the run's countdown (the camera needs a moment) and stops when the run ends.
 * `startedAt` (epoch ms, when the recorder really started) maps the brain's behaviour times onto the video.
 * Each run is tried once: without a camera the run goes on unrecorded (one warning, no retry per
 * slide change). `onChange` reports whether the camera is really being recorded (the "● REC" chip).
 */
const CHUNK_MS = 4000;
const TYPES = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

export type ConsentState = "yes" | "no" | null;
const CONSENT_KEY = "coach.recordConsent";

export function loadConsent(): ConsentState {
  try { const v = sessionStorage.getItem(CONSENT_KEY); return v === "yes" || v === "no" ? v : null; } catch { return null; }
}
export function saveConsent(v: ConsentState): void {
  try { if (v) sessionStorage.setItem(CONSENT_KEY, v); else sessionStorage.removeItem(CONSENT_KEY); } catch { /* private mode: in memory only */ }
}

/** One run's recording: its own chunk counter and failure flag, so a late chunk of an old recording keeps its run and seq. */
interface Take {
  runId: string;
  rec: MediaRecorder | null;
  stream: MediaStream | null;
  seq: number;
  startedAt: number;
  failed: boolean;
}

export class RunRecorder {
  private take: Take | null = null;
  private uploads: Promise<void> = Promise.resolve();
  private live = false;

  constructor(private readonly o: { httpBase: string; warn: (text: string) => void; onChange?: (recording: boolean) => void }) {}

  /** The run start() was last called for (also when the camera failed: not tried again), null after stop(). */
  get runId(): string | null { return this.take?.runId ?? null; }
  /** The camera and microphone are being recorded and uploaded right now. */
  get recording(): boolean { return this.live; }

  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(runId: string): Promise<void> {
    if (this.take?.runId === runId || !RunRecorder.supported()) return;
    const prev = this.take;
    const take: Take = { runId, rec: null, stream: null, seq: 0, startedAt: 0, failed: false };
    this.take = take;
    this.notify();
    if (prev) await this.finish(prev);
    if (this.take !== take) return;   // stopped or replaced meanwhile
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      if (this.take === take) this.o.warn(`Recording off: no camera / microphone (${String(err)})`);
      return;   // the take stays: this run is not tried again
    }
    if (this.take !== take) { stopTracks(stream); return; }   // stopped while the camera was starting
    take.stream = stream;
    try {
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_500_000 });
      rec.onstart = () => { take.startedAt = Date.now(); };
      rec.ondataavailable = (e) => { if (e.data.size > 0) this.enqueue(take, e.data, rec.mimeType); };
      rec.start(CHUNK_MS);
      take.rec = rec;
    } catch (err) {
      this.release(take);
      this.o.warn(`Recording off: the browser couldn't record (${String(err)})`);
      return;
    }
    this.notify();
  }

  /** Stops the recording; resolves when the last chunk is on the brain. */
  async stop(): Promise<void> {
    const take = this.take;
    this.take = null;
    this.notify();
    if (take) await this.finish(take);
  }

  private async finish(take: Take): Promise<void> {
    const rec = take.rec;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => { rec.addEventListener("stop", () => resolve(), { once: true }); rec.stop(); });
    }
    this.release(take);
    if (rec) {
      this.uploads = this.uploads.then(async () => { await fetch(`${this.o.httpBase}/api/media/${take.runId}/done`, { method: "POST" }); }).catch(() => {});
      await this.uploads;
    }
  }

  private release(take: Take): void {
    if (take.stream) stopTracks(take.stream);
    take.stream = null;
  }

  private notify(): void {
    const on = !!this.take?.rec && !this.take.failed;
    if (on === this.live) return;
    this.live = on;
    this.o.onChange?.(on);
  }

  private enqueue(take: Take, blob: Blob, mimeType: string): void {
    const seq = take.seq++;
    const startedAt = take.startedAt || Date.now();
    this.uploads = this.uploads.then(async () => {
      if (take.failed) return;
      const q = seq === 0 ? `seq=0&startedAt=${startedAt}` : `seq=${seq}`;
      const r = await fetch(`${this.o.httpBase}/api/media/${take.runId}/chunk?${q}`, {
        method: "POST", headers: { "content-type": mimeType || "video/webm" }, body: blob,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }).catch((err: unknown) => {
      if (take.failed) return;
      take.failed = true;
      this.o.warn(`Recording stopped: upload failed (${String(err)})`);
      // the camera goes off; the take stays, so this run is not tried again
      if (take.rec && take.rec.state !== "inactive") take.rec.stop();
      this.release(take);
      this.notify();
    });
  }
}

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}
