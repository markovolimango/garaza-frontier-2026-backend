/**
 * Judge animation layering.
 *
 * Every clip is split into two layers:
 *   - upper: Spine and every bone below it in the hierarchy (chest, neck, head, arms, hands)
 *   - lower: everything else (Hips position/rotation, legs)
 *
 * SITTING clips drive both layers. STANDING clips drive only the upper layer,
 * while the lower layer stays on the judge's sitting idle, so a seated judge
 * never stands up or sinks through the chair.
 *
 * Classification measured from the FBX files (avg Hips Y in cm, avg knee bend):
 *   sitting clips: Hips Y 54–63, knees ~83–91°
 *   standing clips: Hips Y 94–96, knees ~13–26°
 */
import * as THREE from "three";

export type ClipName =
  | "sitting-idle"
  | "sitting-idle-2"
  | "talking"
  | "nod"
  | "shake"
  | "disapprove"
  | "clap"
  | "think"
  | "texting";

export type ClipPose = "SITTING" | "STANDING";

export const CLIP_POSE: Record<ClipName, ClipPose> = {
  "sitting-idle": "SITTING",
  "sitting-idle-2": "SITTING",
  talking: "SITTING",
  clap: "SITTING",
  disapprove: "SITTING",
  nod: "STANDING",
  shake: "STANDING",
  think: "STANDING",
  texting: "STANDING",
};

/** File under public/judges/animations/ for each clip (note the misspelled disapprove file). */
export const CLIP_FILES: Record<ClipName, string> = {
  "sitting-idle": "sitting-idle.fbx",
  "sitting-idle-2": "sitting-idle-2.fbx",
  talking: "talking.fbx",
  nod: "nod.fbx",
  shake: "shake.fbx",
  disapprove: "dissaprove.fbx",
  clap: "clap.fbx",
  think: "think.fbx",
  texting: "texting.fbx",
};

/** Clips that loop; the rest play once and return to idle. */
const LOOPING = new Set<ClipName>(["sitting-idle", "sitting-idle-2", "talking", "texting"]);

const PREFIX_RE = /^mixamorig\d*:?/;
const boneKey = (name: string) => name.replace(PREFIX_RE, "");

function findBone(root: THREE.Object3D, key: string) {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && (o as THREE.Bone).isBone && boneKey(o.name) === key) found = o;
  });
  return found;
}

/** Bone keys (prefix stripped) of Spine and all its descendants. */
export function upperBodyBones(root: THREE.Object3D): Set<string> {
  const set = new Set<string>();
  findBone(root, "Spine")?.traverse((o) => set.add(boneKey(o.name)));
  return set;
}

/** Renames tracks to the character's bone prefix and splits them into upper/lower clips. */
function splitClip(clip: THREE.AnimationClip, upper: Set<string>, prefix: string) {
  const up: THREE.KeyframeTrack[] = [];
  const low: THREE.KeyframeTrack[] = [];
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf(".");
    const key = boneKey(t.name.slice(0, dot));
    const track = t.clone();
    track.name = prefix + key + t.name.slice(dot);
    (upper.has(key) ? up : low).push(track);
  }
  return {
    upper: new THREE.AnimationClip(`${clip.name}:upper`, clip.duration, up),
    lower: new THREE.AnimationClip(`${clip.name}:lower`, clip.duration, low),
  };
}

type Layer = "upper" | "lower";

export class JudgeAnimator {
  readonly mixer: THREE.AnimationMixer;
  private actions: Record<Layer, Map<ClipName, THREE.AnimationAction>> = {
    upper: new Map(),
    lower: new Map(),
  };
  private current: Record<Layer, THREE.AnimationAction | null> = { upper: null, lower: null };

  constructor(
    root: THREE.Object3D,
    clips: Partial<Record<ClipName, THREE.AnimationClip>>,
    readonly idle: ClipName = "sitting-idle",
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    const hips = findBone(root, "Hips");
    const prefix = hips ? hips.name.slice(0, hips.name.length - "Hips".length) : "mixamorig";
    const upper = upperBodyBones(root);

    for (const [name, clip] of Object.entries(clips) as [ClipName, THREE.AnimationClip][]) {
      const parts = splitClip(clip, upper, prefix);
      this.actions.upper.set(name, this.mixer.clipAction(parts.upper));
      this.actions.lower.set(name, this.mixer.clipAction(parts.lower));
    }

    this.mixer.addEventListener("finished", (e) => {
      if (e.action === this.current.upper) this.play(this.idle);
    });

    this.play(idle, 0);
    // Desync judges sharing the same idle.
    for (const l of ["upper", "lower"] as Layer[]) {
      const a = this.current[l];
      if (a) a.time = Math.random() * a.getClip().duration;
    }
  }

  play(name: ClipName, fade = 0.35) {
    this.fadeTo("upper", name, fade);
    this.fadeTo("lower", CLIP_POSE[name] === "SITTING" ? name : this.idle, fade);
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }

  private fadeTo(layer: Layer, name: ClipName, fade: number) {
    const next = this.actions[layer].get(name);
    if (!next) return;
    const cur = this.current[layer];
    const loop = LOOPING.has(name);
    if (next === cur && loop) return;

    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.play();
    if (cur && cur !== next && fade > 0) cur.crossFadeTo(next, fade, false);
    else if (cur && cur !== next) cur.stop();
    this.current[layer] = next;
  }
}
