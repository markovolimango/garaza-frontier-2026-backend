import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

/** Renders one PDF page fitted to its container. */
export function PdfPage({ doc, index, className }: { doc: PDFDocumentProxy; index: number; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      if (index < 0 || index >= doc.numPages) return;
      const page = await doc.getPage(index + 1);
      if (cancelled || !wrap.current || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const box = wrap.current.getBoundingClientRect();
      const scale = Math.min(box.width / base.width, box.height / base.height) * (window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale });
      const c = canvas.current;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${vp.width / (window.devicePixelRatio || 1)}px`;
      c.style.height = `${vp.height / (window.devicePixelRatio || 1)}px`;
      const t = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: vp });
      task = t;
      await t.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index]);

  return (
    <div ref={wrap} className={`flex items-center justify-center overflow-hidden ${className ?? ""}`}>
      {index < doc.numPages ? <canvas ref={canvas} className="rounded-md shadow-2xl" /> : (
        <span className="text-sm text-muted-foreground">End of deck</span>
      )}
    </div>
  );
}
