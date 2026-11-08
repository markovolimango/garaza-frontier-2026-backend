/**
 * .pptx decks (Brain integration layer): the brain has PowerPoint export the deck to PDF
 * (POST /api/convert/pptx), which then goes the usual PDF way (deckFile → slides → brain). The slide
 * durations (<p:transition advTm>) are read here from the .pptx and kept for the presenter's timings,
 * also when the deck was uploaded from JJ's screen (remembered by the PDF's name).
 *
 * One path for both deck pickers (JJ's screen and the presenter): `openDeck`. Without the brain there
 * is nothing to convert with, so the pickers take PDFs only.
 */
import { readPptxTimings } from "../lib/pptxTimings";
import { activeSource } from "../signals";
import { BrainSource } from "./BrainSource";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** PowerPoint decks are converted by the brain: only in brain mode. */
export const PPTX_OK = activeSource instanceof BrainSource;
export const DECK_ACCEPT = PPTX_OK ? `application/pdf,.pptx,${PPTX_TYPE}` : "application/pdf";
export const isPptx = (f: File) => /\.pptx$/i.test(f.name) || f.type === PPTX_TYPE;

/** Slide durations (0-based slide → seconds) of decks converted from .pptx, by the PDF's file name. */
export const pptxTimingsFor = new Map<string, Map<number, number>>();

export async function pptxToPdf(httpBase: string, file: File): Promise<{ pdf: File; timings: Map<number, number> }> {
  const [timings, r] = await Promise.all([
    readPptxTimings(file).catch(() => new Map<number, number>()),
    fetch(`${httpBase}/api/convert/pptx`, { method: "POST", headers: { "content-type": PPTX_TYPE }, body: file }),
  ]);
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { hint?: string };
    throw new Error(e.hint ?? `the brain answered HTTP ${r.status}`);
  }
  const pdf = new File([await r.blob()], file.name.replace(/\.pptx$/i, "") + ".pdf", { type: "application/pdf" });
  pptxTimingsFor.set(pdf.name, timings);
  return { pdf, timings };
}

export type DeckStatus = (text: string, level?: "info" | "warn") => void;

/**
 * The deck the presenter picked → `next(pdf)`: a PDF as is; a .pptx converted by PowerPoint on the brain's
 * Mac first. The brain's upload counts as in progress until `next` is done, so a second pick can't start
 * another conversion. `say` tells what is going on (and why nothing happened).
 */
export async function openDeck(file: File, next: (pdf: File) => unknown, say: DeckStatus, source = activeSource): Promise<void> {
  if (!isPptx(file)) { await next(file); return; }
  if (!(source instanceof BrainSource)) { say("PowerPoint decks need the brain: export the deck as PDF", "warn"); return; }
  const brain = source;
  if (brain.getSnapshot().uploading) { say("A deck is already being uploaded", "warn"); return; }
  say("Converting the PowerPoint deck… (PowerPoint opens in the background)");
  await brain.whileUploading(async () => {
    let pdf: File;
    try {
      pdf = (await pptxToPdf(brain.httpBase, file)).pdf;
    } catch (err) {
      say(`Couldn't convert the .pptx: ${err instanceof Error ? err.message : String(err)}`, "warn");
      return;
    }
    await next(pdf);
  });
}
