/**
 * The body agent's video client: Gemini Files API (upload → wait for ACTIVE → ask → delete).
 * An interface so tests inject a fake (no network). Every call can fail or hang (Gemini overloaded):
 * the body agent times them out and falls back to notes from the episodes.
 */
import { gemini } from "./llm.ts";

export interface VideoFile { name: string; uri: string; mimeType: string }

export interface VideoClient {
  /** Uploads a local file (returns as soon as Gemini has it, possibly still PROCESSING). */
  upload(path: string, mimeType: string): Promise<VideoFile>;
  /** Resolves once the file is ACTIVE; rejects if it FAILED or after `timeoutMs`. */
  waitActive(file: VideoFile, timeoutMs: number): Promise<VideoFile>;
  /** One structured JSON answer about the video (parsed). Rejects after `timeoutMs`. */
  ask(o: { model: string; file: VideoFile; system: string; prompt: string; schema: Record<string, unknown>; timeoutMs: number }): Promise<unknown>;
  /** Deletes the uploaded file from Gemini. */
  remove(name: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: timeout after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

export function geminiVideoClient(apiKey: string): VideoClient {
  const ai = gemini(apiKey);
  return {
    async upload(path, mimeType) {
      const f = await withTimeout(ai.files.upload({ file: path, config: { mimeType, displayName: "presentation-run" } }), 120_000, "upload");
      if (!f.name || !f.uri) throw new Error("upload: no file name/uri");
      return { name: f.name, uri: f.uri, mimeType: f.mimeType ?? mimeType };
    },
    async waitActive(file, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const f = await withTimeout(ai.files.get({ name: file.name }), 15_000, "files.get");
        if (f.state === "ACTIVE") return { name: file.name, uri: f.uri ?? file.uri, mimeType: f.mimeType ?? file.mimeType };
        if (f.state === "FAILED") throw new Error(`file processing failed: ${f.error?.message ?? "unknown"}`);
        if (Date.now() > end) throw new Error(`file not ACTIVE after ${timeoutMs} ms (${f.state})`);
        await sleep(1000);
      }
    },
    async ask(o) {
      const r = await withTimeout(ai.models.generateContent({
        model: o.model,
        contents: [{ role: "user", parts: [{ fileData: { fileUri: o.file.uri, mimeType: o.file.mimeType } }, { text: o.prompt }] }],
        config: { systemInstruction: o.system, responseMimeType: "application/json", responseJsonSchema: o.schema },   // thinkingBudget 0 → 400 INVALID_ARGUMENT on 3.5-flash-lite (measured)
      }), o.timeoutMs, "generateContent");
      const text = r.text ?? "";
      try { return JSON.parse(text) as unknown; } catch { throw new Error(`not JSON: ${text.slice(0, 200)}`); }
    },
    async remove(name) { await withTimeout(ai.files.delete({ name }), 15_000, "files.delete"); },
  };
}
