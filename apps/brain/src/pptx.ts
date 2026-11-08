/**
 * .pptx decks: Microsoft PowerPoint on this Mac exports them to PDF, which then goes through the
 * stage's existing PDF path (pdf.js slides + text). The slide durations come from the .pptx itself
 * (<p:transition advTm>), read by the stage.
 *
 *   POST /api/convert/pptx   body: the .pptx (≤ 100 MB) → 200 application/pdf | 422 {ok:false, reason, hint}
 *
 * How: the file is written into PowerPoint's sandbox folder (it may read and write there without
 * asking), opened through Launch Services in the background (`open -g -a`; PowerPoint's AppleScript
 * `open` is refused from outside its sandbox), then AppleScript saves it as PDF and closes it. The
 * first time, macOS asks once whether this terminal may control PowerPoint. One conversion at a time.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBody } from "./http.ts";
import type { Logger } from "./log.ts";

export const POWERPOINT_APP = "/Applications/Microsoft PowerPoint.app";
const SANDBOX = join(homedir(), "Library", "Containers", "com.microsoft.Powerpoint", "Data", "coach-convert");
const MAX_PPTX = 100 * 1024 * 1024;
const NO_POWERPOINT = "converting .pptx needs Microsoft PowerPoint on this Mac; in PowerPoint use File → Export → PDF and upload the PDF";

export class ConvertError extends Error {}

type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
const run: Run = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** AppleScript string literal. */
const as = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface PptxConverter { toPdf(pptx: Buffer): Promise<Buffer> }

/** The PowerPoint-backed converter (macOS only). `exec` is injectable for tests. */
export function powerPointConverter(o: { log?: Logger; timeoutMs?: number; exec?: Run; dir?: string; available?: () => boolean } = {}): PptxConverter {
  const exec = o.exec ?? run;
  const dir = o.dir ?? SANDBOX;
  const timeoutMs = o.timeoutMs ?? 90_000;
  const available = o.available ?? (() => process.platform === "darwin" && existsSync(POWERPOINT_APP));
  let queue: Promise<unknown> = Promise.resolve();

  const convert = async (pptx: Buffer): Promise<Buffer> => {
    if (!available()) throw new ConvertError(NO_POWERPOINT);
    const id = randomUUID().slice(0, 8);
    const work = join(dir, id);
    const name = `deck-${id}.pptx`;
    const input = join(work, name);
    const output = join(work, `deck-${id}.pdf`);
    // Only our own deck, by name (PowerPoint's `whose` filter on presentations doesn't work); the
    // presenter's other open presentations are never touched.
    const deck = `presentation ${as(name)}`;
    mkdirSync(work, { recursive: true });
    writeFileSync(input, new Uint8Array(pptx));
    const started = Date.now();
    try {
      await exec("open", ["-g", "-a", "Microsoft PowerPoint", input], 15_000);
      for (;;) {   // PowerPoint opens files asynchronously (longer on its first launch)
        const names = await exec("osascript", ["-e", `tell application "Microsoft PowerPoint" to get name of every presentation`], 15_000).catch(() => "");
        if (names.split(", ").includes(name)) break;
        if (Date.now() - started > timeoutMs) throw new ConvertError("PowerPoint did not open the file in time (is it activated, or showing a dialog?)");
        await sleep(500);
      }
      await exec("osascript", ["-e", `tell application "Microsoft PowerPoint" to save ${deck} in (POSIX file ${as(output)} as string) as save as PDF`], timeoutMs);
      if (!existsSync(output)) throw new ConvertError("PowerPoint did not write the PDF");
      const pdf = readFileSync(output);
      o.log?.("info", "pptx.converted", { ms: Date.now() - started, kb: Math.round(pdf.length / 1024) });
      return pdf;
    } catch (err) {
      o.log?.("warn", "pptx.convert_failed", { err: String(err).slice(0, 300) });
      throw err instanceof ConvertError ? err : new ConvertError(`PowerPoint could not convert the file (${String(err).slice(0, 160)})`);
    } finally {   // close our deck whatever happened (it may open after a timeout), then clean up
      await exec("osascript", ["-e", `tell application "Microsoft PowerPoint" to if (name of every presentation) contains ${as(name)} then close ${deck} saving no`], 15_000).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  };
  return { toPdf: (pptx) => { const next = queue.then(() => convert(pptx)); queue = next.catch(() => {}); return next; } };
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function pptxHttp(o: { log?: Logger; converter?: PptxConverter } = {}) {
  const converter = o.converter ?? powerPointConverter(o.log ? { log: o.log } : {});
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/api/convert/pptx") return false;
    const body = await readBody(req, MAX_PPTX);
    if (!body) { json(res, 413, { ok: false, reason: "too_large", hint: "decks up to 100 MB" }); return true; }
    if (!body.subarray(0, 4).equals(ZIP)) { json(res, 400, { ok: false, reason: "invalid_args", hint: "not a .pptx file" }); return true; }
    try {
      const pdf = await converter.toPdf(body);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
      res.end(pdf);
    } catch (err) {
      json(res, 422, { ok: false, reason: "convert_failed", hint: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
