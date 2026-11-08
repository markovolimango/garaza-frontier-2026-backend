/**
 * MomentsPlayer (Brain integration layer): plays the clips JJ asked for (`moments.show`, JJ's
 * show_moments) from the run's recording on the brain, one after the other: seek to `fromS`, play
 * to `toS`, next. Muted by default (JJ is talking over it); closes itself a moment after the last clip,
 * or when the recording can't be played.
 */
import type { DownlinkPayload } from "@coach/protocol";
import { useEffect, useRef, useState } from "react";

type Moments = DownlinkPayload<"moments.show">;

export function MomentsPlayer({ m, httpBase, onClose }: { m: Moments; httpBase: string; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [i, setI] = useState(0);
  const [muted, setMuted] = useState(true);
  const [done, setDone] = useState(false);
  const [nonce, setNonce] = useState(0);   // replaying the same clip re-runs the effect
  const play = (k: number) => { setDone(false); setI(k); setNonce((n) => n + 1); };
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => { setI(0); setDone(false); }, [m]);

  const clip = m.clips[i];
  useEffect(() => {
    const v = video.current;
    if (!v || !clip || done) return;
    const src = `${httpBase}${clip.url}`;
    const go = () => { v.currentTime = clip.fromS; void v.play().catch(() => {}); };
    const next = () => {
      v.pause();
      if (i + 1 < m.clips.length) setI(i + 1);
      else setDone(true);
    };
    const tick = () => { if (v.currentTime >= clip.toS) next(); };
    const failed = () => { setDone(true); close.current(); };   // missing or unreadable recording: nothing to show
    v.addEventListener("error", failed);
    if (v.dataset["src"] !== src) { v.dataset["src"] = src; v.src = src; }
    if (v.error) failed();
    else if (v.readyState >= HTMLMediaElement.HAVE_METADATA) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
    v.addEventListener("timeupdate", tick);
    v.addEventListener("ended", next);
    return () => {
      v.removeEventListener("loadedmetadata", go);
      v.removeEventListener("error", failed);
      v.removeEventListener("timeupdate", tick);
      v.removeEventListener("ended", next);
    };
  }, [clip, i, done, nonce, httpBase, m.clips.length]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => close.current(), 2500);
    return () => clearTimeout(t);
  }, [done]);

  if (!clip) return null;
  return (
    <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6 font-sans">
      <div className="flex w-[min(92vw,60rem)] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{m.title}</h2>
          <div className="flex items-center gap-2 text-sm">
            <button type="button" onClick={() => setMuted((x) => !x)} className="rounded-full border border-border px-3 py-1 hover:bg-accent">
              {muted ? "Sound on" : "Mute"}
            </button>
            <button type="button" onClick={() => play(0)} className="rounded-full border border-border px-3 py-1 hover:bg-accent">Replay</button>
            <button type="button" onClick={onClose} className="rounded-full border border-border px-3 py-1 hover:bg-accent">Close</button>
          </div>
        </div>
        <video ref={video} muted={muted} playsInline className="aspect-video w-full rounded-xl bg-black object-contain" />
        <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
          <span>{i + 1} / {m.clips.length}</span>
          <span>·</span>
          <span>{clip.label}</span>
          <span className="ml-auto flex gap-1">
            {m.clips.map((c, k) => (
              <button key={k} type="button" onClick={() => play(k)} aria-label={`clip ${k + 1}: ${c.label}`}
                className={`h-2 w-6 rounded-full ${k === i ? "bg-primary" : "bg-secondary"}`} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
