/**
 * Deck upload (Brain integration layer). Spec "Setup, deck and context": the browser
 * renders each PDF page to a 1920 px wide PNG and extracts its text; the brain stores them.
 */
import type { Deck, DeckManifest } from "@coach/protocol";

export const MAX_SLIDES = 60;

/** Renders a PDF into the manifest + PNG blobs the brain expects. Browser only. */
export async function pdfToSlides(file: File, targetWidth = 1920): Promise<{ manifest: DeckManifest; images: Blob[] }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (doc.numPages > MAX_SLIDES) throw new Error(`the deck has ${doc.numPages} pages; at most ${MAX_SLIDES}`);
  const slides: DeckManifest["slides"] = [];
  const images: Blob[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: targetWidth / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    images.push(await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encode failed"))), "image/png")));
    const text = await page.getTextContent();
    slides.push({
      index: i - 1,
      text: text.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim(),
      width: canvas.width, height: canvas.height,
    });
  }
  return { manifest: { name: file.name.replace(/\.pdf$/i, ""), slides }, images };
}

/** POST /api/uploads/deck (multipart: manifest + slide_<n>.png). */
export async function uploadDeck(httpBase: string, manifest: DeckManifest, images: Blob[]): Promise<Deck> {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  images.forEach((img, i) => form.append(`slide_${i}.png`, img, `slide_${i}.png`));
  const res = await fetch(`${httpBase}/api/uploads/deck`, { method: "POST", body: form });
  const body = (await res.json()) as Deck | { ok: false; reason: string; hint?: string };
  if (!res.ok || "ok" in body) throw new Error("hint" in body && body.hint ? body.hint : `upload failed (${res.status})`);
  return body;
}
