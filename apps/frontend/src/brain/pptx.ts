/**
 * .pptx decks (Brain integration layer): the brain has PowerPoint export the deck to PDF
 * (POST /api/convert/pptx), which then goes the usual PDF way (deckFile → slides → brain). The slide
 * durations (<p:transition advTm>) are read here from the .pptx and kept for the presenter's timings,
 * also when the deck was uploaded from JJ's screen (remembered by the PDF's name).
 */
import { readPptxTimings } from "../lib/pptxTimings";
import { activeSource } from "../signals";
import { BrainSource, brainOptionsFromEnv } from "./BrainSource";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const DECK_ACCEPT = `application/pdf,.pptx,${PPTX_TYPE}`;
export const isPptx = (f: File) => /\.pptx$/i.test(f.name) || f.type === PPTX_TYPE;

/** Slide durations (0-based slide → seconds) of decks converted from .pptx, by the PDF's file name. */
export const pptxTimingsFor = new Map<string, Map<number, number>>();

export async function pptxToPdf(file: File): Promise<{ pdf: File; timings: Map<number, number> }> {
  const base = activeSource instanceof BrainSource ? activeSource.httpBase : brainOptionsFromEnv().httpBase;
  const [timings, r] = await Promise.all([
    readPptxTimings(file).catch(() => new Map<number, number>()),
    fetch(`${base}/api/convert/pptx`, { method: "POST", headers: { "content-type": PPTX_TYPE }, body: file }),
  ]);
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { hint?: string };
    throw new Error(e.hint ?? `the brain answered HTTP ${r.status}`);
  }
  const pdf = new File([await r.blob()], file.name.replace(/\.pptx$/i, "") + ".pdf", { type: "application/pdf" });
  pptxTimingsFor.set(pdf.name, timings);
  return { pdf, timings };
}
