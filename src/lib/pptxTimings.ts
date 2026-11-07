/** Extracts advTm (ms) from a slide XML <p:transition>. Returns seconds or null. */
export function parseAdvTm(xml: string): number | null {
  const m = xml.match(/<p:transition\b[^>]*\badvTm="(\d+)"/);
  return m ? Number(m[1]) / 1000 : null;
}

/** Returns map of 0-based slide index -> seconds for slides that have advTm. */
export async function readPptxTimings(file: File): Promise<Map<number, number>> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const out = new Map<number, number>();
  const entries = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  for (const name of entries) {
    const n = Number(name.match(/slide(\d+)\.xml$/)![1]);
    const secs = parseAdvTm(await zip.files[name]!.async("string"));
    if (secs !== null) out.set(n - 1, secs);
  }
  return out;
}
