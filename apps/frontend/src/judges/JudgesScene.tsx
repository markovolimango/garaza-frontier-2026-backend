import { Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Judge, estimateSpeechMs, type JudgeHandle } from "./Judge";
import { Room, TABLE_TOP } from "./Room";
import type { JudgeConfig, JudgeIndex, JudgesHandle } from "./types";

const SEAT_Z = -0.75;

export const DEFAULT_JUDGES: JudgeConfig[] = [
  { position: [-1.65, 0, SEAT_Z], height: 0.97, tint: "#2d6cdf", idle: "sitting-idle" },
  { position: [-0.55, 0, SEAT_Z], height: 1.05, tint: "#d9488f", idle: "sitting-idle-2" },
  { position: [0.55, 0, SEAT_Z], height: 0.94, tint: "#2fb68a", idle: "sitting-idle" },
  { position: [1.65, 0, SEAT_Z], height: 1.01, tint: "#e3923a", idle: "sitting-idle-2" },
];

/** A panel by seat (0..3, left to right): those seats get DEFAULT_JUDGES' look plus a nameplate; the others stay empty. */
export function seatedJudges(seats: readonly { seat: JudgeIndex; title?: string }[]): (JudgeConfig | null)[] {
  return DEFAULT_JUDGES.map((cfg, i) => {
    const s = seats.find((x) => x.seat === i);
    return s ? { ...cfg, ...(s.title ? { title: s.title } : {}) } : null;
  });
}

const PLATE: [number, number] = [0.56, 0.088];
/** Plates stand nearer the camera than the judges: pulled toward the centre so each reads under its judge. */
const PLATE_Z = 0.12;
const PLATE_PULL = 0.84;
const PLATE_PX: [number, number] = [1024, 160];
const PLATE_FONT = (px: number) => `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;

/** The title drawn on a canvas (a texture, not DOM: no extra React roots in the canvas). */
function plateTexture(title: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = PLATE_PX;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#f4f4f5";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = "rgba(60,64,72,0.25)";
  g.lineWidth = 4;
  g.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  const room = canvas.width - 90;
  let px = 66;
  g.font = PLATE_FONT(px);
  while (g.measureText(title).width > room && px > 40) g.font = PLATE_FONT((px -= 4));
  let text = title;
  if (g.measureText(text).width > room) {
    while (text.length > 1 && g.measureText(`${text}…`).width > room) text = text.slice(0, -1);
    text = `${text.trimEnd()}…`;
  }
  g.fillStyle = "#2a2d33";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Tent card at the table's front edge with the judge's title. */
function Nameplate({ x, title }: { x: number; title: string }) {
  const texture = useMemo(() => plateTexture(title), [title]);
  useEffect(() => () => texture?.dispose(), [texture]);
  return (
    <group position={[x * PLATE_PULL, TABLE_TOP + PLATE[1] / 2, PLATE_Z]} rotation-x={-0.3}>
      <mesh>
        <boxGeometry args={[PLATE[0], PLATE[1], 0.012]} />
        <meshStandardMaterial color="#f4f4f5" roughness={0.9} />
      </mesh>
      {texture && (
        <mesh position={[0, 0, 0.0065]}>
          <planeGeometry args={PLATE} />
          <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

const SR_ONLY = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

/** Keeps all four judges in frame on narrow/tall viewports by widening the vertical FOV. */
function FitCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    const hfov = THREE.MathUtils.degToRad(70);
    const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
    camera.fov = THREE.MathUtils.clamp(vfov, 42, 85);
    camera.updateProjectionMatrix();
  }, [camera, aspect]);
  return null;
}

export interface JudgesSceneProps {
  ref?: Ref<JudgesHandle>;
  /** One entry per seat, left to right; null leaves the seat empty. Default DEFAULT_JUDGES. */
  judges?: (JudgeConfig | null)[] | undefined;
  className?: string;
}

export function JudgesScene({ ref, judges = DEFAULT_JUDGES, className }: JudgesSceneProps) {
  const judgeRefs = useRef<(JudgeHandle | null)[]>([]);
  const findJudge = useCallback((seat: JudgeIndex, out: THREE.Vector3) => judgeRefs.current[seat]?.headPosition(out) ?? false, []);

  useImperativeHandle(ref, () => {
    /** While judge i talks, the others look at them. */
    const attendTo = (i: JudgeIndex) => {
      const releases = judgeRefs.current.flatMap((h, j) => (h && j !== i ? [h.attend(i)] : []));
      return () => releases.forEach((r) => r());
    };
    return {
      say: (i, text, ms) => {
        const h = judgeRefs.current[i];
        if (!h) return;
        h.say(text, ms);
        setTimeout(attendTo(i), ms ?? estimateSpeechMs(text));
      },
      speak: (i, text, level) => {
        const h = judgeRefs.current[i];
        if (!h) return () => {};
        const stop = h.speak(text, level);
        const release = attendTo(i);
        return () => {
          release();
          stop();
        };
      },
      react: (i, r) => judgeRefs.current[i]?.react(r),
      lookAt: (i, target) => judgeRefs.current[i]?.lookAt(target),
    };
  }, []);

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", background: "#e9eaeb" }}>
      <ul aria-label="Judges" style={SR_ONLY}>
        {judges.map((j, i) => (j?.title ? <li key={i}>{j.title}</li> : null))}
      </ul>
      <Canvas shadows camera={{ position: [0, 1.62, 3.6], fov: 42 }} onCreated={({ camera }) => camera.lookAt(0, 0.95, -0.4)}>
        <color attach="background" args={["#e9eaeb"]} />
        <fog attach="fog" args={["#e9eaeb", 9, 20]} />
        <hemisphereLight args={["#ffffff", "#b9bbc0", 1.3]} />
        <ambientLight intensity={0.25} />
        <directionalLight
          position={[1.8, 3.2, 3.2]}
          intensity={1.2}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-5}
          shadow-camera-right={5}
          shadow-camera-top={4}
          shadow-camera-bottom={-3}
          shadow-bias={-0.0005}
        />
        <FitCamera />
        <Room judges={judges} seats={DEFAULT_JUDGES} />
        {judges.map((j, i) => (j?.title ? <Nameplate key={i} x={j.position[0]} title={j.title} /> : null))}
        <Suspense fallback={null}>
          {judges.map((cfg, i) =>
            cfg ? (
              <Judge
                key={i}
                config={cfg}
                seat={i as JudgeIndex}
                findJudge={findJudge}
                ref={(h) => void (judgeRefs.current[i] = h)}
              />
            ) : null,
          )}
        </Suspense>
      </Canvas>
    </div>
  );
}
