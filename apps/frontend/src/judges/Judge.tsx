import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CLIP_FILES, JudgeAnimator, type ClipName } from "./animator";
import { createSilhouetteMaterial } from "./silhouette";
import type { JudgeConfig, JudgeGaze, JudgeIndex, JudgeReaction } from "./types";

const BASE = `${import.meta.env.BASE_URL}judges/`;
export const CHARACTER_URL = `${BASE}character.fbx`;
const CLIP_NAMES = Object.keys(CLIP_FILES) as ClipName[];
export const CLIP_URLS = CLIP_NAMES.map((n) => `${BASE}animations/${CLIP_FILES[n]}`);

export interface JudgeHandle {
  say(text: string, durationMs?: number): void;
  /** Subtitle + talking while `level()` (0..1) drives glow and head bob; call the returned fn to stop. */
  speak(text: string, level: () => number): () => void;
  react(reaction: JudgeReaction): void;
  /** Where the judge looks from now on (smooth turn). */
  lookAt(target: JudgeGaze): void;
  /** Someone else is talking: look at them until the returned release() (a later lookAt wins). */
  attend(target: JudgeGaze): () => void;
  /** World position of the head; false before the model is ready. */
  headPosition(out: THREE.Vector3): boolean;
}

const _p = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _qRoot = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _qFull = new THREE.Quaternion();
const _qHead = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qSpine = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Gaze tuning: head turn speed (1/s), share of the turn the head takes, share of the yaw the chest takes. */
const TURN_RATE = 4.5;
const HEAD_WEIGHT = 0.8;
const SPINE_YAW = 0.22;
/** Notes on the table in front of the judge (relative to the root), and the audience behind the presenter. */
const NOTES: [number, number, number] = [0, 0.77, 0.5];
const AUDIENCE: [number, number, number] = [0, 1.2, 8];

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Gaze {
  /** Commanded target (lookAt), default the presenter. */
  base: JudgeGaze;
  /** Another judge is talking (scene-driven). */
  attention: { target: JudgeGaze; token: number } | null;
  /** Idle variation: a short look at the notes, a neighbour or the presenter. */
  glance: JudgeGaze | null;
  glanceUntil: number;
  nextGlance: number;
  /** Smoothed world look direction; null until the first frame. */
  dir: THREE.Vector3 | null;
  drift: number;
  texting: boolean;
}

/** Words-per-minute based estimate, used when say() gets no duration. */
export const estimateSpeechMs = (text: string) =>
  Math.max(1500, text.trim().split(/\s+/).filter(Boolean).length * 380 + 600);

export interface JudgeProps {
  config: JudgeConfig;
  ref?: Ref<JudgeHandle>;
  /** This judge's seat (for glances at neighbours). */
  seat?: JudgeIndex;
  /** Head position of the judge in another seat; false when that seat is empty. */
  findJudge?: (seat: JudgeIndex, out: THREE.Vector3) => boolean;
}

