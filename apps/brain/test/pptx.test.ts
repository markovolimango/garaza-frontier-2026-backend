/** .pptx → PDF through PowerPoint: the steps it runs (faked here) and the HTTP route. */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ConvertError, powerPointConverter, pptxHttp, type PptxConverter } from "../src/pptx.ts";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rest of a zip")]);

/** Fake PowerPoint: `open` makes the deck "open" after two polls; save writes the PDF. */
function fakePowerPoint(o: { neverOpens?: boolean; saveFails?: boolean } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const exec = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "open") return "";
    const script = args[1] ?? "";
    if (script.endsWith("get name of every presentation")) {
      const opened = /deck-\w+\.pptx/.exec(calls.filter((c) => c.startsWith("open")).at(-1) ?? "")?.[0];
      return o.neverOpens || ++polls < 3 ? "Someone else's deck.pptx" : `Someone else's deck.pptx, ${opened}`;
    }
    if (script.includes("save as PDF")) {
      if (o.saveFails) throw new Error("-9074");
      writeFileSync(/POSIX file "([^"]+)"/.exec(script)![1]!, "%PDF-1.7 fake");
      return "";
    }
    return "";
  };
  return { calls, exec };
}

describe("PowerPoint converter", () => {
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "pptx-")); dirs.push(d); return d; };

  it("opens the deck in the background, waits for it, saves it as PDF, closes it and cleans up", async () => {
    const d = dir(), pp = fakePowerPoint();
    const pdf = await powerPointConverter({ exec: pp.exec, dir: d, available: () => true }).toPdf(PPTX);
    expect(pdf.toString()).toBe("%PDF-1.7 fake");
    expect(pp.calls[0]).toMatch(/^open -g -a Microsoft PowerPoint .*deck-\w+\.pptx$/);
    expect(pp.calls.filter((c) => c.endsWith("get name of every presentation"))).toHaveLength(3);
    expect(pp.calls.at(-2)).toMatch(/save presentation "deck-\w+\.pptx" in \(POSIX file ".*deck-\w+\.pdf" as string\) as save as PDF/);
    // closes only its own deck (by name, only if open); the presenter's other presentations stay open
    expect(pp.calls.at(-1)).toMatch(/if \(name of every presentation\) contains "deck-\w+\.pptx" then close presentation "deck-\w+\.pptx" saving no$/);
    expect(pp.calls.some((c) => c.includes("every presentation saving"))).toBe(false);
    expect(readdirSync(d)).toEqual([]);                          // the work folder is gone
  });

  it("says what to do without PowerPoint, when it never opens the file, and when the save fails", async () => {
    const d = dir();
    await expect(powerPointConverter({ dir: d, available: () => false }).toPdf(PPTX)).rejects.toThrow(/File → Export → PDF/);
    await expect(powerPointConverter({ exec: fakePowerPoint({ neverOpens: true }).exec, dir: d, available: () => true, timeoutMs: 600 }).toPdf(PPTX))
      .rejects.toThrow(/did not open the file in time/);
    await expect(powerPointConverter({ exec: fakePowerPoint({ saveFails: true }).exec, dir: d, available: () => true }).toPdf(PPTX))
      .rejects.toBeInstanceOf(ConvertError);
    expect(readdirSync(d)).toEqual([]);
  });

  it("converts one deck at a time", async () => {
    const d = dir(), pp = fakePowerPoint();
    const c = powerPointConverter({ exec: pp.exec, dir: d, available: () => true });
    await Promise.all([c.toPdf(PPTX), c.toPdf(PPTX)]);
    const opens = pp.calls.map((x, i) => (x.startsWith("open") ? i : -1)).filter((i) => i >= 0);
    const firstClose = pp.calls.findIndex((x) => x.includes("close"));
    expect(opens[1]).toBeGreaterThan(firstClose);                 // the second opens after the first closed
  });
});

describe("POST /api/convert/pptx", () => {
  async function post(converter: PptxConverter, body: Buffer) {
    const req = Object.assign(new PassThrough(), { method: "POST", url: "/api/convert/pptx", headers: {} });
    let status = 0, head: Record<string, unknown> = {};
    const out: Buffer[] = [];
    const res = Object.assign(new Writable({ write(c, _e, cb) { out.push(Buffer.from(c)); cb(); } }), {
      writeHead(code: number, h: Record<string, unknown> = {}) { status = code; head = h; return this; },
    });
    const finished = new Promise((r) => res.on("finish", r));
    const handled = pptxHttp({ converter })(req as never, res as never);
    req.end(body);
    expect(await handled).toBe(true);
    await finished;
    return { status, head, body: Buffer.concat(out).toString() };
  }
  const ok: PptxConverter = { toPdf: async () => Buffer.from("%PDF fake") };

  it("returns the PDF", async () => {
    expect(await post(ok, PPTX)).toMatchObject({ status: 200, head: { "content-type": "application/pdf" }, body: "%PDF fake" });
  });
  it("refuses what is not a .pptx and explains a failed conversion", async () => {
    expect((await post(ok, Buffer.from("%PDF-1.7"))).status).toBe(400);
    const failed = await post({ toPdf: async () => { throw new ConvertError("PowerPoint is not here"); } }, PPTX);
    expect([failed.status, JSON.parse(failed.body)]).toEqual([422, { ok: false, reason: "convert_failed", hint: "PowerPoint is not here" }]);
  });
  it("leaves other routes alone", async () => {
    expect(await pptxHttp({ converter: ok })(Object.assign(new PassThrough(), { method: "GET", url: "/api/convert/pptx" }) as never, {} as never)).toBe(false);
    expect(existsSync("/nonexistent")).toBe(false);
  });
});
