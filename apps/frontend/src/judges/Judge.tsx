import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CLIP_FILES, JudgeAnimator, type ClipName } from "./animator";
import { createSilhouetteMaterial } from "./silhouette";
import type { JudgeConfig, JudgeReaction } from "./types";

const BASE = `${import.meta.env.BASE_URL}judges/`;
export const CHARACTER_URL = `${BASE}character.fbx`;
const CLIP_NAMES = Object.keys(CLIP_FILES) as ClipName[];
export const CLIP_URLS = CLIP_NAMES.map((n) => `${BASE}animations/${CLIP_FILES[n]}`);

export interface JudgeHandle {
  say(text: string, durationMs?: number): void;
  /** Subtitle + talking while `level()` (0..1) drives glow and head bob; call the returned fn to stop. */
  speak(text: string, level: () => number): () => void;
  react(reaction: JudgeReaction): void;
}

const _p = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _qRoot = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _qFull = new THREE.Quaternion();
const _qHead = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();

/** Words-per-minute based estimate, used when say() gets no duration. */
export const estimateSpeechMs = (text: string) =>
  Math.max(1500, text.trim().split(/\s+/).filter(Boolean).length * 380 + 600);

export function Judge({ config, ref }: { config: JudgeConfig; ref?: Ref<JudgeHandle> }) {
  const source = useLoader(FBXLoader, CHARACTER_URL);
  const anims = useLoader(FBXLoader, CLIP_URLS);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const levelFn = useRef<(() => number) | null>(null);
  const level = useRef(0);
  const glowTarget = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { model, material, clips, head } = useMemo(() => {
    const model = cloneSkinned(source) as THREE.Group;
    const material = createSilhouetteMaterial(config.tint);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = material;
        m.frustumCulled = false;
      }
    });
    const clips: Partial<Record<ClipName, THREE.AnimationClip>> = {};
    CLIP_NAMES.forEach((n, i) => {
      const c = anims[i]?.animations[0];
      if (c) clips[n] = c;
    });
    let head: THREE.Object3D | undefined;
    model.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && /Head$/.test(o.name)) head = o;
    });
    return { model, material, clips, head };
  }, [source, anims, config.tint]);

  // Created in the effect (not useMemo) so StrictMode's mount/unmount/mount never leaves a disposed mixer.
  const animator = useRef<JudgeAnimator | null>(null);
  useEffect(() => {
    const a = new JudgeAnimator(model, clips, config.idle);
    animator.current = a;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      a.dispose();
      animator.current = null;
    };
  }, [model, clips, config.idle]);
  useEffect(() => () => material.dispose(), [material]);

  useImperativeHandle(
    ref,
    () => ({
      say(text, durationMs) {
        if (timer.current) clearTimeout(timer.current);
        setSubtitle(text);
        glowTarget.current = 1;
        animator.current?.play("talking");
        timer.current = setTimeout(() => {
          setSubtitle(null);
          glowTarget.current = 0;
          animator.current?.play(animator.current.idle);
        }, durationMs ?? estimateSpeechMs(text));
      },
      speak(text, level) {
        if (timer.current) clearTimeout(timer.current);
        setSubtitle(text);
        levelFn.current = level;
        animator.current?.play("talking");
        return () => {
          if (levelFn.current !== level) return; // superseded by a newer utterance
          levelFn.current = null;
          setSubtitle(null);
          animator.current?.play(animator.current.idle);
        };
      },
      react(reaction) {
        const a = animator.current;
        if (!a) return;
        if (reaction === "idle") a.play(a.idle);
        else if (reaction === "idle-alt") a.play(a.idle === "sitting-idle" ? "sitting-idle-2" : "sitting-idle");
        else a.play(reaction);
      },
    }),
    [],
  );

  useFrame(({ camera, clock }, dt) => {
    animator.current?.update(dt);

    // Live level (backend audio / speech fallback) drives glow and head bob; else timed say() pulse.
    const raw = levelFn.current ? levelFn.current() : 0;
    level.current = THREE.MathUtils.lerp(level.current, raw, Math.min(1, dt * (raw > level.current ? 18 : 6)));
    const u = material.uniforms["uSpeakGlow"]!;
    const target = levelFn.current
      ? 0.35 + 0.65 * level.current
      : glowTarget.current
        ? 0.75 + 0.25 * Math.sin(clock.elapsedTime * 9)
        : 0;
    u.value = THREE.MathUtils.lerp(u.value, target, Math.min(1, dt * 10));

    // Head looks at the camera, applied on top of the animated pose.
    if (head?.parent) {
      model.updateMatrixWorld(true);
      head.getWorldPosition(_p);
      camera.getWorldPosition(_cam);
      model.getWorldQuaternion(_qRoot);
      _fwd.set(0, 0, 1).applyQuaternion(_qRoot);
      _qFull.setFromUnitVectors(_fwd, _cam.sub(_p).normalize());
      _qDelta.slerpQuaternions(IDENTITY, _qFull, 0.8);
      head.getWorldQuaternion(_qHead);
      head.parent.getWorldQuaternion(_qParent);
      head.quaternion.copy(_qParent.invert().multiply(_qDelta.multiply(_qHead)));
      if (level.current > 0.01) head.rotateX(-level.current * 0.16);
    }
  });

  return (
    <group position={config.position}>
      <primitive object={model} scale={0.01 * config.height} />
      {subtitle && (
        <Html position={[0, 0.62, 1.15]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div
            style={{
              width: "max-content",
              maxWidth: 260,
              padding: "8px 12px",
              borderRadius: 10,
              background: "rgba(8,10,16,0.82)",
              border: "1px solid rgba(159,196,255,0.35)",
              color: "#eef3ff",
              font: "500 14px/1.35 system-ui, sans-serif",
              textAlign: "center",
            }}
          >
            {subtitle}
          </div>
        </Html>
      )}
    </group>
  );
}
