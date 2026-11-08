import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { publish } from "@/signals";
import { loadPdf } from "@/lib/pdf";
import { readPptxTimings } from "@/lib/pptxTimings";
import { PdfPage } from "@/components/presenter/PdfPage";
import { Btn, Timer, fmt } from "@/components/presenter/Timer";
import { NextButton } from "@/components/NextButton";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/presenter")({
  head: () => ({
    meta: [
      { title: "Presenter — Pitch Practice" },
      { name: "description", content: "Presenter view with slides, notes, timer and per-slide timings." },
      { property: "og:title", content: "Presenter — Pitch Practice" },
      { property: "og:description", content: "Presenter view with slides, notes, timer and per-slide timings." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Presenter,
});

const storageKey = (name: string, pages: number) => `timings:${name}:${pages}`;

function Presenter() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfName, setPdfName] = useState("");
  const [slide, setSlide] = useState(0);
  const [totalSec, setTotalSec] = useState(300);
  const [timings, setTimings] = useState<number[]>([]);
  const [auto, setAuto] = useState(false);
  const rehearse = false;
  const [slideElapsed, setSlideElapsed] = useState(0);
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const slideStart = useRef(performance.now());

  const count = doc?.numPages ?? 0;

  // publish slide index
  useEffect(() => publish("slide", slide), [slide]);

  // persist timings
  useEffect(() => {
    if (doc && timings.length === count) localStorage.setItem(storageKey(pdfName, count), JSON.stringify(timings));
  }, [timings, doc, pdfName, count]);

  const go = useCallback(
    (next: number) => {
      if (!count) return;
      const n = Math.max(0, Math.min(count - 1, next));
      if (n === slide) return;
      if (rehearse) {
        const spent = (performance.now() - slideStart.current) / 1000;
        setTimings((t) => t.map((v, i) => (i === slide ? Math.round(spent * 10) / 10 : v)));
      }
      slideStart.current = performance.now();
      setSlideElapsed(0);
      setSlide(n);
    },
    [count, slide, rehearse],
  );

  // keyboard arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      if (e.key === "ArrowRight") go(slide + 1);
      if (e.key === "ArrowLeft") go(slide - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, slide]);

  // slide clock + auto advance
  useEffect(() => {
    const id = setInterval(() => {
      const e = (performance.now() - slideStart.current) / 1000;
      setSlideElapsed(e);
      if (auto && !rehearse && timings[slide] && e >= timings[slide] && slide < count - 1) go(slide + 1);
    }, 100);
    return () => clearInterval(id);
  }, [auto, rehearse, timings, slide, count, go]);

  async function onPdf(file: File) {
    setStatus("Loading PDF…");
    const d = await loadPdf(file);
    const saved = localStorage.getItem(storageKey(file.name, d.numPages));
    setTimings(saved ? JSON.parse(saved) : Array(d.numPages).fill(Math.round((totalSec / d.numPages) * 10) / 10));
    setPdfName(file.name);
    setDoc(d);
    setSlide(0);
    slideStart.current = performance.now();
    setStatus(saved ? "Loaded saved timings" : "");
  }

  async function onPptx(file: File) {
    const map = await readPptxTimings(file);
    setTimings((t) => t.map((v, i) => map.get(i) ?? v));
    setStatus(`Imported ${map.size} timing${map.size === 1 ? "" : "s"} from pptx`);
  }

  function resetDefaults() {
    if (count) setTimings(Array(count).fill(Math.round((totalSec / count) * 10) / 10));
  }

  const cur = timings[slide] || 0;
  const progress = cur ? Math.min(1, slideElapsed / cur) : 0;

  return (
    <main className="flex h-screen gap-6 p-6">
      {/* left: slides */}
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="relative flex-1 overflow-hidden">
          {doc ? (
            <PdfPage doc={doc} index={slide} className="absolute inset-4" />
          ) : (
            <label className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground">
              <span className="text-2xl">Upload your deck (PDF)</span>
              <span className="text-sm">click to choose a file</span>
              <input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && onPdf(e.target.files[0])} />
            </label>
          )}
        </div>
        <div className="h-px overflow-hidden bg-border">
          <div className="h-full bg-primary transition-[width] duration-100" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous slide" onClick={() => go(slide - 1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Next slide" onClick={() => go(slide + 1)}>
            <ChevronRight />
          </Button>
          <span className="px-2 text-sm tabular-nums text-muted-foreground">
            {count ? `${slide + 1} / ${count}` : "—"}
            {doc ? ` · ${fmt(slideElapsed)} / ${fmt(cur)}` : ""}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Btn onClick={() => setAuto((a) => !a)} active={auto}>Auto-advance</Btn>
            <NextButton to="/judges" label="Judges" />
          </div>
        </div>
      </section>

      {/* right: side panel */}
      <aside className="flex w-[440px] shrink-0 flex-col divide-y divide-border overflow-y-auto">
        <section className="pb-5">
          <h2 className="pb-2 text-sm text-muted-foreground">Next slide</h2>
          {doc ? <PdfPage doc={doc} index={slide + 1} className="h-[180px]" /> : null}
        </section>
        <section className="py-5">
          <h2 className="pb-2 text-sm text-muted-foreground">Time</h2>
          <Timer totalSec={totalSec} onTotalChange={setTotalSec} />
        </section>
        <section className="py-5">
          <h2 className="pb-2 text-sm text-muted-foreground">Notes</h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Speaker notes…"
            className="h-28 w-full resize-none rounded-md border border-input bg-background p-3 text-sm outline-none focus:border-ring"
          />
        </section>
        <section className="flex min-h-0 flex-1 flex-col py-5">
          <div className="flex items-center gap-2 pb-2 text-sm">
            <h2 className="text-muted-foreground">Slide timings</h2>
            <label className="ml-auto cursor-pointer rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              Import .pptx
              <input type="file" accept=".pptx" className="hidden" disabled={!doc} onChange={(e) => e.target.files?.[0] && onPptx(e.target.files[0])} />
            </label>
            <button onClick={resetDefaults} className="rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">Reset</button>
            {doc && (
              <label className="cursor-pointer rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                New PDF
                <input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && onPdf(e.target.files[0])} />
              </label>
            )}
          </div>
          {status && <div className="pb-2 text-xs text-muted-foreground">{status}</div>}
          <ol className="flex-1 overflow-y-auto text-sm">
            {timings.map((t, i) => (
              <li key={i} className={`flex items-center gap-2 rounded-md px-2 py-1 ${i === slide ? "bg-accent" : ""}`}>
                <button onClick={() => go(i)} className="w-16 text-left text-muted-foreground hover:text-foreground">Slide {i + 1}</button>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={t}
                  onChange={(e) => setTimings((arr) => arr.map((v, j) => (j === i ? Number(e.target.value) : v)))}
                  className="ml-auto w-20 rounded-md border border-input bg-background px-2 py-0.5 text-right tabular-nums"
                />
                <span className="text-xs text-muted-foreground">s</span>
              </li>
            ))}
            {!timings.length && <li className="p-2 text-muted-foreground">Upload a PDF to set timings.</li>}
          </ol>
        </section>
      </aside>
    </main>
  );
}
