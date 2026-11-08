import { Suspense, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Judge, type JudgeHandle } from "./Judge";
import { Room } from "./Room";
import type { JudgeConfig, JudgesHandle } from "./types";

const SEAT_Z = -0.75;

export const DEFAULT_JUDGES: JudgeConfig[] = [
  { position: [-1.65, 0, SEAT_Z], height: 0.97, tint: "#2d6cdf", idle: "sitting-idle" },
  { position: [-0.55, 0, SEAT_Z], height: 1.05, tint: "#d9488f", idle: "sitting-idle-2" },
  { position: [0.55, 0, SEAT_Z], height: 0.94, tint: "#2fb68a", idle: "sitting-idle" },
  { position: [1.65, 0, SEAT_Z], height: 1.01, tint: "#e3923a", idle: "sitting-idle-2" },
];

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
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", background: "#e9eaeb" }}>
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
