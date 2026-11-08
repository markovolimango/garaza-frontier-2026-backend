# TODO: judge voices

Status: `JudgeVoices` (`apps/brain/src/voices/judgeVoice.ts`) and `POST /debug/judge-say` are built and unit-tested,
and the director speaks the Q&A through them. Still to check against real ElevenLabs on a real stage.

## Done
- [x] `judge_4` is in the default scene: four judges, one per seat and voice (`defaultScene` in `apps/brain/src/brain.ts`).
- [x] Director (Q&A): calls `speakJudge` for the judges' questions, cut-ins on long answers and the closing line, and dispatches
  `qa_done` when the panel is done (`apps/brain/src/director/director.ts`).
- [x] The stage plays judge audio per source (1–4), reports `audio.playback` with the `utteranceId` from `actor.say`,
  and drives the talking judge from `actor.say` + its source level and reactions from `actor.gesture`
  (`apps/frontend/src/brain/{audio,judges}.ts`).

## Verify
- [ ] Run `JJ_FAKE=1 ELEVENLABS_API_KEY=… pnpm dev:brain`, then `curl -X POST localhost:8787/debug/judge-say -H 'content-type: application/json' -d '{"judge":2,"text":"…"}'`, and check that the voice plays on the stage.
- [ ] Check that each of the 4 default premade voices (Rachel, Adam, Antoni, Sarah) is available on our ElevenLabs account and sounds different. If not, set `JUDGE_VOICE_IDS`.
- [ ] Measure the time to first audio with `eleven_flash_v2_5`. If it's too slow, try `optimize_streaming_latency`.
- [ ] On a real stage, check that `idle` lines up with the end of the audio (the stage's `audio.playback` `ended`), not with the 1.5 s fallback after the audio length.

## Behaviour
- [ ] Add cancellation: `audio.stop` for the current judge utterance on wake / barge-in / run end, and clear the queue (`JudgeVoices.stop()`, which doesn't exist yet).
- [ ] Pace the audio to real time (or cap how far ahead it gets) if sending ElevenLabs' bursts straight through overflows the stage's buffer.
- [ ] Add a retry or a shorter error path on ElevenLabs 429 / 5xx.
- [ ] Use each judge's scene `voiceId` (`JudgeDef.voiceId`, from `JUDGE_VOICES`) once personas pick voices, instead of the index-based `JUDGE_VOICE_IDS` list.

## Integration
- [ ] If a session recorder (JSONL event log) is built, log judge utterances in it. Today the Q&A turns (question, answer) are in the run log (`apps/brain/src/runlog.ts`).
- [ ] Gate or remove `/debug/judge-say` before the demo (e.g. only when `LOG_LEVEL=debug` or `JUDGE_DEBUG=1`).
