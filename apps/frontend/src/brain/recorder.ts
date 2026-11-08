/**
 * RunRecorder (Brain integration layer): records the camera and microphone during a run, with the
 * presenter's consent, and streams it to the brain in 4 s chunks (POST /api/media/:runId/chunk). The
 * brain keeps it in the session folder; JJ replays moments from it (moments.show) and "Delete and
 * start over" erases it. Nothing is kept in the browser.
 *
 * The recording starts at the run's countdown (the camera needs a moment) and stops when the run ends.
 * `startedAt` (epoch ms, when the recorder really started) maps the brain's behaviour times onto the video.
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

export class RunRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private runId: string | null = null;
  private seq = 0;
  private startedAt = 0;
  private uploads: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly o: { httpBase: string; warn: (text: string) => void }) {}

  get recording(): string | null { return this.runId; }

  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(runId: string): Promise<void> {
    if (this.runId === runId || !RunRecorder.supported()) return;
    await this.stop();
    this.runId = runId;
    this.seq = 0;
    this.failed = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      this.o.warn(`Recording off: no camera / microphone (${String(err)})`);
      this.runId = null;
      return;
    }
    if (this.runId !== runId) { this.release(); return; }   // stopped while the camera was starting
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const rec = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_500_000 });
    this.rec = rec;
    rec.onstart = () => { this.startedAt = Date.now(); };
    rec.ondataavailable = (e) => { if (e.data.size > 0) this.enqueue(runId, e.data, rec.mimeType); };
    rec.start(CHUNK_MS);
  }

  /** Stops the recording; resolves when the last chunk is on the brain. */
  async stop(): Promise<void> {
    const rec = this.rec, runId = this.runId;
    this.rec = null;
    this.runId = null;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => { rec.addEventListener("stop", () => resolve(), { once: true }); rec.stop(); });
    }
    this.release();
    if (rec && runId) {
      this.uploads = this.uploads.then(async () => { await fetch(`${this.o.httpBase}/api/media/${runId}/done`, { method: "POST" }); }).catch(() => {});
      await this.uploads;
    }
  }

  private release(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  private enqueue(runId: string, blob: Blob, mimeType: string): void {
    const seq = this.seq++;
    const startedAt = this.startedAt || Date.now();
    this.uploads = this.uploads.then(async () => {
      if (this.failed) return;
      const q = seq === 0 ? `seq=0&startedAt=${startedAt}` : `seq=${seq}`;
      const r = await fetch(`${this.o.httpBase}/api/media/${runId}/chunk?${q}`, {
        method: "POST", headers: { "content-type": mimeType || "video/webm" }, body: blob,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }).catch((err: unknown) => {
      if (!this.failed) this.o.warn(`Recording stopped: upload failed (${String(err)})`);
      this.failed = true;
    });
  }
}
