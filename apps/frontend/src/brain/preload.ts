/**
 * Judges preload (Brain integration layer).
 *
 * The judges' models are 61 MB of FBX (character.fbx alone is 54 MB), fetched and parsed only
 * when the judges screen mounts, so the room stood empty for seconds after the slides. Once the
 * deck is in, this loads the screen's code and warms react-three-fiber's loader cache with the
 * same keys Judge.tsx uses (`useLoader(FBXLoader, CHARACTER_URL)`, `useLoader(FBXLoader,
 * CLIP_URLS)`), so the scene renders at once.
 */
let started = false;

export function preloadJudges(delayMs = 1000): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Parsing the character blocks the main thread briefly: let the JJ screen render first.
  setTimeout(() => {
    void Promise.all([
      import("@react-three/fiber"),
      import("three/examples/jsm/loaders/FBXLoader.js"),
      import("../judges/Judge"),
      import("../components/JudgesStage"),   // the /judges route's lazy chunk
    ]).then(([{ useLoader }, { FBXLoader }, { CHARACTER_URL, CLIP_URLS }]) => {
      useLoader.preload(FBXLoader, CHARACTER_URL);
      useLoader.preload(FBXLoader, CLIP_URLS);
    }).catch((err: unknown) => console.warn("judges preload failed", err));
  }, delayMs);
}
