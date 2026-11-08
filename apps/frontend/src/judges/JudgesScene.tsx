import { Suspense, useImperativeHandle, useRef, type Ref } from "react";
import { Canvas } from "@react-three/fiber";
import { Judge, type JudgeHandle } from "./Judge";
import type { JudgeConfig, JudgesHandle } from "./types";

const SEAT_Z = -0.75;

export const DEFAULT_JUDGES: JudgeConfig[] = [
  { position: [-1.65, 0, SEAT_Z], height: 0.97, tint: "#1b1f2a", idle: "sitting-idle" },
  { position: [-0.55, 0, SEAT_Z], height: 1.05, tint: "#22252b", idle: "sitting-idle-2" },
  { position: [0.55, 0, SEAT_Z], height: 0.94, tint: "#1d2620", idle: "sitting-idle" },
  { position: [1.65, 0, SEAT_Z], height: 1.01, tint: "#2a1f22", idle: "sitting-idle-2" },
];

const MATTE = { roughness: 0.95, metalness: 0 };

function Room({ judges }: { judges: JudgeConfig[] }) {
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
      {/* chairs */}
      {judges.map((j, i) => (
        <group key={i} position={[j.position[0], 0, j.position[2] - 0.1]}>
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
      ))}
    </group>
  );
}

export interface JudgesSceneProps {
  ref?: Ref<JudgesHandle>;
  judges?: JudgeConfig[];
  className?: string;
}

export function JudgesScene({ ref, judges = DEFAULT_JUDGES, className }: JudgesSceneProps) {
  const judgeRefs = useRef<(JudgeHandle | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      say: (i, text, ms) => judgeRefs.current[i]?.say(text, ms),
      speak: (i, text, level) => judgeRefs.current[i]?.speak(text, level) ?? (() => {}),
      react: (i, r) => judgeRefs.current[i]?.react(r),
    }),
    [],
  );

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", background: "#07080b" }}>
      <Canvas camera={{ position: [0, 1.62, 3.6], fov: 42 }} onCreated={({ camera }) => camera.lookAt(0, 0.95, -0.4)}>
        <color attach="background" args={["#07080b"]} />
        <fog attach="fog" args={["#07080b", 5, 11]} />
        <ambientLight intensity={0.6} />
        <spotLight position={[0, 4, 2]} angle={0.7} penumbra={0.8} intensity={45} />
        <Room judges={judges} />
        <Suspense fallback={null}>
          {judges.map((cfg, i) => (
            <Judge key={i} config={cfg} ref={(h) => void (judgeRefs.current[i] = h)} />
          ))}
        </Suspense>
      </Canvas>
    </div>
  );
}
