import type { PDFDocumentProxy } from "pdfjs-dist";

/** Loads a PDF in the browser. pdf.js is imported lazily so it never runs during SSR. */
export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
}
