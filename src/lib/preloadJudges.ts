import { useLoader } from "@react-three/fiber";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { CHARACTER_URL, CLIP_URLS } from "@/judges/Judge";

/** Warm the exact parsed-model cache used by the teammate's scene. No canvas or audio starts here. */
export function preloadJudges() {
  useLoader.preload(FBXLoader, CHARACTER_URL);
  useLoader.preload(FBXLoader, CLIP_URLS);
}