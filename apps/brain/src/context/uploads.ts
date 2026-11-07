/**
 * Uploads (spec: "Setup, deck and context", brain half). The browser does all file
 * processing; the brain stores the slide images and extracted text, and puts the deck and
 * doc metadata into the session context. No LLM here (digest and personas are step 15).
 *
 *   POST /api/uploads/deck      multipart: manifest (JSON DeckManifest) + slide_<n>.png → Deck
 *   POST /api/uploads/docs      JSON { docs: {name, mime, text}[] } → ContextDocMeta[]
 *   GET  /api/decks/:deckId/:n.png
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { nanoid } from "nanoid";
import { z } from "zod";
import { DeckManifest, type ContextDocMeta, type Deck } from "@coach/protocol";
import type { Logger } from "../log.ts";
import type { SessionStore } from "../session.ts";

export const LIMITS = { slides: 60, docs: 10, charsPerDoc: 50_000, charsTotal: 150_000, imageBytes: 15 * 1024 * 1024, deckBytes: 200 * 1024 * 1024 };
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const DocsBody = z.object({
  docs: z.array(z.object({ name: z.string().min(1).max(200), mime: z.string().max(100), text: z.string() })).max(LIMITS.docs),
});

export interface UploadsOptions {
  session: SessionStore;
  sessionDir: string;
  log?: Logger;
}

type Reply = { status: number; body: unknown };
const fail = (status: number, reason: string, hint: string): Reply => ({ status, body: { ok: false, reason, hint } });

export class Uploads {
  private readonly decks = new Map<string, string>();   // deckId → directory with <n>.png
  private docTexts: { meta: ContextDocMeta; text: string }[] = [];
  private readonly log: Logger;

  constructor(private readonly o: UploadsOptions) {
    this.log = o.log ?? (() => {});
  }

  /** Concatenated and truncated doc text, for prompts (spec ContextService.docText). */
  docText(): string { return this.docTexts.map((d) => `# ${d.meta.name}\n${d.text}`).join("\n\n"); }
  slideText(index: number): string { return this.o.session.get().context.deck?.slides[index]?.text ?? ""; }

  /** Returns true when the request was handled. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    let reply: Reply | null = null;
    if (req.method === "POST" && path === "/api/uploads/deck") reply = await this.uploadDeck(req);
    else if (req.method === "POST" && path === "/api/uploads/docs") reply = await this.uploadDocs(req);
    else if (req.method === "GET" && path.startsWith("/api/decks/")) return this.serveSlide(path, res);
    if (!reply) return false;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
    return true;
  }

  private checkPhase(): Reply | null {
    const s = this.o.session.get();
    return s.phase === "running" ? fail(409, "wrong_phase", "uploads are not possible during a run") : null;
  }

  async uploadDeck(req: IncomingMessage): Promise<Reply> {
    const phase = this.checkPhase();
    if (phase) return phase;
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > LIMITS.deckBytes) return fail(413, "invalid_args", "the deck is too large");
    let form: FormData;
    try {
      const request = new Request("http://brain/upload", {
        method: "POST", headers: req.headers as Record<string, string>,
        body: Readable.toWeb(req) as ReadableStream, duplex: "half",
      } as RequestInit & { duplex: "half" });
      form = await request.formData();
    } catch (err) {
      return fail(400, "invalid_args", `expected multipart/form-data: ${String(err)}`);
    }
    const rawManifest = form.get("manifest");
    let manifestJson: unknown;
    try { manifestJson = JSON.parse(typeof rawManifest === "string" ? rawManifest : await (rawManifest as Blob | null)?.text() ?? ""); }
    catch { return fail(400, "invalid_args", "manifest must be JSON"); }
    const manifest = DeckManifest.safeParse(manifestJson);
    if (!manifest.success) return fail(400, "invalid_args", z.prettifyError(manifest.error));
    const slides = [...manifest.data.slides].sort((a, b) => a.index - b.index);
    if (slides.length === 0) return fail(400, "invalid_args", "the deck has no slides");
    if (slides.some((s, i) => s.index !== i)) return fail(400, "invalid_args", "slide indexes must be 0..n-1");

    const images: Buffer[] = [];
    for (const s of slides) {
      const f = form.get(`slide_${s.index}.png`) ?? form.get(`slide_${s.index}`);
      if (!f || typeof f === "string") return fail(400, "invalid_args", `missing image slide_${s.index}.png`);
      if (f.size > LIMITS.imageBytes) return fail(413, "invalid_args", `slide_${s.index}.png is too large`);
      const buf = Buffer.from(await f.arrayBuffer());
      if (!PNG_MAGIC.every((b, i) => buf[i] === b)) return fail(400, "invalid_args", `slide_${s.index}.png is not a PNG`);
      images.push(buf);
    }

    const deckId = `deck_${nanoid(8)}`;
    const dir = resolve(this.o.sessionDir, this.o.session.get().sessionId, "uploads", "deck", deckId);
    mkdirSync(dir, { recursive: true });
    images.forEach((img, i) => writeFileSync(join(dir, `${i}.png`), img));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest.data, null, 2));
    this.decks.set(deckId, dir);

    const deck: Deck = {
      deckId, name: manifest.data.name,
      slides: slides.map((s) => ({ index: s.index, url: `/api/decks/${deckId}/${s.index}.png`, text: s.text })),
    };
    this.o.session.setContext({ deck });
    this.log("info", "uploads.deck", { deckId, slides: deck.slides.length });
    return { status: 200, body: deck };
  }

  async uploadDocs(req: IncomingMessage): Promise<Reply> {
    const phase = this.checkPhase();
    if (phase) return phase;
    let body: unknown;
    try { body = JSON.parse(await readBody(req, 2 * LIMITS.charsTotal * 4)); } catch (err) { return fail(400, "invalid_args", `expected JSON: ${String(err)}`); }
    const parsed = DocsBody.safeParse(body);
    if (!parsed.success) return fail(400, "invalid_args", z.prettifyError(parsed.error));
    let budget = LIMITS.charsTotal;
    const dir = resolve(this.o.sessionDir, this.o.session.get().sessionId, "uploads", "docs");
    mkdirSync(dir, { recursive: true });
    this.docTexts = parsed.data.docs.map((d) => {
      const text = d.text.slice(0, Math.min(LIMITS.charsPerDoc, Math.max(0, budget)));
      budget -= text.length;
      const meta: ContextDocMeta = { docId: `doc_${nanoid(8)}`, name: d.name, chars: text.length };
      writeFileSync(join(dir, `${meta.docId}.txt`), text);
      return { meta, text };
    });
    const docs = this.docTexts.map((d) => d.meta);
    this.o.session.setContext({ docs });
    return { status: 200, body: docs };
  }

  private serveSlide(path: string, res: ServerResponse): boolean {
    const m = /^\/api\/decks\/([\w-]+)\/(\d+)\.png$/.exec(path);
    const dir = m ? this.decks.get(m[1]!) : undefined;
    const file = dir ? join(dir, `${m![2]}.png`) : null;
    if (!file || !existsSync(file)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "not_available", hint: "no such slide" }));
      return true;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    res.end(readFileSync(file));
    return true;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > maxBytes) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
