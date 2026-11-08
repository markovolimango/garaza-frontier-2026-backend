import { expect, it, vi } from "vitest";

const { preload } = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock("@react-three/fiber", () => ({ useLoader: { preload } }));
vi.mock("@/judges/Judge", () => ({
  CHARACTER_URL: "/judges/character.fbx",
  CLIP_URLS: ["/judges/animations/sitting-idle.fbx", "/judges/animations/talking.fbx"],
}));

import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { CHARACTER_URL, CLIP_URLS } from "@/judges/Judge";
import { preloadJudges } from "@/lib/preloadJudges";

it("preloads the character and animation array into the same loader cache used by judges", () => {
  preloadJudges();
  expect(preload).toHaveBeenCalledTimes(2);
  expect(preload).toHaveBeenNthCalledWith(1, FBXLoader, CHARACTER_URL);
  expect(preload).toHaveBeenNthCalledWith(2, FBXLoader, CLIP_URLS);
});