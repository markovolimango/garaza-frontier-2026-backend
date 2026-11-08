# TODO: judges (src/judges, public/judges)

## Blocking / sync
- [ ] **bun.lock is stale.** `three`, `@types/three`, `@react-three/fiber`, `@react-three/drei` were added to package.json by hand (no bun locally). Ask Lovable to reinstall/regenerate the lockfile.
- [ ] **CLAUDE.md not written yet** (step 1: product loop, folder map, signal channels, ownership, sync rules).

## Integration
- [ ] Test against the **real brain** once the judge director lands (`hub.sendAudio(judgeSource(n))` + `actor.say` for `judge_N`). Only verified against a protocol-faithful fake so far.
- [ ] Decide whether the brain connection moves onto the **signals bus** (`src/signals/index.ts`, Lovable-owned). It currently lives in `src/judges/live/` to respect ownership.
- [ ] Put `<JudgesScene>` + `useJudgesLive` on the real `/judges` route (Lovable), with the vignette above z-index 10.
- [ ] `scene.apply` is acked `ok: true` without applying ops; revisit if the judges view should honour scene ops.
- [ ] `actor.lookAt` is not handled (heads always look at the camera).
- [ ] `judge_5` and JJ (`source 0`) audio are ignored by the judges view.

## Polish
- [ ] First load takes about 10 s (character + 9 animation FBX files). Show a loader, or convert to compressed GLB.
- [ ] Rim shading still hints at facial features; raise `uRimPower` or flatten normals on the head for a pure silhouette.
- [ ] Rename `public/judges/animations/dissaprove.fbx` → `disapprove.fbx` (and update `CLIP_FILES`).
- [ ] Tune subtitle placement and seat/hip offsets per judge if clips drift.
- [ ] Q/W/E/R shortcuts untested in a real browser (the browser-pane key events didn't reach the page).
