import { Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { Judge, estimateSpeechMs, type JudgeHandle } from "./Judge";
import type { JudgeConfig, JudgeIndex, JudgesHandle } from "./types";

const SEAT_Z = -0.75;

export const DEFAULT_JUDGES: JudgeConfig[] = [
  { position: [-1.65, 0, SEAT_Z], height: 0.97, tint: "#1b1f2a", idle: "sitting-idle" },
  { position: [-0.55, 0, SEAT_Z], height: 1.05, tint: "#22252b", idle: "sitting-idle-2" },
  { position: [0.55, 0, SEAT_Z], height: 0.94, tint: "#1d2620", idle: "sitting-idle" },
  { position: [1.65, 0, SEAT_Z], height: 1.01, tint: "#2a1f22", idle: "sitting-idle-2" },
];

/** A panel by seat (0..3, left to right): those seats get DEFAULT_JUDGES' look plus a nameplate; the others stay empty. */
export function seatedJudges(seats: readonly { seat: JudgeIndex; title?: string }[]): (JudgeConfig | null)[] {
  return DEFAULT_JUDGES.map((cfg, i) => {
    const s = seats.find((x) => x.seat === i);
    return s ? { ...cfg, ...(s.title ? { title: s.title } : {}) } : null;
  });
}

const MATTE = { roughness: 0.95, metalness: 0 };
const TABLE_TOP = 0.765;

function Chair({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z - 0.1]}>
      <mesh position={[0, 0.45, 0]}>
        <boxGeometry args={[0.5, 0.06, 0.5]} />
        <meshStandardMaterial color="#22252d" {...MATTE} />
      </mesh>
      <mesh position={[0, 0.85, -0.24]}>
        <boxGeometry args={[0.5, 0.8, 0.05]} />
        <meshStandardMaterial color="#22252d" {...MATTE} />
      </mesh>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.44]} />
        <meshStandardMaterial color="#0a0a0d" {...MATTE} />
      </mesh>
    </group>
  );
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
  g.fillStyle = "#0d0f15";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = "rgba(159,196,255,0.28)";
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
  g.fillStyle = "#dce6ff";
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
        <meshStandardMaterial color="#0d0f15" roughness={0.5} />
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

function Room({ judges }: { judges: (JudgeConfig | null)[] }) {
  return (
    <group>
      {/* floor */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#14161c" {...MATTE} />
      </mesh>
      {/* back wall */}
      <mesh position={[0, 2.5, -2.4]}>
        <planeGeometry args={[20, 5]} />
        <meshStandardMaterial color="#1b1e27" {...MATTE} />
      </mesh>
      {/* table: top + front modesty panel */}
      <mesh position={[0, 0.74, 0]} castShadow>
        <boxGeometry args={[4.6, 0.05, 0.9]} />
        <meshStandardMaterial color="#2b2e37" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.37, 0.42]}>
        <boxGeometry args={[4.6, 0.72, 0.03]} />
        <meshStandardMaterial color="#20232b" {...MATTE} />
      </mesh>
      {/* chairs (empty seats keep theirs) and nameplates */}
      {judges.map((j, i) => {
        const pos = (j ?? DEFAULT_JUDGES[i])?.position;
        return pos ? <Chair key={i} x={pos[0]} z={pos[2]} /> : null;
      })}
      {judges.map((j, i) => (j?.title ? <Nameplate key={i} x={j.position[0]} title={j.title} /> : null))}
    </group>
  );
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
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", background: "#07080b" }}>
      <ul aria-label="Judges" style={SR_ONLY}>
        {judges.map((j, i) => (j?.title ? <li key={i}>{j.title}</li> : null))}
      </ul>
      <Canvas camera={{ position: [0, 1.62, 3.6], fov: 42 }} onCreated={({ camera }) => camera.lookAt(0, 0.95, -0.4)}>
        <color attach="background" args={["#07080b"]} />
        <fog attach="fog" args={["#07080b", 5, 11]} />
        <ambientLight intensity={0.6} />
        <spotLight position={[0, 4, 2]} angle={0.7} penumbra={0.8} intensity={45} />
        <Room judges={judges} />
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
