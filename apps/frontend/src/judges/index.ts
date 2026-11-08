/**
 * JUDGES — public contract. Import only from "@/judges".
 *
 *   import { JudgesScene, type JudgesHandle } from "@/judges";
 *
 *   const judges = useRef<JudgesHandle>(null);
 *   <JudgesScene ref={judges} className="h-screen w-full" />
 *
 *   judges.current?.say(2, "What's your CAC?");          // judge 3 talks, glows, subtitle; duration from word count
 *   judges.current?.say(0, "Thanks.", 1200);              // explicit duration (ms)
 *   judges.current?.react(1, "nod");                      // nod | shake | disapprove | clap | think | texting | talking | idle | idle-alt
 *   const stop = judges.current?.speak(1, text, () => rms); // live-level speech; call stop() when audio ends
 *   judges.current?.lookAt(0, 2);                         // judge 1 turns to judge 3; also "presenter" | "notes" | "audience"
 *   <JudgesScene judges={seatedJudges([{ seat: 0, title: "VC investor" }, { seat: 2, title: "CTO" }])} />   // a panel by seat
 *
 * Gaze: each judge looks at its lookAt target (default the presenter, i.e. the camera) and turns
 * smoothly; while one judge talks the others look at them; now and then a judge glances at its
 * notes or a neighbour, with a slow drift, so the panel never freezes.
 *
 * Live voice (src/judges/live/): useJudgesLive(ref, mode, url) connects to the brain as role "stage"
 * (/ws/control + /ws/audio), plays judge audio at 24 kHz and drives say/gesture; falls back to
 * WebSpeechVoice when the brain is unreachable. URL: ?source=mock|backend&brain=ws://host:port.
 * AudioContext needs a user click: call enableAudio() from a button.
 *
 * - Judge indices are 0..3, left to right from the presenter's view.
 * - One-shot reactions return to idle by themselves; "texting" loops until another reaction or "idle".
 * - The scene fills its parent; give the parent a size. Render it client-side only (WebGL).
 * - Subtitles use z-index 0..10, so app overlays (e.g. the feedback vignette) must sit above 10.
 * - Assets: public/judges/character.fbx + public/judges/animations/*.fbx.
 * - Optional prop `judges` ((JudgeConfig | null)[], one per seat; null = empty seat) overrides
 *   positions/heights/tints/idles and adds nameplates (`title`); default DEFAULT_JUDGES.
 */
export { JudgesScene, DEFAULT_JUDGES, seatedJudges, type JudgesSceneProps } from "./JudgesScene";
export { JUDGE_REACTIONS, type JudgesHandle, type JudgeIndex, type JudgeReaction, type JudgeConfig, type JudgeGaze } from "./types";
export { useJudgesLive, readLiveParams, GESTURE_TO_REACTION, type LiveMode } from "./live/useJudgesLive";
