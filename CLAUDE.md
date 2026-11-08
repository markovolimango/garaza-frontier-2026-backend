# CLAUDE.md

Also read `AGENTS.md` (Lovable rules: no history rewrites, keep `main` working, don't touch Lovable-managed pieces).

**I'm low on usage: be concise, keep plans short, read as few files as possible.**

## Product
Pitch-practice app for Garaža Frontier (Belgrade, 40 h hackathon, judged on startup potential).
Loop: **JJ** (AI coach, glowing orb, voice) → **PRESENTER** (PDF slides + timer) → **JUDGES** (4 AI judges ask questions) → **REPORT** (dashboard) → JJ.
During PRESENTER and JUDGES a red/green edge vignette gives live feedback.
The backend ("brain", ws://127.0.0.1:8787) lives in `../backend` (teammates' repo, **read-only** for us).

## Stack
Lovable app: Vite + React 19 + TypeScript (strict, `noUncheckedIndexedAccess`) + Tailwind, TanStack Start/Router (file routes; `src/routeTree.gen.ts` is generated). Package manager is **bun** (`bun.lock`); don't commit `package-lock.json`.
3D: three + @react-three/fiber v9 + @react-three/drei v10.

## Folder map
- `src/routes/`: `index` (JJ), `presenter`, `judges`, `report`, `judges-demo`, `__root` (renders the Vignette)
- `src/components/`: `Orb`, `Vignette`, `DebugPanel`, `NextButton`, `presenter/`, `ui/` (shadcn)
- `src/signals/`: typed bus. Components subscribe; sources are swapped only in `src/signals/index.ts` (`MockSource`, `WebSocketSource`)
- `src/lib/`: `pdf.ts`, `pptxTimings.ts`, utils, error reporting
- `src/judges/`: **ours.** 3D judges scene; `index.ts` is the public contract (API documented at the top)
  - `animator.ts` (sitting/standing clip layering), `Judge.tsx`, `JudgesScene.tsx`, `silhouette.ts`, `JudgesDemo.tsx`
  - `live/`: brain client (`BackendSource`), 24 kHz PCM `AudioPlayer`, `WebSpeechVoice` fallback, `useJudgesLive`
- `public/judges/`: **ours.** `character.fbx` + `animations/*.fbx` (Mixamo, bone prefix `mixamorig9`)

## Signal bus channels (`src/signals/bus.ts`)
`orbLevel: number` · `feedback: { color: "red"|"green"|"neutral", intensity: 0..1 }` · `slide: number` · `jjMood: number` (0 red to 1 green) · `jjMoodSampled: number` · `jjReload: number`.
API: `publish`, `subscribe` (returns unsubscribe), `getLast`; React: `useSignal`, `useJjMood`.

## Ownership
Only touch:
- `src/judges/**` and `public/judges/**`
- `package.json`: **adding deps only**
- the `/judges-demo` route (`src/routes/judges-demo.tsx`, a thin wrapper; commit the regenerated `routeTree.gen.ts` with it)
- `CLAUDE.md` and `TODO.md`

Everything else belongs to Lovable: ask the user to change it in Lovable.

## Sync
- `git pull --rebase` before starting work and before every push.
- Commit + push to `main` after each working step (typecheck first: `npx tsc --noEmit -p tsconfig.json`).
- **Never push while the user says Lovable is generating.**
- Never force-push or rewrite pushed history.

## Open work
See `TODO.md`.