export function Judge({ config, ref, seat, findJudge }: JudgeProps) {
  const source = useLoader(FBXLoader, CHARACTER_URL);
  const anims = useLoader(FBXLoader, CLIP_URLS);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const levelFn = useRef<(() => number) | null>(null);
  const level = useRef(0);
  const glowTarget = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gaze = useRef<Gaze>({
    base: "presenter", attention: null, glance: null, glanceUntil: 0, nextGlance: rand(3, 11), dir: null, drift: rand(0, Math.PI * 2), texting: false,
  });
  const attentionSeq = useRef(0);

  const { model, material, clips, head, spine } = useMemo(() => {
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
    let spine: THREE.Object3D | undefined;
    model.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      if (!head && /Head$/.test(o.name)) head = o;
      if (!spine && /Spine1$/.test(o.name)) spine = o;
    });
    return { model, material, clips, head, spine };
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
        gaze.current.texting = reaction === "texting";
        if (!a) return;
        if (reaction === "idle") a.play(a.idle);
        else if (reaction === "idle-alt") a.play(a.idle === "sitting-idle" ? "sitting-idle-2" : "sitting-idle");
        else a.play(reaction);
      },
      lookAt(target) {
        const g = gaze.current;
        g.base = target;
        g.attention = null;
        g.glance = null;
      },
      attend(target) {
        const token = ++attentionSeq.current;
        gaze.current.attention = { target, token };
        gaze.current.glance = null;
        return () => {
          if (gaze.current.attention?.token === token) gaze.current.attention = null;
        };
      },
      headPosition(out) {
        if (!head) return false;
        head.getWorldPosition(out);
        return true;
      },
    }),
    [head],
  );

  /** World point for a gaze target; another judge's head, the table, the audience, or the camera. */
  const resolve = (target: JudgeGaze, out: THREE.Vector3) => {
    if (typeof target === "number") {
      if (target !== seat && findJudge?.(target, out)) return;
      out.copy(_cam);
    } else if (target === "notes") out.set(config.position[0] + NOTES[0], NOTES[1], config.position[2] + NOTES[2]);
    else if (target === "audience") out.set(AUDIENCE[0] + config.position[0] * 0.5, AUDIENCE[1], AUDIENCE[2]);
    else out.copy(_cam);
  };

  /** Idle variation: mostly the notes, sometimes a neighbour; back to the presenter when the judge is busy elsewhere. */
  const pickGlance = (base: JudgeGaze): [JudgeGaze, number] => {
    if (base !== "presenter" && base !== "audience") return ["presenter", rand(0.9, 1.8)];
    const near = seat === undefined ? [] : [seat - 1, seat + 1].filter((s): s is JudgeIndex => s >= 0 && s <= 3 && !!findJudge?.(s as JudgeIndex, _target));
    if (near.length && Math.random() < 0.4) return [near[Math.floor(Math.random() * near.length)]!, rand(0.8, 1.6)];
    return ["notes", rand(1.2, 2.6)];
  };

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

    // Head (and a little of the chest) turns toward the gaze target, on top of the animated pose.
    if (head?.parent) {
      model.updateMatrixWorld(true);
      head.getWorldPosition(_p);
      camera.getWorldPosition(_cam);
      model.getWorldQuaternion(_qRoot);
      _fwd.set(0, 0, 1).applyQuaternion(_qRoot);

      const g = gaze.current;
      const t = clock.elapsedTime;
      const talking = !!levelFn.current || glowTarget.current > 0;
      const busy = talking || !!g.attention || g.texting;
      if (g.glance !== null && (t >= g.glanceUntil || busy)) g.glance = null;
      if (t >= g.nextGlance) {
        if (busy) g.nextGlance = t + rand(3, 7);
        else {
          const [glance, secs] = pickGlance(g.base);
          g.glance = glance;
          g.glanceUntil = t + secs;
          g.nextGlance = t + secs + rand(6, 14);
        }
      }
      resolve(g.texting ? "notes" : talking ? g.base : (g.glance ?? g.attention?.target ?? g.base), _target);
      const dist = _target.distanceTo(_p);
      _target.x += Math.sin(t * 0.37 + g.drift) * 0.03 * dist; // slow drift so the panel never freezes
      _target.y += Math.sin(t * 0.23 + g.drift * 1.7) * 0.018 * dist;
      _dir.subVectors(_target, _p).normalize();
      if (!g.dir) g.dir = _dir.clone();
      else g.dir.lerp(_dir, 1 - Math.exp(-dt * TURN_RATE)).normalize();

      _qFull.setFromUnitVectors(_fwd, g.dir);
      _qDelta.slerpQuaternions(IDENTITY, _qFull, HEAD_WEIGHT);
      head.getWorldQuaternion(_qHead);
      if (spine?.parent) {
        let yaw = Math.atan2(g.dir.x, g.dir.z) - Math.atan2(_fwd.x, _fwd.z);
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        _qTwist.setFromAxisAngle(UP, yaw * HEAD_WEIGHT * SPINE_YAW);
        spine.getWorldQuaternion(_qSpine);
        spine.parent.getWorldQuaternion(_qParent);
        spine.quaternion.copy(_qParent.invert().multiply(_qTwist.multiply(_qSpine)));
      }
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
