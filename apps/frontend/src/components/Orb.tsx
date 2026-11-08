import { useEffect, useRef } from "react";
import { subscribe } from "@/signals";

interface OrbProps {
  min?: number;
  max?: number;
  size?: number;
}

const POINTS = 64;

/** Builds a smooth closed path around a wobbling circle. */
function blobPath(r: number, t: number, amp: number, seed: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    const a = (i / POINTS) * Math.PI * 2;
    const n =
      Math.sin(a * 3 + t * 0.9 + seed) * 0.5 +
      Math.sin(a * 5 - t * 1.3 + seed * 2) * 0.3 +
      Math.sin(a * 7 + t * 1.7 + seed * 3) * 0.2;
    const rr = r * (1 + n * amp);
    pts.push([100 + Math.cos(a) * rr, 100 + Math.sin(a) * rr]);
  }
  let d = "";
  for (let i = 0; i < POINTS; i++) {
    const p0 = pts[(i - 1 + POINTS) % POINTS]!, p1 = pts[i]!, p2 = pts[(i + 1) % POINTS]!, p3 = pts[(i + 2) % POINTS]!;
    if (i === 0) d += `M${p1[0].toFixed(2)},${p1[1].toFixed(2)}`;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d + "Z";
}

export function Orb({ min = 0, max = 1, size = 360 }: OrbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const shell = useRef<SVGPathElement>(null);
  const inner = useRef<SVGPathElement>(null);
  const core = useRef<SVGPathElement>(null);
  const swirl = useRef<SVGGElement>(null);
  const turb = useRef<SVGFETurbulenceElement>(null);
  const target = useRef(0);

  useEffect(() => {
    const unsub = subscribe("orbLevel", (v) => {
      const t = (v - min) / (max - min || 1);
      target.current = Math.min(1, Math.max(0, t));
    });
    let cur = 0;
    let time = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      cur += (target.current - cur) * (1 - Math.pow(0.001, dt)); // frame-rate independent lerp
      time += dt * (0.6 + cur * 1.6);
      const breathe = Math.sin(now / 1400) * 0.015;
      const amp = 0.025 + cur * 0.09;
      shell.current?.setAttribute("d", blobPath(78 + breathe * 78, time, amp, 0));
      inner.current?.setAttribute("d", blobPath(58, time * 1.3, amp * 1.4, 1.7));
      core.current?.setAttribute("d", blobPath(34, time * 1.7, amp * 1.8, 3.1));
      swirl.current?.setAttribute("transform", `rotate(${(time * 25) % 360} 100 100)`);
      turb.current?.setAttribute("baseFrequency", `${(0.012 + cur * 0.01).toFixed(4)}`);
      const el = ref.current;
      if (el) {
        el.style.setProperty("--orb-scale", String(0.88 + cur * 0.24 + breathe));
        el.style.setProperty("--orb-glow", String(0.3 + cur * 0.7));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [min, max]);

  return (
    <div ref={ref} className="orb" style={{ width: size, height: size }} aria-label="AI assistant">
      <div className="orb-glow" />
      <div className="orb-glow orb-glow-2" />
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <radialGradient id="orb-g1" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="var(--orb-hi)" />
            <stop offset="35%" stopColor="var(--orb-a)" />
            <stop offset="70%" stopColor="var(--orb-b)" />
            <stop offset="100%" stopColor="var(--orb-c)" />
          </radialGradient>
          <linearGradient id="orb-g2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--orb-c)" stopOpacity="0.9" />
            <stop offset="50%" stopColor="var(--orb-a)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--orb-b)" stopOpacity="0.9" />
          </linearGradient>
          <radialGradient id="orb-g3">
            <stop offset="0%" stopColor="var(--orb-hi)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--orb-a)" stopOpacity="0" />
          </radialGradient>
          <filter id="orb-turb" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence ref={turb} type="fractalNoise" baseFrequency="0.014" numOctaves="2" seed="3" />
            <feDisplacementMap in="SourceGraphic" scale="10" />
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
          <filter id="orb-soft"><feGaussianBlur stdDeviation="4" /></filter>
        </defs>
        <path ref={shell} fill="url(#orb-g1)" />
        <g ref={swirl} filter="url(#orb-turb)" style={{ mixBlendMode: "screen" }}>
          <path ref={inner} fill="url(#orb-g2)" opacity="0.75" />
        </g>
        <path ref={core} fill="url(#orb-g3)" filter="url(#orb-soft)" style={{ mixBlendMode: "screen" }} />
      </svg>
    </div>
  );
}
